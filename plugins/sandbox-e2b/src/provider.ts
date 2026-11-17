import { randomUUID } from "node:crypto";
import {
  type ExecResult,
  FileSystemGoneError,
  type Logger,
  SANDBOX_TAG_RE,
  SandboxGoneError,
  type SandboxHandle,
  type SandboxLimits,
  type SandboxProvider,
  validateAllowHost,
  validateSandboxPathShape,
} from "@capybara-hq/plugin-sdk";
import {
  ALL_TRAFFIC,
  abortReason,
  createE2BApi,
  E2BHttpError,
  ENVD_PORT,
  type EnvdTarget,
  envdCloseStdin,
  envdKill,
  envdSendInput,
  envdStart,
  envdUpload,
  IPV6_DENIED,
  isE2BNotFound,
  isStatus,
  type NetworkUpdate,
  OPEN_PUBLIC_DENIED,
  type StartRequest,
  updateNetwork,
} from "./e2b-api.js";
import {
  checkListPath,
  finishList,
  finishScan,
  LIST_MAX_OUTPUT_BYTES,
  LIST_PATH,
  LIST_SCRIPT,
  LIST_TIMEOUT_SECONDS,
  listLimit,
} from "./listing.js";
import {
  type AgentRunOpts,
  createOperations,
  type OperationTransport,
  refusedFrame,
} from "./operations.js";
import {
  OPERATION_AGENT,
  OPERATION_AGENT_SHA256,
  RUNTIME_DIR,
  runtimeChecksums,
  runtimeFiles,
} from "./runtime-source.js";

/** 部署配置（见 index.ts 的 DeploymentConfig）。 */
export interface E2BSandboxConfig {
  apiKey: string;
  /** 控制面 API 地址；不填为 `https://api.<domain>`。 */
  apiUrl?: string | undefined;
  /** 沙箱域名（API 返回了沙箱自己的域名时以返回的为准）。 */
  domain: string;
  /**
   * Template name or id. Unset: the template `templateAlias(defaultImage)`, built on first use
   * from {@link E2BSandboxConfig.defaultImage}.
   */
  template?: string | undefined;
  /**
   * The image the template is built from when `template` is unset: the plugin setup passes
   * {@link publishedImage} of the plugin's own version.
   */
  defaultImage: string;
  /** 沙箱超时（秒）：到点 E2B 自动暂停。 */
  timeoutSeconds: number;
  /** E2B 支持按域名的出站白名单；false 时 allowlist 退化为 none 并打告警。 */
  domainAllowlist: boolean;
}

/**
 * **仅测试**的选项：只有直接调用 {@link createE2BSandbox} 的代码能传，插件的部署配置设不了（index.ts 的
 * 部署配置 schema 是 strict）。
 */
export interface E2BSandboxTestOptions {
  /** envd 地址改为这个（假 E2B 按 `E2b-Sandbox-Id` 请求头路由），不按沙箱 id 与域名拼。 */
  envdUrl?: string;
  /**
   * The PATH `list` / `scan` run with instead of the system directories (the fake E2B runs
   * commands on the test machine, where python3 and timeout may live elsewhere).
   */
  listPath?: string;
  /** Drops a background start's acknowledgement as if the transport lost it (live tests). */
  loseBackgroundAck?: (taskId: string) => boolean;
  /** Replaces the real `bg-start` command of a background start (live tests). */
  backgroundStartCommand?: (taskId: string, cmd: string[]) => string[];
}

/**
 * The metadata key carrying the name (`createFileSystem`'s `cap-device-<deviceId>`, or a
 * sandbox@1 sandbox's `cap-<conversationId>`); sandboxes are listed and cleaned up by it.
 */
export const METADATA_NAME = "capybara-sandbox-name";

/**
 * The sandbox image published with `version`: the images are tagged with sandbox-docker's version
 * (environments spec §5.4), and sandbox-docker and sandbox-e2b are one changesets `fixed` group,
 * so this plugin's own version is that tag.
 */
export function publishedImage(version: string): string {
  return `ghcr.io/capybara-hq/capybara-sandbox:${version}`;
}

/**
 * The alias of the template built from `image`: `capybara-sandbox-<tag>` with each character
 * outside `[a-z0-9-]` replaced by `-` (`0.1.0-rc.3` → `capybara-sandbox-0-1-0-rc-3`), so a new tag
 * builds a new template.
 */
export function templateAlias(image: string): string {
  const name = image.slice(image.lastIndexOf("/") + 1);
  const colon = name.lastIndexOf(":");
  const tag = colon >= 0 ? name.slice(colon + 1) : "latest";
  return `capybara-sandbox-${tag.toLowerCase().replace(/[^a-z0-9-]/g, "-")}`;
}

/** CPU and memory of the built template (E2B fixes them per template): the kernel's defaults. */
const TEMPLATE_CPU_COUNT = 1;
const TEMPLATE_MEMORY_MB = 2048;
/** How often a template build's status is polled, and how long a build may take (ms). */
const TEMPLATE_POLL_MS = 1000;
const TEMPLATE_BUILD_TIMEOUT_MS = 30 * 60_000;

/** 沙箱用户（镜像里的 sandbox，uid 1000）。 */
const SANDBOX_USER = "sandbox";
const ROOT_USER = "root";
/** root 专用的中转目录（镜像里 /opt/capybara 归 root、0700，沙箱用户进不去）。 */
const UPLOAD_DIR = "/opt/capybara/upload";
/** E2B 沙箱最长超时（秒）：Pro 套餐连续运行上限 24 小时。 */
const MAX_TIMEOUT_SECONDS = 86_400;
/** 长命令：沙箱超时至少推到命令超时之后这么多秒。 */
const TIMEOUT_MARGIN_SECONDS = 120;
/** 中止 / 超时杀掉命令后，最多再等输出流结束这么久（毫秒），之后直接断开。 */
const KILL_GRACE_MS = 3000;
/** 读文件时额外留给 stderr 的字节。 */
const STDERR_ROOM = 64 * 1024;
/** 文件操作脚本的超时（毫秒）。 */
const FILE_OP_TIMEOUT_MS = 120_000;
/** Retries of a connect answered 409 (another caller's resume in flight) and the wait between. */
const CONNECT_CONFLICT_RETRIES = 5;
const CONNECT_CONFLICT_WAIT_MS = 500;
/** 列出同名沙箱时每页条数。 */
const LIST_LIMIT = 100;

const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,100}$/;
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** 小写主机名（部署配置的 domain 与 API 返回的沙箱 domain 都按它校验）。 */
export const HOSTNAME_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
/** E2B 沙箱 id（拼进 envd 主机名与 API 路径前先校验）。 */
const SANDBOX_ID_RE = /^[a-zA-Z0-9-]{1,128}$/;
/** E2B template and build ids (checked before they go into an API path). */
const TEMPLATE_ID_RE = /^[a-zA-Z0-9_-]{1,128}$/;

/**
 * 沙箱里的硬时限比 `timeoutMs` 多出的秒数：正常情况下插件这边先按 `timeoutMs` 杀掉命令；内核副本崩溃
 * （插件这边的计时随之消失；断开 envd 的流不结束进程，暂停再恢复也保留内存里的进程）时由沙箱里的 `timeout` 兜底。
 */
export const IN_SANDBOX_GRACE_SECONDS = 5;

/**
 * 命令包装：在新会话里跑（setsid），先把会话 id 写到 `<ctl>.pid`，再看有没有 `<ctl>.kill`（杀的请求先到）；
 * 中止时按会话杀掉命令派生的全部进程。命令经 `timeout -s KILL` 运行：到沙箱里的时限即杀掉它所在的进程组。
 * After a timeout (124 or 137) the wrapper also kills what is left of its session: uutils `timeout`
 * (Ubuntu 26.04's default coreutils) kills only its child, not the child's process group (#7).
 * `$0` 是标记、`$1` 是 ctl、`$2` 是命令、`$3` 是沙箱里的时限（秒）。与 sandbox-docker 相同。
 */
/**
 * The environment variable every exec command carries (value: its control file path). A process
 * that leaves the command's session (`setsid`, a daemon) keeps it, so the kill scripts find such a
 * process by its environment in `/proc` (#escaped). Real envd ends a command's output stream when
 * the command itself exits, even while an escaped child still holds the output, so the stream
 * cannot tell us a kill missed something. Only a process that clears its own environment escapes
 * this as well.
 */
export const EXEC_MARKER = "CAPYBARA_EXEC";

/**
 * Shell function `m F|E <pattern>`: the pids (other than this shell) whose environment has an
 * entry matching the pattern as a whole line (`grep -F` / `grep -E`). Prints nothing without
 * `/proc` (only on test machines).
 */
const MARKED =
  'm() { for p in $(cd /proc 2>/dev/null && echo [0-9]*); do [ "$p" = "$$" ] && continue; ' +
  'tr "\\0" "\\n" < "/proc/$p/environ" 2>/dev/null | grep -q"x$1" -- "$2" && echo "$p"; done; }; ';

/**
 * Shell function `km F|E <pattern>`: SIGKILLs the marked processes, rescanning for children forked
 * meanwhile; exits the script with 1 when some are still there (the caller then reboots).
 */
const KILL_MARKED =
  `${MARKED}km() { for _ in 1 2 3; do l=$(m "$1" "$2"); [ -z "$l" ] && return 0; ` +
  'for p in $l; do kill -9 "$p" 2>/dev/null; done; sleep 0.05; done; ' +
  '[ -z "$(m "$1" "$2")" ] || exit 1; }; ';

const EXEC_WRAPPER =
  'c=$1; echo $$ > "$c.pid" 2>/dev/null; if [ -e "$c.kill" ]; then exit 137; fi; ' +
  'timeout -s KILL "$3" /bin/bash -c "$2"; s=$?; ' +
  "if [ $s -eq 124 ] || [ $s -eq 137 ]; then " +
  'for p in $(pgrep -s $$); do [ "$p" = $$ ] || kill -9 "$p" 2>/dev/null; done; ' +
  // a fresh shell without the marker: /proc/<pid>/environ of this shell and of its forks keeps
  // the marker even after unset, so the scan would find (and kill) itself
  `env -u ${EXEC_MARKER} /bin/sh -c '${KILL_MARKED}km F "$0"' "${EXEC_MARKER}=$c"; fi; ` +
  'rm -f "$c.pid"; exit $s';

/** `exec` 交给 envd 的 `setsid` 参数（导出供测试直接经 envd 启动，模拟「内核崩溃后无人看管」）。 */
export function execArgs(ctl: string, command: string, timeoutMs: number): string[] {
  const seconds = Math.ceil(timeoutMs / 1000) + IN_SANDBOX_GRACE_SECONDS;
  return ["-w", "/bin/sh", "-c", EXEC_WRAPPER, "capybara-exec", ctl, command, String(seconds)];
}

/**
 * 杀进程用的 shell 函数 `k <会话首进程>`：先按进程组杀它的直接子进程（`timeout` 自成一个进程组），再杀它自己的
 * 进程组与会话（没有 `pkill -s` 的系统上——只在测试机上——靠前两步）。
 */
const KILL_TREE =
  'k() { for t in $(pgrep -P "$1"); do kill -9 -"$t" 2>/dev/null; done; ' +
  'kill -9 -"$1" 2>/dev/null; pkill -9 -s "$1" 2>/dev/null; }; ';

/**
 * 杀掉经 exec 启动、仍在运行的全部命令（接手崩溃的前任时）：按命令行找到每个包装（会话首进程），
 * 按进程组与会话 SIGKILL。模式里的 `[.]` 让它匹配不到这个脚本自己的命令行。与 sandbox-docker 相同。
 */
const KILL_ALL_SCRIPT =
  `${KILL_TREE}${KILL_MARKED}for q in $(pgrep -f -- "capybara-exec /tmp/[.]capybara-exec-"); do ` +
  `k "$q"; kill -9 "$q" 2>/dev/null; done; km E "${EXEC_MARKER}=/tmp/[.]capybara-exec-.*"; exit 0`;

/**
 * Kills the exec commands of the holders whose tags are the script's arguments (`killTagged`),
 * matching their control files `/tmp/.capybara-exec-<tag>-<uuid>` with the UUID's exact shape, so
 * a tag that is a prefix of another never matches the other's commands; other commands keep
 * running. Tags are checked against `SANDBOX_TAG_RE` first. Same as sandbox-docker.
 */
const KILL_TAGGED_SCRIPT =
  `${KILL_TREE}${KILL_MARKED}u='[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'; ` +
  'for t in "$@"; do ' +
  'for q in $(pgrep -f -- "capybara-exec /tmp/[.]capybara-exec-$t-$u( |$)"); do ' +
  `k "$q"; kill -9 "$q" 2>/dev/null; done; km E "${EXEC_MARKER}=/tmp/[.]capybara-exec-$t-$u"; ` +
  "done; exit 0";

/**
 * Kills the Full access foreground executions of one operation (`revokeOperation`): every exec
 * wrapper (or admission agent about to exec it) whose control path ends with the operation's
 * UUID (`$1`), then the processes that left its session, by their environment marker. Exits 1 when
 * some survive (the caller then reboots the VM).
 */
const KILL_OPERATION_SCRIPT =
  `${KILL_TREE}${KILL_MARKED}` +
  'for q in $(pgrep -f -- "capybara-exec /tmp/[.]capybara-exec-[a-z0-9-]+-$1( |$)"); do ' +
  `k "$q"; kill -9 "$q" 2>/dev/null; done; km E "${EXEC_MARKER}=/tmp/[.]capybara-exec-[a-z0-9-]+-$1"; exit 0`;

/**
 * Installs the staged runtime (root): `$1` the root-only upload directory holding the files and
 * `SHA256SUMS`, `$2` the final directory. The files are checked, made root-owned 0644 in a 0755
 * directory and moved into place with one rename; a trusted directory another call installed
 * first is kept, an untrusted one (planted, altered, partial) is replaced. The installed
 * directory is checked again either way.
 */
const STAGE_RUNTIME_SCRIPT =
  'set -eu; umask 022; u=$1; d=$2; b=$(dirname -- "$d"); k="$u.sums"; ' +
  'trap \'rm -rf -- "$u" "$k"\' EXIT; cp -- "$u/SHA256SUMS" "$k"; ' +
  // trusted: a real directory whose entries (itself included) are root-owned, not group or
  // world writable, no symlinks, and whose files match the provider's own SHA256SUMS
  't() { [ -d "$1" ] && [ ! -L "$1" ] && ' +
  '[ -z "$(find "$1" -maxdepth 1 \\( ! -user 0 -o -perm /022 -o -type l \\) -print -quit)" ] && ' +
  '(cd -- "$1" && sha256sum -c --quiet "$k") >/dev/null 2>&1; }; ' +
  'if [ -L "$b" ] || { [ -e "$b" ] && [ ! -d "$b" ]; }; then rm -f -- "$b"; fi; ' +
  'mkdir -p -- "$b"; chown 0:0 "$b"; chmod 0755 "$b"; ' +
  'cd -- "$u"; sha256sum -c --quiet SHA256SUMS; chown -R 0:0 .; chmod 0644 ./*; chmod 0755 .; cd /; ' +
  // an existing directory that is not trusted (planted, altered, partial) is replaced
  'if ! t "$d"; then rm -rf -- "$d"; mv -T -- "$u" "$d" 2>/dev/null || true; fi; ' +
  't "$d"';

/**
 * The inline check every root run of the agent goes through (`python3 -I -c` with argv: agent
 * path, expected SHA-256, then the agent's own arguments): `/`, `/opt`, the runtime base and
 * directory and the agent file must exist (else exit 3: not staged), be root-owned, not group or
 * world writable and of the right type, and the agent's bytes must match the provider's pinned
 * digest (else exit 4: untrusted). Only then does it exec the agent in the same process. The
 * whole chain being root-owned, nothing can swap it between the check and the exec.
 * `--probe-only` checks without executing (tests).
 */
export const ROOT_AGENT_PRECHECK = [
  "import hashlib, os, stat, sys",
  "agent, digest, rest = sys.argv[1], sys.argv[2], sys.argv[3:]",
  "rt = os.path.dirname(agent); base = os.path.dirname(rt)",
  "chain = ['/', os.path.dirname(base), base, rt, agent]",
  "try:",
  "    infos = [os.lstat(p) for p in chain]",
  "except OSError:",
  "    sys.stderr.write('capybara-precheck: runtime missing\\n'); sys.exit(3)",
  "for p, i in zip(chain, infos):",
  "    kind = stat.S_ISREG(i.st_mode) if p == agent else stat.S_ISDIR(i.st_mode)",
  "    if i.st_uid != 0 or i.st_mode & 0o022 or not kind:",
  "        sys.stderr.write('capybara-precheck: untrusted runtime %s\\n' % p); sys.exit(4)",
  "with open(agent, 'rb') as f:",
  "    if hashlib.sha256(f.read()).hexdigest() != digest:",
  "        sys.stderr.write('capybara-precheck: untrusted runtime digest\\n'); sys.exit(4)",
  "if rest == ['--probe-only']:",
  "    sys.exit(0)",
  "os.execv(sys.executable, [sys.executable, '-I', agent] + rest)",
].join("\n");

/** The control file of one exec: carries the holder's tag when there is one. */
export function execControlPath(tag?: string): string {
  if (tag !== undefined && !SANDBOX_TAG_RE.test(tag)) throw new Error("invalid sandbox tag");
  return tag === undefined
    ? `/tmp/.capybara-exec-${randomUUID()}`
    : `/tmp/.capybara-exec-${tag}-${randomUUID()}`;
}

/**
 * 杀掉 ctl 对应的命令：先留 `.kill` 标记，等会话 id，按进程组与会话 SIGKILL；再按命令行兜底。
 * 找到了会话 id（命令确实已启动）才删 `.kill` 标记；没找到时留着，防止包装稍后才启动。
 */
const KILL_SCRIPT =
  `${KILL_TREE}${KILL_MARKED}c=$1; : > "$c.kill" 2>/dev/null; i=0; ` +
  'while [ ! -s "$c.pid" ] && [ $i -lt 20 ]; do sleep 0.05; i=$((i+1)); done; ' +
  'p=$(cat "$c.pid" 2>/dev/null); ' +
  'if [ -n "$p" ]; then k "$p"; rm -f "$c.kill"; fi; ' +
  'for q in $(pgrep -f -- "capybara-exec $c"); do ' +
  'k "$q"; kill -9 "$q" 2>/dev/null; done; ' +
  // processes that left the session; some still there → exit 1 → the caller reboots
  `km F "${EXEC_MARKER}=$c"; ` +
  'rm -f "$c.pid"; exit 0';

const READ_SCRIPT =
  'if [ ! -e "$1" ]; then exit 3; fi; if [ -d "$1" ]; then exit 4; fi; exec head -c "$2" -- "$1"';
/** GNU stat 取大小；没有 GNU stat 时（只在测试机上）退回 wc。 */
const STAT_SCRIPT =
  'if [ ! -e "$1" ]; then exit 3; fi; ' +
  's=$(stat -L -c %s -- "$1" 2>/dev/null) || s=$(($(wc -c < "$1"))); ' +
  'if [ -d "$1" ]; then echo "$s directory"; else echo "$s file"; fi';
/**
 * 普通路径的写入：以 root 运行，root 打开中转文件作 stdin，`runuser` 切到沙箱用户建父目录并写目标——
 * 权限与符号链接都按沙箱用户解析。`$1` 目标、`$2` 中转文件。中转文件无论成败都删掉。
 */
const USER_WRITE_SCRIPT =
  `s=1; runuser -u ${SANDBOX_USER} -- /bin/sh -c ` +
  `'set -e; mkdir -p -- "$(dirname -- "$1")"; cat > "$1"' capybara-write "$1" < "$2" && s=0; ` +
  'rm -f -- "$2"; exit $s';
/** `/skills` 的写入：以 root 写（/skills 归 root，沙箱用户只能读），文件 0644、目录 0755。 */
const SKILLS_WRITE_SCRIPT =
  'umask 022; s=1; mkdir -p -- "$(dirname -- "$1")" && cat -- "$2" > "$1" && chmod 0644 "$1" && s=0; ' +
  'rm -f -- "$2"; exit $s';

/**
 * Runs `LIST_SCRIPT` (`$2`, then its argv `$3`..`$5`) under the in-sandbox time limit `$1`; exit
 * 127 when the template has no python3 or no timeout (on the PATH the command is given).
 */
const LIST_WRAPPER =
  "command -v timeout >/dev/null 2>&1 && command -v python3 >/dev/null 2>&1 || exit 127; " +
  'exec timeout -s KILL "$1" python3 -I -c "$2" "$3" "$4" "$5"';

const NO_PYTHON =
  "sandbox-e2b: the sandbox template has no python3 or no timeout (looked up in /usr/local/bin, /usr/bin, /bin), which list and scan need; build the template from the published image or add them to your own";

/** envd's "no such process" (Connect `not_found`): the process has exited already. */
const processGone = (e: unknown) =>
  e instanceof E2BHttpError && e.status === 404 && e.code === "not_found";

/** `ms` 毫秒后调用 `fn`（本次调用内的短暂等待；用 AbortSignal.timeout，不用进程级定时器 API）。 */
function after(ms: number, fn: () => void): { cancel(): void } {
  const t = AbortSignal.timeout(ms);
  t.addEventListener("abort", fn, { once: true });
  return { cancel: () => t.removeEventListener("abort", fn) };
}

/** Waits `ms` (within one call), rejecting with the signal's reason when it aborts. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      timer.cancel();
      reject(signal.reason);
    };
    const timer = after(ms, () => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    });
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** `p`, rejecting with the signal's reason as soon as `signal` aborts (`p` itself goes on). */
function untilAborted<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(abortReason(signal));
      return;
    }
    const onAbort = () => reject(abortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
}

/**
 * The root-independent path checks (absolute, no `..` or empty segments, no control characters):
 * which roots a file call may reach is the kernel's, by mode (auto mode reaches any path, the
 * container is the boundary; sandbox mode is held to the roots before the call gets here).
 */
function checkPath(p: string): void {
  const errors = validateSandboxPathShape(p);
  if (errors.length > 0)
    throw new Error(`invalid sandbox path ${JSON.stringify(p)}: ${errors.join("; ")}`);
}

interface RunOpts {
  user: string;
  cmd: string;
  args: string[];
  env?: Record<string, string>;
  cwd?: string;
  /** Written to the process's stdin once it started, then stdin is closed. */
  stdin?: Uint8Array;
  /** stdout + stderr 合计最多收集的字节。 */
  maxOutputBytes: number;
  timeoutMs?: number;
  signal: AbortSignal;
  /** 超时 / 中止时杀进程（不给则只断开连接）；返回杀进程脚本是否确实跑完。 */
  kill?: (pid: number | undefined) => Promise<boolean>;
  /** 最后手段：杀进程失败，或杀完宽限期过了流还没结束时调用（重启沙箱）。 */
  recover?: () => Promise<void>;
}

interface RunResult {
  exitCode: number | null;
  stdout: Buffer;
  stderr: Buffer;
  truncated: boolean;
  timedOut: boolean;
  aborted: boolean;
}

interface SandboxInfo {
  sandboxID: string;
  envdAccessToken?: string | null;
  domain?: string | null;
  /** `GET /sandboxes/{id}`: running | paused. */
  state?: string;
}

/**
 * What the plugin enforces for `limits.network`: no network, an allowlist, or the internet with
 * the private, loopback, CGNAT and link-local ranges denied (`open-public`).
 */
type NetworkPolicy =
  | { kind: "none" }
  | { kind: "allowlist"; hosts: string[] }
  | { kind: "open-public" };

/** The create-body fields of a network policy (`POST /v2/sandboxes`). */
function createNetworkOf(policy: NetworkPolicy): Record<string, unknown> {
  switch (policy.kind) {
    case "allowlist":
      return { network: { allowOut: policy.hosts, denyOut: [ALL_TRAFFIC, ...IPV6_DENIED] } };
    case "open-public":
      return { allow_internet_access: true, network: { denyOut: [...OPEN_PUBLIC_DENIED] } };
    case "none":
      return { allow_internet_access: false };
  }
}

/** The body of `PUT /sandboxes/{id}/network` for a network policy (it replaces the whole config). */
function updateNetworkOf(policy: NetworkPolicy): NetworkUpdate {
  switch (policy.kind) {
    case "allowlist":
      return { allowOut: policy.hosts, denyOut: [ALL_TRAFFIC, ...IPV6_DENIED] };
    case "open-public":
      return { allow_internet_access: true, denyOut: [...OPEN_PUBLIC_DENIED] };
    case "none":
      return { allow_internet_access: false };
  }
}

/** The `sandbox@2` provider on E2B (shared by the plugin setup and the tests). */
export function createE2BSandbox(
  cfg: E2BSandboxConfig,
  /** `signal`: the extension's lifetime (`ctx.signal`); a template build in flight stops with it. */
  deps: { log: Logger; signal?: AbortSignal },
  test: E2BSandboxTestOptions = {},
): SandboxProvider {
  const api = createE2BApi(cfg.apiUrl ?? `https://api.${cfg.domain}`, cfg.apiKey);
  const enc = encodeURIComponent;

  const checkId = (id: string) => {
    if (!SANDBOX_ID_RE.test(id)) throw new Error(`invalid E2B sandbox id: ${JSON.stringify(id)}`);
  };

  const targetOf = (info: SandboxInfo): EnvdTarget => {
    checkId(info.sandboxID);
    const domain = info.domain || cfg.domain;
    if (!HOSTNAME_RE.test(domain)) {
      throw new Error(
        `E2B returned an invalid sandbox domain: ${JSON.stringify(domain).slice(0, 100)}`,
      );
    }
    // An envd without an access token can be called by anyone: create asked for `secure`, so no
    // token means no connection (fail closed). It is reported as SandboxGoneError, so the kernel
    // tries a new instance once; `create` reconnects the same E2B sandbox and fails again, so the
    // device stays unusable until its files are reset (a new file system), never used
    // without a token.
    if (typeof info.envdAccessToken !== "string" || info.envdAccessToken === "") {
      throw new SandboxGoneError(
        `E2B returned no envd access token for sandbox ${info.sandboxID}; refusing to use an unauthenticated sandbox (reset the device's files to recreate it)`,
      );
    }
    return {
      url: test.envdUrl ?? `https://${ENVD_PORT}-${info.sandboxID}.${domain}`,
      sandboxId: info.sandboxID,
      accessToken: info.envdAccessToken,
    };
  };

  /**
   * connect：运行中的沙箱把超时往后推（只延长不缩短），暂停的沙箱恢复；返回 envd 连接信息。
   * 不存在（被删、过期）→ SandboxGoneError；其余失败（401、5xx、网络）→ 普通错误。
   */
  const attach = async (id: string, signal: AbortSignal, minSeconds = 0): Promise<EnvdTarget> => {
    signal.throwIfAborted();
    checkId(id);
    const timeout = Math.min(MAX_TIMEOUT_SECONDS, Math.max(cfg.timeoutSeconds, minSeconds));
    for (let i = 0; ; i++) {
      try {
        const r = await api.json<SandboxInfo>("POST", `/v2/sandboxes/${enc(id)}/connect`, {
          body: { timeout },
          signal,
        });
        return targetOf({ ...r.data, sandboxID: r.data?.sandboxID ?? id });
      } catch (e) {
        if (isE2BNotFound(e)) {
          throw new SandboxGoneError(`E2B sandbox ${id} no longer exists`, { cause: e });
        }
        // concurrent auto-starts (parallel sub-agents): a connect that conflicts with another
        // caller's resume in flight is retried briefly (live-only assumption, see test/live)
        if (!isStatus(e, 409) || i >= CONNECT_CONFLICT_RETRIES) throw e;
        await sleep(CONNECT_CONFLICT_WAIT_MS, signal);
      }
    }
  };

  /** The ids of the sandboxes made under `name` (metadata {@link METADATA_NAME}) in `state`. */
  const idsByName = async (
    name: string,
    state: "running" | "running,paused",
    signal: AbortSignal,
  ): Promise<string[]> => {
    signal.throwIfAborted();
    const ids: string[] = [];
    let nextToken: string | undefined;
    do {
      const r = await api.json<{ sandboxID: string; metadata?: Record<string, string> }[]>(
        "GET",
        "/v2/sandboxes",
        {
          query: {
            metadata: new URLSearchParams({ [enc(METADATA_NAME)]: enc(name) }).toString(),
            state,
            limit: String(LIST_LIMIT),
            nextToken,
          },
          signal,
        },
      );
      for (const s of r.data ?? []) {
        // the server filtered by metadata already; check again, never touch another sandbox
        if (s.metadata?.[METADATA_NAME] === name) ids.push(s.sandboxID);
      }
      nextToken = r.headers.get("x-next-token") || undefined;
    } while (nextToken);
    return ids;
  };

  const kill = async (id: string, signal: AbortSignal) => {
    checkId(id);
    try {
      await api.json("DELETE", `/sandboxes/${enc(id)}`, { signal });
    } catch (e) {
      if (!isE2BNotFound(e)) throw e;
    }
  };

  /**
   * Pauses with the file system only (`memory: false`, the SDK's `mode: "filesystem"`): every
   * process ends, the files stay. Already paused (409) is success; missing (E2B's 404) too when
   * `missingOk`.
   */
  const pause = async (id: string, signal: AbortSignal, missingOk: boolean) => {
    checkId(id);
    try {
      await api.json("POST", `/sandboxes/${enc(id)}/pause`, { body: { memory: false }, signal });
    } catch (e) {
      if (isStatus(e, 409) || (missingOk && isE2BNotFound(e))) return;
      throw e;
    }
  };

  // ---------- template ----------

  const alias = templateAlias(cfg.defaultImage);
  /** The way out when the plugin cannot provide the template itself. */
  const ownTemplateHint =
    'set the sandbox-e2b setting `template` to a template of your own (README "Template")';
  const foreignAlias = (cause?: unknown) =>
    new Error(
      `E2B template alias ${alias} is owned by another E2B team or is public; ${ownTemplateHint}`,
      { cause },
    );

  /**
   * Looks up the alias (unless `rebuild`), else builds it from `cfg.defaultImage` with the calls
   * `Template.build(Template().fromImage(image), alias)` makes in `e2b@2.58.0` (request a build,
   * trigger it, poll its status until ready). Returns the template id. Bound to its own time limit
   * and the extension's lifetime, not to a caller's signal: concurrent callers share it.
   *
   * Only a template of this team that is not public is used: the alias is a predictable name, and
   * a public template under it (another team's) would run agent commands on an image nobody here
   * chose.
   */
  const provisionTemplate = async (rebuild: boolean): Promise<string> => {
    const timeout = AbortSignal.timeout(TEMPLATE_BUILD_TIMEOUT_MS);
    const signal = deps.signal ? AbortSignal.any([timeout, deps.signal]) : timeout;
    const checkTemplateId = (id: unknown, what: string): string => {
      if (typeof id !== "string" || !TEMPLATE_ID_RE.test(id)) {
        throw new Error(`E2B returned an invalid template ${what}: ${JSON.stringify(id)}`);
      }
      return id;
    };
    if (!rebuild) {
      let found: { templateID?: unknown; public?: unknown } | undefined;
      try {
        found = (
          await api.json<{ templateID?: unknown; public?: unknown }>(
            "GET",
            `/templates/aliases/${enc(alias)}`,
            { signal },
          )
        ).data;
      } catch (e) {
        // 403: the alias exists but belongs to another team (the SDK's aliasExists says so)
        if (isStatus(e, 403)) throw foreignAlias(e);
        if (!isE2BNotFound(e)) throw e;
      }
      if (found !== undefined) {
        if (found.public !== false) throw foreignAlias();
        // the alias exists; whether its build is ready shows when a sandbox is created from it
        return checkTemplateId(found.templateID, "id");
      }
    }
    deps.log.info("sandbox-e2b: building the E2B template from the published image", {
      alias,
      image: cfg.defaultImage,
    });
    let req: { templateID?: unknown; buildID?: unknown; public?: unknown } | undefined;
    try {
      req = (
        await api.json<{ templateID?: unknown; buildID?: unknown; public?: unknown }>(
          "POST",
          "/v3/templates",
          {
            body: { name: alias, cpuCount: TEMPLATE_CPU_COUNT, memoryMB: TEMPLATE_MEMORY_MB },
            signal,
          },
        )
      ).data;
    } catch (e) {
      if (isStatus(e, 403, 409)) throw foreignAlias(e);
      throw e;
    }
    // templates are created private (the build request has no visibility field); refuse one that
    // is not, rather than run sandboxes from it
    if (req?.public !== false) throw foreignAlias();
    const templateId = checkTemplateId(req.templateID, "id");
    const buildId = checkTemplateId(req.buildID, "build id");
    const build = `/templates/${enc(templateId)}/builds/${enc(buildId)}`;
    const failed = (detail: string, cause?: unknown) =>
      new Error(
        `E2B template build of ${cfg.defaultImage} (alias ${alias}) failed: ${detail}; ${ownTemplateHint}`,
        { cause },
      );
    try {
      await api.json("POST", `/v2${build}`, {
        body: { fromImage: cfg.defaultImage, steps: [], force: false },
        signal,
      });
    } catch (e) {
      if (signal.aborted) throw e;
      throw failed(e instanceof Error ? e.message : String(e), e);
    }
    let logsOffset = 0;
    for (;;) {
      const r = await api.json<{
        status?: string;
        logEntries?: unknown[];
        reason?: { message?: string };
      }>("GET", `${build}/status`, { query: { logsOffset: String(logsOffset) }, signal });
      logsOffset += Array.isArray(r.data?.logEntries) ? r.data.logEntries.length : 0;
      const status = r.data?.status;
      if (status === "ready") break;
      if (status !== "waiting" && status !== "building") {
        throw failed(
          `${String(status)}: ${String(r.data?.reason?.message ?? "no reason given").slice(0, 300)}`,
        );
      }
      await sleep(TEMPLATE_POLL_MS, signal);
    }
    deps.log.info("sandbox-e2b: E2B template ready", { alias, templateId });
    return templateId;
  };

  /** The template ensure of this provider instance (memoised; a failure is not kept). */
  let template: Promise<string> | undefined;
  /**
   * The template to create from: the `template` setting, else {@link provisionTemplate} (shared
   * by concurrent callers). `stale` is a result that turned out unusable (its build not ready):
   * it is replaced by a rebuild, once for all callers that saw it.
   */
  const ensureTemplate = (stale?: Promise<string>): Promise<string> => {
    if (cfg.template) return Promise.resolve(cfg.template);
    if (template === undefined || template === stale) {
      const p: Promise<string> = provisionTemplate(stale !== undefined).catch((e: unknown) => {
        if (template === p) template = undefined;
        throw e;
      });
      template = p;
    }
    return template;
  };

  // ---------- exec ----------

  /** 在沙箱里跑一条命令（envd 的进程流）。 */
  async function run(t: EnvdTarget, o: RunOpts): Promise<RunResult> {
    o.signal.throwIfAborted();
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let used = 0;
    let truncated = false;
    let timedOut = false;
    let aborted = false;
    let stopping = false;
    let pid: number | undefined;
    let exitCode: number | null | undefined;
    const collect = (kind: "out" | "err", b64: string) => {
      const data = Buffer.from(b64, "base64");
      const room = o.maxOutputBytes - used;
      if (data.byteLength > room) truncated = true;
      if (room <= 0) return;
      const keep = data.byteLength > room ? data.subarray(0, room) : data;
      used += keep.byteLength;
      (kind === "out" ? out : err).push(keep);
    };

    // 连接只由我们断开：中止 / 超时后先杀进程，宽限期过了才断开（断开本身不会结束沙箱里的进程）
    const conn = new AbortController();
    let grace: { cancel(): void } | undefined;
    let killing: Promise<void> | undefined;
    // 杀进程失败，或杀完宽限期过了流还没结束（还有进程拿着输出）：需要重启沙箱
    let wedged = false;
    // stopped before envd reported the pid: the kill could not name the process, so the start
    // event kills it by pid as soon as it is known
    let killedWithoutPid = false;
    const stop = () => {
      if (stopping) return;
      stopping = true;
      const kill = o.kill;
      if (!kill) {
        conn.abort();
        return;
      }
      killedWithoutPid = pid === undefined;
      killing = (async () => {
        const ok = await kill(pid).catch(() => false);
        if (!ok) {
          wedged = true;
          conn.abort();
          return;
        }
        grace = after(KILL_GRACE_MS, () => {
          wedged = true;
          conn.abort();
        });
      })();
    };
    const timer =
      o.timeoutMs === undefined
        ? undefined
        : after(o.timeoutMs, () => {
            timedOut = true;
            stop();
          });
    const onAbort = () => {
      aborted = true;
      stop();
    };
    o.signal.addEventListener("abort", onAbort, { once: true });

    const req: StartRequest = {
      cmd: o.cmd,
      args: o.args,
      ...(o.env && { envs: o.env }),
      ...(o.cwd !== undefined && { cwd: o.cwd }),
    };
    let streamError: unknown;
    let feeding: Promise<void> | undefined;
    // stdin: written once the process started, then closed. A failed write (the process may have
    // exited already) kills the process rather than leave it waiting for its request; the agent
    // refuses a partial request, so nothing runs on one. The stream then ends on its own.
    const feed = (p: number | undefined) => {
      const data = o.stdin;
      if (data === undefined || feeding) return;
      feeding = (async () => {
        if (p === undefined) throw new Error("E2B started a process without a pid");
        await envdSendInput(t, p, data, conn.signal);
        // The agent reads exactly its length-prefixed request and usually has exited by now
        // (not_found); closing is a courtesy, not awaited on the command's path.
        void envdCloseStdin(t, p, AbortSignal.timeout(15_000)).catch(() => undefined);
      })().catch(async (e: unknown) => {
        if (p !== undefined && !conn.signal.aborted && !processGone(e)) {
          await envdKill(t, p, AbortSignal.timeout(15_000)).catch(() => undefined);
        }
      });
    };
    try {
      await envdStart(
        t,
        o.user,
        req,
        (e) => {
          if ("start" in e) {
            pid = e.start.pid;
            if (killedWithoutPid && pid !== undefined) {
              void envdKill(t, pid, AbortSignal.timeout(15_000)).catch(() => undefined);
            }
            feed(pid);
          } else if ("data" in e) {
            if (e.data.stdout) collect("out", e.data.stdout);
            if (e.data.stderr) collect("err", e.data.stderr);
          } else if ("end" in e) exitCode = exitCodeOf(e.end);
        },
        conn.signal,
        o.stdin !== undefined,
      );
    } catch (e) {
      streamError = e;
    }
    await feeding;
    // 杀进程（必要时重启沙箱）完成后才返回：调用方接着用沙箱时它已结束
    await killing;
    grace?.cancel();
    if (wedged && o.recover) await o.recover().catch(() => undefined);
    timer?.cancel();
    o.signal.removeEventListener("abort", onAbort);
    const result = {
      stdout: Buffer.concat(out),
      stderr: Buffer.concat(err),
      truncated,
      timedOut,
      aborted,
    };
    if (timedOut || aborted) return { ...result, exitCode: null };
    if (streamError !== undefined) throw streamError;
    if (exitCode === undefined) throw new Error("E2B process stream ended without an exit status");
    return { ...result, exitCode };
  }

  /**
   * 杀掉一条命令：以沙箱用户跑杀进程脚本（按会话杀掉它派生的全部进程），再按 pid 让 envd 发 SIGKILL 兜底
   * （只结束会话首进程）。不受调用方 signal 影响（它往往正是已中止的那个）。返回脚本是否确实跑完；
   * 没跑完（起不来、超时、连不上）时由 {@link reboot} 兜底。
   */
  const killer = (t: EnvdTarget, ctl: string) => async (pid: number | undefined) => {
    const ok = await run(t, {
      user: SANDBOX_USER,
      cmd: "/bin/sh",
      args: ["-c", KILL_SCRIPT, "capybara-kill", ctl],
      cwd: "/",
      maxOutputBytes: 4096,
      timeoutMs: 15_000,
      signal: AbortSignal.timeout(20_000),
    }).then(
      (r) => r.exitCode === 0,
      () => false,
    );
    if (pid !== undefined)
      await envdKill(t, pid, AbortSignal.timeout(15_000)).catch(() => undefined);
    return ok;
  };

  /**
   * Last resort: reboot the sandbox. Pause it without memory, then connect with `memory: false`
   * (the SDK `e2b@2.58.0`'s `Sandbox.connect(id, { onResume: "reboot" })`, sent as well in case a
   * control plane ignored the pause's `memory`): a cold start from the disk state, every process
   * ends, /workspace stays; data not yet written to disk may be lost. Used only when the kill script
   * did not finish, or the command's output stream is still open after the kill grace period. Not
   * bound to the caller's signal.
   */
  const reboot = async (id: string) => {
    deps.log.warn("sandbox-e2b: could not stop a command cleanly; rebooting the sandbox", {
      sandboxId: id,
    });
    const signal = AbortSignal.timeout(120_000);
    await pause(id, signal, false);
    await api.json("POST", `/v2/sandboxes/${enc(id)}/connect`, {
      body: { timeout: cfg.timeoutSeconds, memory: false },
      signal,
    });
  };

  /** 文件操作：connect 后跑一个小脚本；被中止就以中止原因失败。 */
  const fileOp = async (
    t: EnvdTarget,
    o: Omit<RunOpts, "signal" | "kill" | "recover" | "cmd" | "cwd" | "timeoutMs">,
    signal: AbortSignal,
  ): Promise<RunResult> => {
    const r = await run(t, {
      ...o,
      cmd: "/bin/sh",
      cwd: "/",
      timeoutMs: FILE_OP_TIMEOUT_MS,
      signal,
    });
    if (r.aborted) throw abortReason(signal);
    if (r.timedOut) throw new Error("sandbox file operation timed out");
    return r;
  };

  /**
   * Runs `LIST_SCRIPT` in the sandbox as the sandbox user (links resolve there), under the
   * in-sandbox time limit; an abort returns at once (the read-only script ends at its time limit at
   * worst).
   */
  const listOp = async (
    id: string,
    op: "list" | "scan",
    path: string,
    limit: number,
    signal: AbortSignal,
  ): Promise<RunResult> => {
    const t = await attach(id, signal);
    return fileOp(
      t,
      {
        user: SANDBOX_USER,
        env: { PATH: test.listPath ?? LIST_PATH },
        args: [
          "-c",
          LIST_WRAPPER,
          "capybara-list",
          String(LIST_TIMEOUT_SECONDS),
          LIST_SCRIPT,
          op,
          path,
          String(limit),
        ],
        maxOutputBytes: LIST_MAX_OUTPUT_BYTES,
      },
      signal,
    );
  };

  const stderrOf = (r: RunResult) => r.stderr.toString("utf8").trim().slice(0, 500);

  /**
   * The network this plugin enforces for `limits` (README "Network policy"): an allowlist of the
   * given hosts, no network at all, or for `open-public` the internet with `denyOut` of the
   * private, loopback, CGNAT and link-local ranges (`OPEN_PUBLIC_DENIED`; its `hosts` add
   * nothing). Residual: E2B serves the microVM metadata endpoint (Firecracker MMDS at
   * 169.254.169.254) whatever `denyOut` says, under an allowlist too (verified live 2026-11-14).
   *
   * `mode` (`auto` | `sandbox`) is validated but changes nothing here: both run in the same E2B
   * microVM, where the container is the boundary. A limits object
   * without `mode` / `network` (an older kernel that sent `tier` / `egress` / `allowHosts`) is
   * refused rather than guessed.
   */
  const networkOf = (limits: SandboxLimits, name: string): NetworkPolicy => {
    const runtime = limits as { mode?: unknown; network?: unknown };
    if (runtime.mode !== "auto" && runtime.mode !== "sandbox") {
      throw new Error(
        'sandbox-e2b: the sandbox limits carry no mode ("auto" | "sandbox"); this plugin implements the sandbox@2 limits that a kernel sends from 0.1.0-rc.29 on (limits.mode / limits.network). An older kernel sent tier / egress / allowHosts instead; upgrade the kernel and the sandbox plugins together, and never open the network as a fallback.',
      );
    }
    const network = runtime.network as { kind?: unknown; hosts?: unknown } | undefined;
    const kind = network?.kind;
    const hosts = network?.hosts;
    if (kind === "open-public") return { kind: "open-public" };
    if (kind !== "allowlist" || !Array.isArray(hosts) || hosts.some((h) => typeof h !== "string")) {
      throw new Error(
        'sandbox-e2b: the sandbox limits carry no valid network (expected { kind: "allowlist", hosts } or { kind: "open-public", hosts }); this plugin implements the sandbox@2 limits that a kernel sends from 0.1.0-rc.29 on (limits.mode / limits.network). An older kernel sent tier / egress / allowHosts instead; upgrade the kernel and the sandbox plugins together.',
      );
    }
    for (const host of hosts) {
      const errors = validateAllowHost(host);
      if (errors.length > 0)
        throw new Error(`invalid network host ${JSON.stringify(host)}: ${errors.join("; ")}`);
    }
    if (!cfg.domainAllowlist) {
      deps.log.warn(
        "sandbox-e2b: domain allowlists are disabled for this deployment (domainAllowlist is false); network allowlist degraded to none",
        { name },
      );
      return { kind: "none" };
    }
    return hosts.length > 0 ? { kind: "allowlist", hosts: [...hosts] } : { kind: "none" };
  };

  // ---------- operations (permission profiles) ----------

  /**
   * The envd target of a running VM, or undefined when it is paused or gone: `GET /sandboxes/{id}`
   * answers its state and access token without connecting (connect would resume it).
   */
  const targetIfRunning = async (
    id: string,
    signal: AbortSignal,
  ): Promise<EnvdTarget | undefined> => {
    signal.throwIfAborted();
    checkId(id);
    let info: SandboxInfo | undefined;
    try {
      info = (await api.json<SandboxInfo>("GET", `/sandboxes/${enc(id)}`, { signal })).data;
    } catch (e) {
      if (isE2BNotFound(e)) return undefined;
      throw e;
    }
    if (info?.state !== "running") return undefined;
    return targetOf({ ...info, sandboxID: info.sandboxID ?? id });
  };

  /**
   * Stages this provider's operation runtime as root (README "Permission profiles"): the files go
   * to a fresh directory in the root-only upload area, root checks them against `SHA256SUMS` and
   * moves them into `RUNTIME_DIR`.
   */
  const stageRuntime = async (t: EnvdTarget, signal: AbortSignal) => {
    deps.log.info("sandbox-e2b: staging the operation runtime", {
      sandboxId: t.sandboxId,
      dir: RUNTIME_DIR,
    });
    const dir = `${UPLOAD_DIR}/${randomUUID()}`;
    for (const f of runtimeFiles())
      await envdUpload(t, `${dir}/${f.name}`, ROOT_USER, f.data, signal);
    await envdUpload(t, `${dir}/SHA256SUMS`, ROOT_USER, Buffer.from(runtimeChecksums()), signal);
    const r = await run(t, {
      user: ROOT_USER,
      cmd: "/bin/sh",
      args: ["-c", STAGE_RUNTIME_SCRIPT, "capybara-stage", dir, RUNTIME_DIR],
      cwd: "/",
      maxOutputBytes: STDERR_ROOM,
      timeoutMs: 60_000,
      signal,
    });
    if (r.exitCode !== 0) {
      throw new Error(`sandbox-e2b: cannot stage the operation runtime: ${stderrOf(r)}`);
    }
  };

  /** Python's answer when the agent file is missing (the runtime is not staged in this VM yet). */
  const agentMissing = (o: AgentRunOpts, r: RunResult) =>
    o.cmd.includes(OPERATION_AGENT) &&
    r.exitCode === 2 &&
    r.stderr.toString("utf8").includes("can't open file") &&
    r.stdout.byteLength === 0;

  /**
   * Ends an aborted or timed-out agent command in the VM: envd SIGKILLs it by pid (the agent
   * forks nothing on its foreground path; a background start's detached supervisor is reconciled
   * by operations.ts). Without a pid yet, `run` kills it once the start event names it.
   */
  const killAgent = (t: EnvdTarget) => async (pid: number | undefined) => {
    if (pid === undefined) return true;
    return envdKill(t, pid, AbortSignal.timeout(15_000)).then(
      () => true,
      () => false,
    );
  };

  /**
   * Runs one agent command; stages the runtime and retries once when its file is missing or, for
   * a root run, when the inline verification does not trust it.
   */
  const runAgent = async (t: EnvdTarget, o: AgentRunOpts): Promise<RunResult> => {
    // Root runs the agent only through the inline verification (ROOT_AGENT_PRECHECK).
    const root = o.user === "root" && o.cmd[2] === OPERATION_AGENT;
    const args = root
      ? [
          "-I",
          "-c",
          ROOT_AGENT_PRECHECK,
          OPERATION_AGENT,
          OPERATION_AGENT_SHA256,
          ...o.cmd.slice(3),
        ]
      : o.cmd.slice(1);
    const once = () =>
      run(t, {
        user: o.user === "root" ? ROOT_USER : SANDBOX_USER,
        cmd: o.cmd[0] as string,
        args,
        ...(o.env && { env: o.env }),
        ...(o.stdin && { stdin: o.stdin }),
        cwd: "/",
        maxOutputBytes: o.maxOutputBytes,
        ...(o.timeoutMs !== undefined && { timeoutMs: o.timeoutMs }),
        signal: o.signal,
        kill: killAgent(t),
      });
    const r = await once();
    const unverified =
      root &&
      (r.exitCode === 3 || r.exitCode === 4) &&
      r.stderr.toString("utf8").includes("capybara-precheck:");
    if (!agentMissing(o, r) && !unverified) return r;
    await stageRuntime(t, o.signal);
    return once();
  };

  /** Envd answers 502 for a VM that was paused meanwhile: not running, never resumed here. */
  const pausedMeanwhile = (e: unknown) => isStatus(e, 502);

  /**
   * The ordinary exec: the command runs through the wrapper (`execArgs`) under `ctl`; `prefix`
   * (the operation agent's admission check, Full access only) execs that wrapper unchanged.
   */
  const execWith = async (
    h: SandboxHandle,
    args: Omit<Parameters<SandboxProvider["exec"]>[1], "actor">,
    ctl: string,
    prefix: string[] = [],
    nonce?: string,
  ): Promise<ExecResult> => {
    args.signal.throwIfAborted();
    const env: Record<string, string> = { HOME: "/workspace", LANG: "C.UTF-8" };
    for (const [k, v] of Object.entries(args.env ?? {})) {
      if (!ENV_KEY_RE.test(k)) throw new Error(`invalid environment variable name: ${k}`);
      env[k] = v;
    }
    // The admission agent removes it before exec: the command can never echo it back.
    if (nonce !== undefined) env.CAPYBARA_ADMISSION_NONCE = nonce;
    // set last: a caller's variable of the same name never replaces it
    env[EXEC_MARKER] = ctl;
    const t = await attach(
      h.id,
      args.signal,
      Math.ceil(args.timeoutMs / 1000) + TIMEOUT_MARGIN_SECONDS,
    );
    const wrapper = execArgs(ctl, args.command, args.timeoutMs);
    const r = await run(t, {
      user: SANDBOX_USER,
      cmd: prefix.length > 0 ? (prefix[0] as string) : "setsid",
      args: prefix.length > 0 ? [...prefix.slice(1), "setsid", ...wrapper] : wrapper,
      env,
      cwd: args.cwd ?? "/workspace",
      maxOutputBytes: args.maxOutputBytes,
      timeoutMs: args.timeoutMs,
      signal: args.signal,
      kill: killer(t, ctl),
      // 重启也失败时只记日志（错误信息来自 API 正文与状态码，不含 apiKey 与访问令牌），照常返回本次结果
      recover: () =>
        reboot(h.id).catch((e: unknown) => {
          deps.log.warn(
            "sandbox-e2b: sandbox reboot failed; the stuck command may still be running",
            {
              sandboxId: h.id,
              err: (e instanceof Error ? e.message : String(e)).slice(0, 500),
            },
          );
        }),
    });
    // The admission prefix refused before the command started: its only output is the refusal
    // frame (operations.ts maps it), with exit code 125.
    if (prefix.length > 0 && r.exitCode === 125 && r.stdout[0] === 0x52) {
      const refused = refusedFrame(r.stdout, nonce ?? "");
      if (refused === "cancelled") {
        return { exitCode: null, stdout: "", stderr: "", truncated: false, timedOut: false };
      }
      if (refused) throw refused;
    }
    return {
      exitCode: r.exitCode,
      stdout: decodeOutput(r.stdout, r.truncated),
      stderr: decodeOutput(r.stderr, r.truncated),
      truncated: r.truncated,
      timedOut: r.timedOut,
    };
  };

  const transport: OperationTransport = {
    async run(h, o) {
      const t = await attach(h.id, o.signal);
      return runAgent(t, o);
    },
    async session(h, signal) {
      const t = await attach(h.id, signal);
      return (o) => runAgent(t, o);
    },
    async runIfRunning(h, o) {
      const t = await targetIfRunning(h.id, o.signal);
      if (t === undefined) return "not-running";
      try {
        return await runAgent(t, o);
      } catch (e) {
        if (pausedMeanwhile(e)) return "not-running";
        throw e;
      }
    },
    execFull: (h, args, ctl, prefix, nonce) => execWith(h, args, ctl, prefix, nonce),
    async killOperation(h, uuid, signal) {
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(uuid)) {
        throw new Error("invalid operation control id");
      }
      // a paused VM (paused without memory) runs nothing
      const t = await targetIfRunning(h.id, signal);
      if (t === undefined) return;
      const r = await run(t, {
        user: SANDBOX_USER,
        cmd: "/bin/sh",
        args: ["-c", KILL_OPERATION_SCRIPT, "capybara-killop", uuid],
        cwd: "/",
        maxOutputBytes: STDERR_ROOM,
        timeoutMs: 15_000,
        signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
      }).catch(() => null);
      // survivors (or no answer): the last resort ends every process in the VM; the revocation
      // then sees a new generation and reports a retry
      if (r?.exitCode !== 0) await reboot(h.id);
    },
    loseBackgroundAck: test.loseBackgroundAck,
    backgroundStartCommand: test.backgroundStartCommand,
  };
  const operations = createOperations({ transport, decode: decodeOutput });

  // ---------- 契约 ----------

  return {
    // envd runs every process.Start independently; connect on a running sandbox only extends its
    // timeout, so concurrent auto-starts are idempotent (a 409 from a resume in flight is retried)
    concurrentExec: true,
    // the instance is the file system's sandbox resumed: create-time limits are those of
    // createFileSystem; `update` is the only way to change them without a file reset
    limitsApplyAt: "fileSystem",
    async createFileSystem({ name, limits, signal }) {
      signal.throwIfAborted();
      if (!NAME_RE.test(name)) throw new Error(`invalid sandbox name: ${name}`);
      checkLimits(limits);
      // the network is set here; `update` changes it on the running sandbox (README "Network
      // policy"). One template for every mode: the network policy changes only the network.
      const policy = networkOf(limits, name);
      // made before under this name (the kernel stopped before recording the handle): return it
      const [existing] = await idsByName(name, "running,paused", signal);
      if (existing !== undefined) {
        checkId(existing);
        return { id: existing };
      }
      const network = createNetworkOf(policy);
      const createFrom = (templateID: string) =>
        api.json<SandboxInfo>("POST", "/v2/sandboxes", {
          body: {
            templateID,
            metadata: { [METADATA_NAME]: name },
            timeout: cfg.timeoutSeconds,
            // paused rather than killed at the timeout, with the file system only (like
            // suspend): the files survive even when the kernel never gets to suspend
            autoPause: true,
            autoPauseMemory: false,
            // envd requires an access token (the e2b SDK's default); targetOf refuses without one
            secure: true,
            ...network,
          },
          signal,
        });
      const first = ensureTemplate();
      let r: Awaited<ReturnType<typeof createFrom>>;
      try {
        r = await createFrom(await untilAborted(first, signal));
      } catch (e) {
        // an existing alias whose build is not ready (another replica's build in flight, or a
        // failed one) answers 404: build it ourselves and poll until ready, then retry once
        if (cfg.template || !isE2BNotFound(e)) throw e;
        r = await createFrom(await untilAborted(ensureTemplate(first), signal));
      }
      if (!r.data?.sandboxID) throw new Error("E2B create sandbox returned no sandboxID");
      checkId(r.data.sandboxID);
      // the file system lives on as a paused sandbox until an instance connects it
      await pause(r.data.sandboxID, signal, false);
      return { id: r.data.sandboxID };
    },

    /**
     * Applies the network policy of `limits` to the running sandbox (`PUT /sandboxes/{id}/network`,
     * which replaces the whole network configuration). E2B updates only running sandboxes (a paused
     * one answers E2B's 404), so the sandbox is connected (resumed) first; the kernel calls `update`
     * right after `resume` anyway. A refused policy throws before any call. A sandbox that is gone →
     * SandboxGoneError. cpu / memory / disk are fixed by the template and never change here.
     */
    async update(h, limits, signal) {
      signal.throwIfAborted();
      checkLimits(limits);
      const policy = networkOf(limits, h.id);
      await attach(h.id, signal);
      try {
        await updateNetwork(api, h.id, updateNetworkOf(policy), signal);
      } catch (e) {
        if (isE2BNotFound(e)) {
          throw new SandboxGoneError(`E2B sandbox ${h.id} no longer exists`, { cause: e });
        }
        throw e;
      }
      deps.log.info("sandbox-e2b: sandbox network updated", {
        sandboxId: h.id,
        mode: limits.mode,
        network: policy.kind,
      });
      return "updated";
    },

    async destroyFileSystem(fs, signal) {
      signal.throwIfAborted();
      await kill(fs.id, signal);
    },

    async destroyFileSystemByName(name, signal) {
      for (const id of await idsByName(name, "running,paused", signal)) await kill(id, signal);
    },

    async create({ name, fileSystem, signal }) {
      signal.throwIfAborted();
      if (!NAME_RE.test(name)) throw new Error(`invalid sandbox name: ${name}`);
      // the instance is the file system's sandbox resumed: image and limits were fixed when the
      // file system was created (README "Template", "Network policy")
      try {
        await attach(fileSystem.id, signal);
      } catch (e) {
        if (e instanceof SandboxGoneError && isE2BNotFound(e.cause)) {
          throw new FileSystemGoneError(
            `E2B sandbox ${fileSystem.id} holding the device's files no longer exists`,
            { cause: e },
          );
        }
        throw e;
      }
      return { id: fileSystem.id };
    },

    async resume(h, signal) {
      try {
        await attach(h.id, signal);
      } catch (e) {
        if (e instanceof SandboxGoneError) return "gone";
        throw e;
      }
      return "resumed";
    },

    async suspend(h, signal) {
      signal.throwIfAborted();
      await pause(h.id, signal, true);
    },

    async destroy(h, signal) {
      // the instance goes, the files stay: the same pause as suspend
      signal.throwIfAborted();
      await pause(h.id, signal, true);
    },

    async destroyByName(name, signal) {
      for (const id of await idsByName(name, "running", signal)) await pause(id, signal, true);
    },

    async killAll(h, signal) {
      signal.throwIfAborted();
      // connect resumes a paused sandbox (paused without memory: no process comes back); a
      // missing one throws SandboxGoneError
      const t = await attach(h.id, signal);
      const r = await fileOp(
        t,
        {
          user: SANDBOX_USER,
          args: ["-c", KILL_ALL_SCRIPT, "capybara-killall"],
          maxOutputBytes: STDERR_ROOM,
        },
        signal,
      );
      if (r.exitCode !== 0) throw new Error(`cannot stop leftover commands: ${stderrOf(r)}`);
    },

    async killTagged(h, tags, signal) {
      signal.throwIfAborted();
      for (const t of tags) {
        if (!SANDBOX_TAG_RE.test(t)) throw new Error("invalid sandbox tag");
      }
      if (tags.length === 0) return;
      // like killAll: connect resumes a paused sandbox; a missing one throws SandboxGoneError
      const t = await attach(h.id, signal);
      const r = await fileOp(
        t,
        {
          user: SANDBOX_USER,
          args: ["-c", KILL_TAGGED_SCRIPT, "capybara-killtagged", ...tags],
          maxOutputBytes: STDERR_ROOM,
        },
        signal,
      );
      if (r.exitCode !== 0)
        throw new Error(`cannot stop crashed holders' commands: ${stderrOf(r)}`);
    },

    async exec(h, args): Promise<ExecResult> {
      return execWith(h, args, execControlPath(args.tag));
    },

    async readFile(h, path, opts) {
      opts.signal.throwIfAborted();
      checkPath(path);
      const t = await attach(h.id, opts.signal);
      const want = opts.maxBytes + 1;
      const r = await fileOp(
        t,
        {
          user: SANDBOX_USER,
          args: ["-c", READ_SCRIPT, "capybara-read", path, String(want)],
          maxOutputBytes: want + STDERR_ROOM,
        },
        opts.signal,
      );
      if (r.exitCode === 3 || r.exitCode === 4) return null;
      if (r.exitCode !== 0) throw new Error(`cannot read ${path}: ${stderrOf(r)}`);
      const truncated = r.stdout.byteLength > opts.maxBytes;
      const data = truncated ? r.stdout.subarray(0, opts.maxBytes) : r.stdout;
      return { data: new Uint8Array(data), truncated };
    },

    async writeFile(h, path, data, signal) {
      signal.throwIfAborted();
      checkPath(path);
      const t = await attach(h.id, signal);
      // envd 上传以 root 打开目标（跟随符号链接）：只传到 root 专用的中转目录，再在沙箱里搬
      const staging = `${UPLOAD_DIR}/${randomUUID()}`;
      await envdUpload(t, staging, ROOT_USER, data, signal);
      const skills = path === "/skills" || path.startsWith("/skills/");
      const r = await fileOp(
        t,
        {
          user: ROOT_USER,
          args: [
            "-c",
            skills ? SKILLS_WRITE_SCRIPT : USER_WRITE_SCRIPT,
            "capybara-write",
            path,
            staging,
          ],
          maxOutputBytes: STDERR_ROOM,
        },
        signal,
      );
      if (r.exitCode !== 0) throw new Error(`cannot write ${path}: ${stderrOf(r)}`);
    },

    async stat(h, path, signal) {
      signal.throwIfAborted();
      checkPath(path);
      const t = await attach(h.id, signal);
      const r = await fileOp(
        t,
        {
          user: SANDBOX_USER,
          args: ["-c", STAT_SCRIPT, "capybara-stat", path],
          maxOutputBytes: STDERR_ROOM,
        },
        signal,
      );
      if (r.exitCode === 3) return null;
      const m = r.stdout.toString("utf8").match(/^(\d+) (file|directory)\n?$/);
      if (r.exitCode !== 0 || !m) throw new Error(`cannot stat ${path}: ${stderrOf(r)}`);
      return { size: Number(m[1]), isDir: m[2] === "directory" };
    },

    // the sandbox's workspace is the whole area in either mode (core spec 2026-11-14 §4.2), so
    // `limits.mode` changes nothing here
    async list(h, path, opts) {
      opts.signal.throwIfAborted();
      const p = checkListPath(path);
      const r = await listOp(h.id, "list", p, listLimit(opts.limit), opts.signal);
      return finishList(p, r, NO_PYTHON);
    },

    async scan(h, base, opts) {
      opts.signal.throwIfAborted();
      const b = checkListPath(base);
      const r = await listOp(h.id, "scan", b, 0, opts.signal);
      return finishScan(b, r, NO_PYTHON);
    },

    // The operation contract (operations.ts): fresh immutable scopes per invocation; Full access
    // only on this provider (restricted scopes are refused, see permissionSupport).
    permissionSupport: operations.permissionSupport,
    operation: operations.operation,
    prepare: operations.prepare,
    browse: operations.browse,
    revokeOperation: operations.revokeOperation,
    background: operations.background,
  };
}

/** Go `syscall.Signal.String()`（envd 结束事件的 `status` 形如 `signal: killed`）→ 信号编号。 */
const SIGNALS: Readonly<Record<string, number>> = {
  hangup: 1,
  interrupt: 2,
  quit: 3,
  "illegal instruction": 4,
  "trace/breakpoint trap": 5,
  aborted: 6,
  "bus error": 7,
  "floating point exception": 8,
  killed: 9,
  "user defined signal 1": 10,
  "segmentation fault": 11,
  "user defined signal 2": 12,
  "broken pipe": 13,
  "alarm clock": 14,
  terminated: 15,
};

/**
 * envd 结束事件 → 退出码：正常退出取 `exitCode`（proto3 JSON 省略 0）；被信号结束（`exited` 为 false，不是我们
 * 超时 / 中止杀的）按 shell 惯例给 128 + 信号编号（如 OOM 的 SIGKILL → 137）；认不出信号时给 null（内核据此
 * 告诉模型「命令没跑完、结果可能不完整」）。
 */
export function exitCodeOf(end: {
  exitCode?: number;
  exited?: boolean;
  status?: string;
}): number | null {
  const status = end.status ?? "";
  if (end.exited === true || status.startsWith("exit status ")) return end.exitCode ?? 0;
  const m = /^signal: (.+?)(?: \(core dumped\))?$/.exec(status);
  const n = m ? SIGNALS[m[1] as string] : undefined;
  return n !== undefined ? 128 + n : null;
}

/**
 * 解码命令输出。被截断时先退回到完整的 UTF-8 字符边界（截断点落在多字节字符中间时丢掉残缺的尾巴），
 * 不在末尾留下替换字符。
 */
export function decodeOutput(buf: Buffer, truncated: boolean): string {
  let end = buf.byteLength;
  if (truncated) {
    for (let i = end - 1; i >= 0 && i >= end - 4; i--) {
      const b = buf[i] as number;
      if ((b & 0xc0) === 0x80) continue;
      const need = b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : b >= 0xc0 ? 2 : 1;
      if (end - i < need) end = i;
      break;
    }
  }
  return buf.subarray(0, end).toString("utf8");
}

function checkLimits(l: SandboxLimits): void {
  if (!(l.cpu > 0) || !(l.memoryMb > 0) || !(l.diskMb > 0)) {
    throw new Error("sandbox limits cpu, memoryMb and diskMb must be positive");
  }
}
