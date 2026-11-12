import { randomUUID } from "node:crypto";
import type { Duplex } from "node:stream";
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
  validateSandboxPath,
} from "@capybara-hq/plugin-sdk";
import {
  abortReason,
  createDockerClient,
  type DockerClient,
  isStatus,
  type RequestOpts,
  StreamDemuxer,
} from "./docker-api.js";

/** The images published with a given sandbox-docker version (the plugins repo's image workflow). */
export function publishedImages(version: string): { sandbox: string; egress: string } {
  return {
    sandbox: `ghcr.io/capybara-hq/capybara-sandbox:${version}`,
    egress: `ghcr.io/capybara-hq/capybara-sandbox-egress:${version}`,
  };
}

// TODO(sdk): drop the local types when the SDK with tiers is released (capybara-hq/core#190)
/** The sandbox tier (`SandboxLimits.tier` in the SDK with tiers). */
export type SandboxTier = "strict" | "dev" | "open";
/**
 * `SandboxLimits` with the tier. An SDK without tiers never sends it: absent = `strict`. The
 * kernel already merges the dev hosts into `allowHosts` (final), so `devHosts` is never read.
 */
export type TierLimits = SandboxLimits & { tier?: SandboxTier };
/** The provider with the optional methods of the SDK with tiers (`update`, `limitsApplyAt`). */
export interface DockerSandboxProvider extends SandboxProvider {
  /**
   * Applies new limits to an existing instance: `"updated"` when only the egress proxy had to
   * change (recreated with the new mode and hosts), `"recreate"` when the container itself must
   * be recreated (network, environment or shm size differ, or the container is gone).
   */
  update(
    h: SandboxHandle,
    limits: SandboxLimits,
    signal: AbortSignal,
  ): Promise<"updated" | "recreate">;
  /** Limits are fixed when the instance (container) is created. */
  readonly limitsApplyAt: "instance";
}

/**
 * How a sandbox with egress `open` reaches the network: `off` refuses it, `proxy` goes through
 * the egress proxy in open mode (public hosts, any port), `direct` attaches the shared bridge.
 */
export type OpenEgress = "off" | "proxy" | "direct";

/**
 * The network an instance gets: `none`, `direct` (the shared bridge), or the egress proxy in one
 * of its modes (`strict`: allowlist on ports 443 / 80; `dev`: allowlist on any port plus SOCKS5;
 * `open`: any public host).
 */
export type EgressMode = "none" | "direct" | ProxyMode;
type ProxyMode = "strict" | "dev" | "open";

/** What `create` builds for given limits (pure; see {@link planInstance}). */
export interface InstancePlan {
  tier: SandboxTier;
  mode: EgressMode;
  /** The proxy's host list (`strict` / `dev`); empty for the other modes. */
  allowHosts: string[];
  /** `ShmSize` in bytes; null = Docker's default (64 MiB). */
  shmBytes: number | null;
}

/** The provider's config: the deployment config (index.ts DeploymentConfig) with images resolved. */
export interface DockerSandboxConfig {
  /** socket 代理地址：`tcp://host:port` 或 `unix:///path`。 */
  endpoint: string;
  runtime: "runc" | "runsc";
  /** 共用的沙箱网络（`open` 的沙箱与各出站代理接在上面）；不存在时按 bridge、禁止容器互访创建。 */
  network: string;
  egressProxyImage: string;
  /**
   * The sandbox image `create` uses when it gets no `image` (the plugin passes the image published
   * with its own version). Without it, `create` without `image` fails.
   */
  defaultImage?: string | undefined;
  /** 工作区卷的驱动；设了就带 `DriverOpts.size` 限制卷大小。 */
  volumeDriver?: string | undefined;
  /**
   * How `egress: "open"` is served (unset = `proxy`): `off` refuses it in `create`, `proxy` uses
   * the egress proxy in open mode, `direct` the shared bridge (reaches the host and intranet too).
   */
  openEgress?: OpenEgress | undefined;
}

/**
 * **仅测试**的选项：只有直接调用 {@link createDockerSandbox} 的代码能传，插件的部署配置设不了（index.ts 的
 * 部署配置 schema 是 strict，多出的键直接报错）。
 */
export interface DockerSandboxTestOptions {
  /** 给插件创建的所有容器、卷、网络额外打的标签（测试据此清理）。 */
  labels?: Record<string, string>;
  /**
   * 出站代理把这些主机名固定解析到给定 IP，并豁免私有地址检查（主机名仍须在白名单里）。
   * 用来把测试里的本地 HTTP 服务当作放行目标。
   */
  egressTestHosts?: Record<string, string>;
}

/** 沙箱用户（镜像里的 sandbox）：命令与文件操作以它运行。 */
const SANDBOX_USER = "1000:1000";
const ROOT_USER = "0:0";
/**
 * 容器主进程（init 与 `sleep infinity`）的用户：root（能力全部去掉）。沙箱用户发不了信号给它们，
 * `kill 1`、`pkill sleep`、`kill -9 -1` 都停不掉容器。每个 exec 都显式指定用户，不会以它运行命令。
 */
const INIT_USER = ROOT_USER;
/** 出站代理监听端口。 */
const PROXY_PORT = 3128;
/** The egress proxy's SOCKS5 port (modes `dev` and `open`). */
const SOCKS_PORT = 1080;
/** 沙箱内的进程数上限。 */
const PIDS_LIMIT = 1024;
const MIB = 1024 * 1024;
const GIB = 1024 * MIB;
/** 停容器时等进程退出的秒数（之后 SIGKILL）。 */
const STOP_SECONDS = 5;
/** 中止 / 超时杀掉命令后，最多再等输出流结束这么久（毫秒），之后直接断开。 */
const KILL_GRACE_MS = 3000;
/** 没有超时的操作（文件读写）在输出流结束后最多再等退出码这么久（毫秒）。 */
const EXIT_WAIT_MS = 30_000;
/** 读文件时额外留给 stderr 的字节。 */
const STDERR_ROOM = 64 * 1024;

const LABEL = "dev.capybara.sandbox";
const LABEL_NAME = "dev.capybara.sandbox.name";
const LABEL_ROLE = "dev.capybara.sandbox.role";
const LABEL_EGRESS = "dev.capybara.sandbox.egress";
const LABEL_ALLOW = "dev.capybara.sandbox.allow-hosts";
/**
 * The tier, egress mode and shm size the container was created with. With the host list
 * (`LABEL_ALLOW`) they are a lower bound of what its egress proxy allows: `update` changes the
 * proxy in place only when the new proxy allows at least as much, so a proxy rebuilt from these
 * labels (resume, after it went missing) never allows more than the one in force.
 */
const LABEL_TIER = "dev.capybara.sandbox.tier";
const LABEL_MODE = "dev.capybara.sandbox.egress-mode";
const LABEL_SHM = "dev.capybara.sandbox.shm";

/**
 * Container / volume / network names: `create`'s and `createFileSystem`'s name
 * (`cap-device-<deviceId>`; legacy `cap-<conversationId>`) plus a suffix.
 */
const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,100}$/;
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * The Docker resource names under one name. The instance is the container, its egress proxy and
 * its internal network (handle id = the container name); the file system is the two volumes
 * (handle id = the name they were made under). The kernel uses one name for both.
 */
export function sandboxResourceNames(name: string) {
  return {
    container: name,
    egress: `${name}-egress`,
    network: `${name}-net`,
    workspace: `${name}-workspace`,
    skills: `${name}-skills`,
  };
}

const isProxyMode = (m: EgressMode): m is ProxyMode =>
  m === "strict" || m === "dev" || m === "open";

/**
 * What an instance gets for `limits` (pure, no Docker): the tier (absent = `strict`), the egress
 * mode and shm size. `none` egress is no network in every tier; `open` egress follows
 * `openEgress` (`off` throws); `allowlist` goes through the proxy, in `strict` mode for the
 * `strict` tier and in `dev` mode (any port, SOCKS5) above it. `dev` and `open` tiers get
 * `ShmSize = min(1 GiB, memoryMb / 4)`; `strict` keeps Docker's default.
 */
export function planInstance(
  limits: SandboxLimits,
  openEgress: OpenEgress = "proxy",
): InstancePlan {
  const tier = (limits as TierLimits).tier ?? "strict";
  if (tier !== "strict" && tier !== "dev" && tier !== "open")
    throw new Error(`unknown sandbox tier: ${String(tier)}`);
  const shmBytes =
    tier === "strict" ? null : Math.min(GIB, Math.max(1, Math.floor(limits.memoryMb / 4)) * MIB);
  if (limits.egress === "none") return { tier, mode: "none", allowHosts: [], shmBytes };
  if (limits.egress === "open") {
    if (openEgress === "off") {
      throw new Error(
        'Sandbox egress "open" is refused: the sandbox-docker plugin setting openEgress is "off". Set extensionConfig."sandbox-docker".openEgress to "proxy" (any public host through the egress proxy) or "direct" (the shared bridge; trusted environments only), or lower the sandbox tier or egress.',
      );
    }
    return { tier, mode: openEgress === "direct" ? "direct" : "open", allowHosts: [], shmBytes };
  }
  return {
    tier,
    mode: tier === "strict" ? "strict" : "dev",
    allowHosts: [...limits.allowHosts],
    shmBytes,
  };
}

/**
 * The sandbox container's environment for an egress mode: `HTTP(S)_PROXY` through the proxy;
 * in `dev` / `open` mode also `ALL_PROXY` and `GRPC_PROXY` (the proxy's CONNECT port) and
 * `GIT_SSH_COMMAND` through its SOCKS5 port, so ssh and gRPC clients work.
 */
export function sandboxEnv(name: string, mode: EgressMode): string[] {
  const env = ["HOME=/workspace", "LANG=C.UTF-8"];
  if (!isProxyMode(mode)) return env;
  const host = sandboxResourceNames(name).egress;
  const proxy = `http://${host}:${PROXY_PORT}`;
  env.push(
    `HTTP_PROXY=${proxy}`,
    `HTTPS_PROXY=${proxy}`,
    `http_proxy=${proxy}`,
    `https_proxy=${proxy}`,
    "NO_PROXY=localhost,127.0.0.1,::1",
    "no_proxy=localhost,127.0.0.1,::1",
  );
  if (mode !== "strict") {
    env.push(
      `ALL_PROXY=${proxy}`,
      `all_proxy=${proxy}`,
      `GRPC_PROXY=${proxy}`,
      `grpc_proxy=${proxy}`,
      `GIT_SSH_COMMAND=ssh -o ProxyCommand='nc -X 5 -x ${host}:${SOCKS_PORT} %h %p'`,
    );
  }
  return env;
}

/** The egress proxy container's environment (egress-proxy/proxy.mjs) for a mode and host list. */
export function egressProxyEnv(
  mode: ProxyMode,
  allowHosts: string[],
  testHosts?: Record<string, string>,
): string[] {
  const env = [`MODE=${mode}`, `PORT=${PROXY_PORT}`];
  // open mode has no host list: any public host
  if (mode !== "open") env.push(`ALLOW_HOSTS=${JSON.stringify(allowHosts)}`);
  if (mode !== "strict") env.push(`SOCKS_PORT=${SOCKS_PORT}`);
  if (testHosts) env.push(`CAPYBARA_EGRESS_TEST_HOSTS=${JSON.stringify(testHosts)}`);
  return env;
}

/** The labels that record a plan on the sandbox container. */
function planLabels(limits: SandboxLimits, plan: InstancePlan): Record<string, string> {
  return {
    [LABEL_EGRESS]: limits.egress,
    [LABEL_TIER]: plan.tier,
    [LABEL_MODE]: plan.mode,
    [LABEL_ALLOW]: JSON.stringify(plan.allowHosts),
    [LABEL_SHM]: String(plan.shmBytes ?? 0),
  };
}

/** The egress mode recorded on a sandbox container (containers made before tiers: from egress). */
function labelMode(labels: Record<string, string>): EgressMode {
  const m = labels[LABEL_MODE];
  if (m === "none" || m === "direct" || m === "strict" || m === "dev" || m === "open") return m;
  const egress = labels[LABEL_EGRESS];
  return egress === "allowlist" ? "strict" : egress === "open" ? "direct" : "none";
}

/** Which environment a mode gives the container: none, HTTP proxies only, or the full set. */
const envClass = (m: EgressMode) => (!isProxyMode(m) ? "none" : m === "strict" ? "http" : "full");

/**
 * Whether `update` may move an instance from its container `labels` to `plan` by recreating only
 * its egress proxy (pure). The container's network, environment and shm size cannot change, and
 * the new proxy must allow at least what the labels record (`dev` to `open`, or a host list that
 * keeps every recorded host), so a proxy rebuilt from the labels never allows more than the one
 * `update` put in place. Anything else is `"recreate"`.
 */
export function updateDecision(
  labels: Record<string, string>,
  plan: InstancePlan,
): "updated" | "recreate" {
  const from = labelMode(labels);
  if (!isProxyMode(from) || !isProxyMode(plan.mode)) return "recreate";
  if (envClass(from) !== envClass(plan.mode)) return "recreate";
  if ((labels[LABEL_SHM] ?? "0") !== String(plan.shmBytes ?? 0)) return "recreate";
  if (plan.mode === "open") return "updated";
  if (from === "open") return "recreate";
  const recorded = JSON.parse(labels[LABEL_ALLOW] ?? "[]") as string[];
  return recorded.every((h) => plan.allowHosts.includes(h)) ? "updated" : "recreate";
}

/**
 * 沙箱里的硬时限比 `timeoutMs` 多出的秒数：正常情况下插件这边先按 `timeoutMs` 杀掉命令；内核副本崩溃
 * （插件这边的计时随之消失、断开连接也不结束命令）时由沙箱里的 `timeout` 兜底。
 */
export const IN_SANDBOX_GRACE_SECONDS = 5;

/**
 * 命令包装：在新会话里跑（setsid），先把会话 id 写到 `<ctl>.pid`，再看有没有 `<ctl>.kill`（杀的请求先到）；
 * 中止时按会话杀掉命令派生的全部进程。命令经 `timeout -s KILL` 运行：到沙箱里的时限即杀掉它所在的进程组。
 * After a timeout (124 or 137) the wrapper also kills what is left of its session: uutils `timeout`
 * (Ubuntu 26.04's default coreutils) kills only its child, not the child's process group (#7).
 * `$0` 是标记、`$1` 是 ctl、`$2` 是命令、`$3` 是沙箱里的时限（秒）。
 */
const EXEC_WRAPPER =
  'c=$1; echo $$ > "$c.pid" 2>/dev/null; if [ -e "$c.kill" ]; then exit 137; fi; ' +
  'timeout -s KILL "$3" /bin/bash -c "$2"; s=$?; ' +
  "if [ $s -eq 124 ] || [ $s -eq 137 ]; then " +
  'for p in $(pgrep -s $$); do [ "$p" = $$ ] || kill -9 "$p" 2>/dev/null; done; fi; ' +
  'rm -f "$c.pid"; exit $s';

/** `exec` 在容器里实际运行的命令行（导出供测试直接以 `docker exec -d` 模拟「内核崩溃后无人看管」）。 */
export function execArgv(ctl: string, command: string, timeoutMs: number): string[] {
  const seconds = Math.ceil(timeoutMs / 1000) + IN_SANDBOX_GRACE_SECONDS;
  return [
    "setsid",
    "-w",
    "/bin/sh",
    "-c",
    EXEC_WRAPPER,
    "capybara-exec",
    ctl,
    command,
    String(seconds),
  ];
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
 * 按进程组与会话 SIGKILL。模式里的 `[.]` 让它匹配不到这个脚本自己的命令行。
 */
const KILL_ALL_SCRIPT =
  `${KILL_TREE}for q in $(pgrep -f -- "capybara-exec /tmp/[.]capybara-exec-"); do ` +
  'k "$q"; kill -9 "$q" 2>/dev/null; done; exit 0';

/**
 * Kills the exec commands of the holders whose tags are the script's arguments (`killTagged`):
 * their control files are `/tmp/.capybara-exec-<tag>-<uuid>`, so the wrapper's command line
 * matches `capybara-exec /tmp/[.]capybara-exec-<tag>-<uuid> ` with the UUID's exact shape: a tag
 * that is a prefix of another (`ab` of `ab-cd`) never matches the other's commands, nor an
 * untagged command's UUID (tags are checked against `SANDBOX_TAG_RE` before they get here).
 * Other holders' commands keep running.
 */
const KILL_TAGGED_SCRIPT =
  `${KILL_TREE}u='[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'; for t in "$@"; do ` +
  'for q in $(pgrep -f -- "capybara-exec /tmp/[.]capybara-exec-$t-$u( |$)"); do ' +
  'k "$q"; kill -9 "$q" 2>/dev/null; done; done; exit 0';

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
  `${KILL_TREE}c=$1; : > "$c.kill" 2>/dev/null; i=0; ` +
  'while [ ! -s "$c.pid" ] && [ $i -lt 20 ]; do sleep 0.05; i=$((i+1)); done; ' +
  'p=$(cat "$c.pid" 2>/dev/null); ' +
  'if [ -n "$p" ]; then k "$p"; rm -f "$c.kill"; fi; ' +
  'for q in $(pgrep -f -- "capybara-exec $c"); do ' +
  'k "$q"; kill -9 "$q" 2>/dev/null; done; ' +
  'rm -f "$c.pid"; exit 0';

const READ_SCRIPT =
  'if [ ! -e "$1" ]; then exit 3; fi; if [ -d "$1" ]; then exit 4; fi; exec head -c "$2" -- "$1"';
const WRITE_SCRIPT = 'set -e; mkdir -p -- "$(dirname -- "$1")"; head -c "$2" > "$1"';
const STAT_SCRIPT = 'if [ ! -e "$1" ]; then exit 3; fi; exec stat -L -c "%s %F" -- "$1"';

/** `ms` 毫秒后调用 `fn`（本次调用内的短暂等待；用 AbortSignal.timeout，不用进程级定时器 API）。 */
function after(ms: number, fn: () => void): { cancel(): void } {
  const t = AbortSignal.timeout(ms);
  t.addEventListener("abort", fn, { once: true });
  return { cancel: () => t.removeEventListener("abort", fn) };
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      t.cancel();
      reject(abortReason(signal));
    };
    const t = after(ms, () => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    });
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function checkPath(p: string): void {
  const errors = validateSandboxPath(p);
  if (errors.length > 0)
    throw new Error(`invalid sandbox path ${JSON.stringify(p)}: ${errors.join("; ")}`);
}

interface RunOpts {
  cmd: string[];
  user: string;
  env?: string[];
  cwd?: string;
  stdin?: Uint8Array;
  /** stdout + stderr 合计最多收集的字节。 */
  maxOutputBytes: number;
  timeoutMs?: number;
  signal: AbortSignal;
  /** 超时 / 中止时杀进程（不给则只断开连接）。 */
  kill?: () => Promise<void>;
}

/** 容器还在但没在运行（exec 返回 409）：由契约层先启动再重试一次。 */
class NotRunningError extends Error {
  constructor(container: string, opts: { cause: unknown }) {
    super(`sandbox container ${container} is not running`, opts);
    this.name = "NotRunningError";
  }
}

interface RunResult {
  exitCode: number | null;
  stdout: Buffer;
  stderr: Buffer;
  truncated: boolean;
  timedOut: boolean;
  aborted: boolean;
}

/**
 * Builds the Docker `sandbox@2` provider (shared by the plugin's setup and the tests). `log` (the
 * extension's `ctx.log`) gets a warn when a kill falls back to restarting the container, which ends
 * every command in it.
 */
export function createDockerSandbox(
  cfg: DockerSandboxConfig,
  test: DockerSandboxTestOptions = {},
  log?: Pick<Logger, "warn">,
): DockerSandboxProvider {
  const api: DockerClient = createDockerClient(cfg.endpoint);
  const baseLabels = (name: string, role: string): Record<string, string> => ({
    ...test.labels,
    [LABEL]: "1",
    [LABEL_NAME]: name,
    [LABEL_ROLE]: role,
  });
  const enc = encodeURIComponent;

  // ---------- 资源 ----------

  /**
   * 建容器 / 卷 / 网络。socket 代理拒绝请求体里的任何非 ASCII 字节（Go 的 JSON 解码按 Unicode 折叠键名大小写，
   * `"Bindſ"` 会被当成 `Binds`），所以这里先把关：值里出现非 ASCII 直接报错，不转义（`\u` 同样被拒）。
   */
  const postCreate = async (path: string, opts: RequestOpts) => {
    const text = JSON.stringify(opts.body ?? null);
    // biome-ignore lint/suspicious/noControlCharactersInRegex: 正是要按 ASCII 范围判断
    if (/[^\x00-\x7f]/.test(text)) {
      throw new Error(
        `sandbox-docker: ${path} request contains non-ASCII characters (image, names, labels, environment and allowHosts must be ASCII; use punycode for hostnames)`,
      );
    }
    return api.json("POST", path, opts);
  };

  const ignore =
    (...status: number[]) =>
    (e: unknown) => {
      if (!isStatus(e, ...status)) throw e;
    };

  /** 删除；对象「正在使用 / 正在删除」时稍等重试。 */
  const removeWithRetry = async (path: string, signal: AbortSignal) => {
    for (let i = 0; ; i++) {
      try {
        await api.json("DELETE", path, { signal });
        return;
      } catch (e) {
        if (isStatus(e, 404)) return;
        if (i >= 20 || !isStatus(e, 403, 409, 500)) throw e;
        await sleep(250, signal);
      }
    }
  };

  /** Drops the instance under `name`: container, egress proxy and internal network (never volumes). */
  const destroyByName = async (name: string, signal: AbortSignal) => {
    signal.throwIfAborted();
    const n = sandboxResourceNames(name);
    await Promise.all(
      [n.container, n.egress].map((c) =>
        api
          .json("DELETE", `/containers/${enc(c)}`, { query: { force: true }, signal })
          .catch(ignore(404, 409)),
      ),
    );
    await removeWithRetry(`/networks/${enc(n.network)}`, signal);
  };

  /**
   * Drops the file system under `name`: its two volumes. The only container that mounts them is
   * the instance of the same name (the kernel names both alike; a `sandbox@1` provider made
   * `cap-<conversationId>` with its volumes), so that instance is force-removed first: Docker
   * refuses to remove a volume a container (even a stopped one) still uses.
   */
  const destroyFileSystemByName = async (name: string, signal: AbortSignal) => {
    signal.throwIfAborted();
    if (!NAME_RE.test(name)) throw new Error(`invalid sandbox name: ${name}`);
    const n = sandboxResourceNames(name);
    await destroyByName(name, signal);
    await Promise.all([
      removeWithRetry(`/volumes/${enc(n.workspace)}`, signal),
      removeWithRetry(`/volumes/${enc(n.skills)}`, signal),
    ]);
  };

  /**
   * Checks the two volumes of the file system `fsId`: `ok` when both exist and were made by this
   * plugin (role label); `unlabelled` names the volumes that exist without their role label (a
   * volume Docker created on its own for a missing mount source has none).
   */
  const checkFileSystem = async (
    fsId: string,
    signal: AbortSignal,
  ): Promise<{ ok: boolean; unlabelled: string[] }> => {
    const n = sandboxResourceNames(fsId);
    const found = await Promise.all(
      (
        [
          [n.workspace, "workspace"],
          [n.skills, "skills"],
        ] as const
      ).map(async ([vol, role]) => {
        try {
          const v = await api.json<{ Labels: Record<string, string> | null }>(
            "GET",
            `/volumes/${enc(vol)}`,
            { signal },
          );
          return { vol, state: v.Labels?.[LABEL_ROLE] === role ? "ok" : "unlabelled" } as const;
        } catch (e) {
          if (isStatus(e, 404)) return { vol, state: "missing" } as const;
          throw e;
        }
      }),
    );
    return {
      ok: found.every((f) => f.state === "ok"),
      unlabelled: found.filter((f) => f.state === "unlabelled").map((f) => f.vol),
    };
  };

  /** Creates a volume unless one of that name exists already (idempotent by name). */
  const ensureVolume = async (
    body: { Name: string } & Record<string, unknown>,
    signal: AbortSignal,
  ) => {
    try {
      await api.json("GET", `/volumes/${enc(body.Name)}`, { signal });
      return;
    } catch (e) {
      if (!isStatus(e, 404)) throw e;
    }
    await postCreate("/volumes/create", { body, signal });
  };

  const pull = async (image: string, signal: AbortSignal) => {
    await api.json("POST", "/images/create", { query: { fromImage: image }, signal });
  };

  /** 建容器；镜像不在本地时拉取一次再建。 */
  const createContainer = async (
    name: string,
    body: Record<string, unknown>,
    signal: AbortSignal,
  ) => {
    const go = () => postCreate("/containers/create", { query: { name }, body, signal });
    try {
      await go();
    } catch (e) {
      if (!(isStatus(e, 404) && /no such image/i.test((e as Error).message))) throw e;
      await pull(String(body.Image), signal);
      await go();
    }
  };

  const start = (container: string, signal: AbortSignal) =>
    api.json("POST", `/containers/${enc(container)}/start`, { signal }).catch(ignore(304));

  /** 恢复被 `docker pause` 冻结的容器（已经不是暂停状态时 Docker 回 409，算成功）。 */
  const unpause = (container: string, signal: AbortSignal) =>
    api.json("POST", `/containers/${enc(container)}/unpause`, { signal }).catch(ignore(409));

  const ensureSharedNetwork = async (signal: AbortSignal) => {
    try {
      await api.json("GET", `/networks/${enc(cfg.network)}`, { signal });
    } catch (e) {
      if (!isStatus(e, 404)) throw e;
      await postCreate("/networks/create", {
        body: {
          Name: cfg.network,
          Driver: "bridge",
          // 共用网络上的容器（open 的沙箱、各出站代理）互相不通
          Options: { "com.docker.network.bridge.enable_icc": "false" },
          Labels: { ...test.labels, [LABEL]: "1", [LABEL_ROLE]: "shared-network" },
        },
        signal,
      }).catch(ignore(409));
    }
  };

  const ensureInternalNetwork = async (name: string, signal: AbortSignal) => {
    const n = sandboxResourceNames(name);
    try {
      await api.json("GET", `/networks/${enc(n.network)}`, { signal });
    } catch (e) {
      if (!isStatus(e, 404)) throw e;
      await postCreate("/networks/create", {
        body: {
          Name: n.network,
          Driver: "bridge",
          Internal: true,
          Labels: baseLabels(name, "network"),
        },
        signal,
      }).catch(ignore(409));
    }
  };

  /** 等出站代理开始监听（在代理容器里请求它的 /healthz）。 */
  const waitEgressReady = async (container: string, signal: AbortSignal) => {
    for (let i = 0; ; i++) {
      const r = await run(container, {
        cmd: ["wget", "-q", "-O", "-", `http://127.0.0.1:${PROXY_PORT}/healthz`],
        user: "",
        maxOutputBytes: 1024,
        signal,
      }).catch((e: unknown) => {
        if (signal.aborted) throw abortReason(signal);
        if (i >= 50) throw e;
        return null;
      });
      if (r?.exitCode === 0) return;
      if (i >= 50) throw new Error("sandbox egress proxy did not become ready");
      await sleep(100, signal);
    }
  };

  /** Creates and starts the egress proxy (on the shared network and the sandbox's internal one). */
  const createEgress = async (
    name: string,
    mode: ProxyMode,
    allowHosts: string[],
    signal: AbortSignal,
    mayExist = false,
  ) => {
    const n = sandboxResourceNames(name);
    const made = createContainer(
      n.egress,
      {
        Image: cfg.egressProxyImage,
        Env: egressProxyEnv(mode, allowHosts, test.egressTestHosts),
        Labels: {
          ...baseLabels(name, "egress"),
          [LABEL_MODE]: mode,
          [LABEL_ALLOW]: JSON.stringify(allowHosts),
        },
        HostConfig: {
          NetworkMode: cfg.network,
          Init: true,
          ReadonlyRootfs: true,
          CapDrop: ["ALL"],
          SecurityOpt: ["no-new-privileges:true"],
          Memory: 128 * MIB,
          MemorySwap: 128 * MIB,
          NanoCpus: 500_000_000,
          PidsLimit: 128,
        },
        NetworkingConfig: { EndpointsConfig: { [cfg.network]: {}, [n.network]: {} } },
      },
      signal,
    );
    await (mayExist ? made.catch(ignore(409)) : made);
    await start(n.egress, signal);
    await waitEgressReady(n.egress, signal);
  };

  /**
   * On resume the egress proxy (and the internal network) must exist and run; a lost proxy is
   * rebuilt with the mode and hosts recorded on the sandbox container.
   */
  const ensureEgressRunning = async (
    name: string,
    mode: ProxyMode,
    allowHosts: string[],
    signal: AbortSignal,
  ) => {
    const n = sandboxResourceNames(name);
    await ensureSharedNetwork(signal);
    await ensureInternalNetwork(name, signal);
    let running: boolean;
    try {
      const c = await api.json<{ State: { Running: boolean; Paused?: boolean } }>(
        "GET",
        `/containers/${enc(n.egress)}/json`,
        { signal },
      );
      if (c.State.Paused) await unpause(n.egress, signal);
      running = c.State.Running;
    } catch (e) {
      if (!isStatus(e, 404)) throw e;
      // a concurrent auto-start may create it at the same moment: a name conflict is fine
      await createEgress(name, mode, allowHosts, signal, true);
      return;
    }
    if (!running) {
      await start(n.egress, signal);
      await waitEgressReady(n.egress, signal);
    }
  };

  // ---------- exec ----------

  /** 在容器里跑一条命令（劫持连接收多路复用的输出）。容器不在抛 SandboxGoneError。 */
  async function run(container: string, o: RunOpts): Promise<RunResult> {
    o.signal.throwIfAborted();
    const startedAt = Date.now();
    let execId: string;
    try {
      const r = await api.json<{ Id: string }>("POST", `/containers/${enc(container)}/exec`, {
        body: {
          AttachStdin: o.stdin !== undefined,
          AttachStdout: true,
          AttachStderr: true,
          Tty: false,
          Cmd: o.cmd,
          ...(o.user !== "" && { User: o.user }),
          ...(o.env && { Env: o.env }),
          ...(o.cwd !== undefined && { WorkingDir: o.cwd }),
        },
        signal: o.signal,
      });
      execId = r.Id;
    } catch (e) {
      if (isStatus(e, 404)) {
        throw new SandboxGoneError(`sandbox container ${container} no longer exists`, { cause: e });
      }
      if (isStatus(e, 409)) throw new NotRunningError(container, { cause: e });
      throw e;
    }

    let socket: Duplex;
    try {
      socket = await api.hijack(`/exec/${execId}/start`, { Detach: false, Tty: false }, o.signal);
    } catch (e) {
      if (isStatus(e, 404)) {
        throw new SandboxGoneError(`sandbox container ${container} no longer exists`, { cause: e });
      }
      // exec 建好之后、启动之前容器停了
      if (isStatus(e, 409)) throw new NotRunningError(container, { cause: e });
      if (!o.signal.aborted) throw e;
      // 启动请求已发出才被中止：命令可能已经在跑，照样杀掉
      await o.kill?.().catch(() => undefined);
      return {
        exitCode: null,
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
        truncated: false,
        timedOut: false,
        aborted: true,
      };
    }

    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let used = 0;
    let truncated = false;
    let timedOut = false;
    let aborted = false;
    let stopping = false;
    const demux = new StreamDemuxer((kind, data) => {
      const room = o.maxOutputBytes - used;
      if (data.byteLength > room) truncated = true;
      if (room <= 0) return;
      const keep = data.byteLength > room ? data.subarray(0, room) : data;
      used += keep.byteLength;
      (kind === 1 ? out : err).push(Buffer.from(keep));
    });

    const ended = new Promise<Error | null>((resolve) => {
      socket.on("data", (c: Buffer) => demux.push(c));
      socket.on("error", (e) => resolve(e));
      socket.on("close", () => resolve(null));
      socket.on("end", () => {
        socket.destroy();
        resolve(null);
      });
    });

    let grace: { cancel(): void } | undefined;
    let killing: Promise<void> | undefined;
    const stop = () => {
      if (stopping) return;
      stopping = true;
      const cut = () => {
        grace = after(KILL_GRACE_MS, () => socket.destroy());
      };
      if (o.kill)
        killing = o
          .kill()
          .catch(() => undefined)
          .finally(cut);
      else socket.destroy();
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
    if (o.signal.aborted) onAbort();

    if (o.stdin !== undefined && o.stdin.byteLength > 0) socket.write(o.stdin);

    const streamError = await ended;
    // 杀进程（或退而重启容器）完成后才返回：调用方接着用沙箱时它已可用
    await killing;
    timer?.cancel();
    grace?.cancel();
    o.signal.removeEventListener("abort", onAbort);
    const result = {
      stdout: Buffer.concat(out),
      stderr: Buffer.concat(err),
      truncated,
      timedOut,
      aborted,
    };
    if (timedOut || aborted) return { ...result, exitCode: null };
    if (streamError) throw streamError;

    // 输出流结束后取退出码（进程可能还差一点才被记为已退出）。一直等到命令的超时为止（没有超时的
    // 文件操作最多等 EXIT_WAIT_MS）；到点还在跑就杀掉并按超时返回，绝不返回看起来像「被中止」的结果。
    const deadline =
      o.timeoutMs !== undefined ? startedAt + o.timeoutMs : Date.now() + EXIT_WAIT_MS;
    try {
      for (;;) {
        const s = await api.json<{ Running: boolean; ExitCode: number | null }>(
          "GET",
          `/exec/${execId}/json`,
          { signal: AbortSignal.any([o.signal, AbortSignal.timeout(10_000)]) },
        );
        if (!s.Running) return { ...result, exitCode: s.ExitCode };
        if (Date.now() >= deadline) {
          if (!o.kill) throw new Error("sandbox command did not report an exit status");
          await o.kill().catch(() => undefined);
          return { ...result, timedOut: true, exitCode: null };
        }
        await sleep(50, o.signal);
      }
    } catch (e) {
      // 输出都收齐了才被中止：按「执行中被中止」返回（进程若还在就杀掉）
      if (o.signal.aborted) {
        await o.kill?.().catch(() => undefined);
        return { ...result, aborted: true, exitCode: null };
      }
      throw e;
    }
  }

  /**
   * 杀掉一条命令。杀进程用的 exec 本身失败时（如进程数已到上限，连 sh 都起不来）退而重启整个容器：
   * 文件都在卷上，/tmp 清空、沙箱里其余进程也一并结束，这是可以接受的代价。
   */
  const killer = (container: string, ctl: string) => () =>
    // 杀进程不受调用方 signal 影响（它往往正是已中止的那个）
    killOrRestart(container, ["/bin/sh", "-c", KILL_SCRIPT, "capybara-kill", ctl]);

  /**
   * 跑杀进程脚本；脚本起不来就重启容器。`signal`（给了时）与自己的超时合并：接手前任时（killAll）传持锁方的
   * signal，锁丢失就停下，不与新的持锁方同时动这个容器；单条命令超时 / 中止后的杀进程不传（那个 signal 往往
   * 正是已中止的）。
   */
  const killOrRestart = async (container: string, cmd: string[], signal?: AbortSignal) => {
    const within = (ms: number) =>
      signal ? AbortSignal.any([signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms);
    const ok = await run(container, {
      cmd,
      user: SANDBOX_USER,
      maxOutputBytes: 4096,
      signal: within(15_000),
    }).then(
      (r) => r.exitCode === 0 && !r.aborted,
      () => false,
    );
    if (ok) return;
    signal?.throwIfAborted();
    log?.warn(
      "sandbox-docker: the kill command could not run; restarting the container, which also ends other commands in it",
      { container },
    );
    await api.json("POST", `/containers/${enc(container)}/restart`, {
      query: { t: 0 },
      signal: within(60_000),
    });
  };

  /** 文件操作：以沙箱用户（写 /skills 时以 root 经可写挂载）跑一个小脚本。 */
  const fileOp = async (
    h: SandboxHandle,
    o: Omit<RunOpts, "signal" | "kill">,
    signal: AbortSignal,
  ): Promise<RunResult> => {
    const r = await autoStart(h, signal, () => run(h.id, { ...o, signal }));
    if (r.aborted) throw abortReason(signal);
    return r;
  };

  /**
   * 契约的「自动启动」：容器还在但被停了（宿主机 / 守护进程重启、休眠扫描停了它却没记下 suspended……）时，
   * 先按 resume 的做法（出站代理、网络就位）启动，再重试一次。已不在 → SandboxGoneError。
   */
  async function autoStart<T>(h: SandboxHandle, signal: AbortSignal, fn: () => Promise<T>) {
    try {
      return await fn();
    } catch (e) {
      if (!(e instanceof NotRunningError)) throw e;
      if ((await resume(h, signal)) === "gone") {
        throw new SandboxGoneError(`sandbox container ${h.id} no longer exists`, { cause: e });
      }
      return await fn();
    }
  }

  async function resume(h: SandboxHandle, signal: AbortSignal): Promise<"resumed" | "gone"> {
    signal.throwIfAborted();
    let c: {
      State: { Running: boolean; Paused?: boolean };
      Config: { Labels: Record<string, string> | null };
    };
    try {
      c = await api.json("GET", `/containers/${enc(h.id)}/json`, { signal });
    } catch (e) {
      if (isStatus(e, 404)) return "gone";
      throw e;
    }
    const labels = c.Config.Labels ?? {};
    const mode = labelMode(labels);
    if (mode === "direct") await ensureSharedNetwork(signal);
    if (isProxyMode(mode)) {
      const hosts = JSON.parse(labels[LABEL_ALLOW] ?? "[]") as string[];
      await ensureEgressRunning(h.id, mode, hosts, signal);
    }
    try {
      // `docker pause` 过的：Running 仍为 true，exec 却回 409，要 unpause
      if (c.State.Paused) await unpause(h.id, signal);
      else if (!c.State.Running) await start(h.id, signal);
    } catch (e) {
      if (isStatus(e, 404)) return "gone";
      throw e;
    }
    return "resumed";
  }

  const stderrOf = (r: RunResult) => r.stderr.toString("utf8").trim().slice(0, 500);

  // ---------- 契约 ----------

  return {
    // docker exec instances are independent; auto-start tolerates concurrent starts (304 / 409)
    concurrentExec: true,
    limitsApplyAt: "instance",

    async createFileSystem({ name, limits, signal }) {
      signal.throwIfAborted();
      if (!NAME_RE.test(name)) throw new Error(`invalid sandbox name: ${name}`);
      checkLimits(limits);
      const n = sandboxResourceNames(name);
      // an existing file system of this name is returned as it is (never replaced)
      await ensureVolume(
        {
          Name: n.workspace,
          Labels: baseLabels(name, "workspace"),
          ...(cfg.volumeDriver !== undefined && {
            Driver: cfg.volumeDriver,
            DriverOpts: { size: `${limits.diskMb}M` },
          }),
        },
        signal,
      );
      await ensureVolume({ Name: n.skills, Labels: baseLabels(name, "skills") }, signal);
      return { id: name };
    },

    async destroyFileSystem(fs, signal) {
      await destroyFileSystemByName(fs.id, signal);
    },

    destroyFileSystemByName,

    async create({ name, image, limits, fileSystem, signal }) {
      signal.throwIfAborted();
      if (!NAME_RE.test(name)) throw new Error(`invalid sandbox name: ${name}`);
      if (!NAME_RE.test(fileSystem.id)) {
        throw new Error(`invalid file system id: ${fileSystem.id}`);
      }
      checkLimits(limits);
      const sandboxImage = image ?? cfg.defaultImage;
      if (sandboxImage === undefined) {
        throw new Error(
          "sandbox-docker: create got no image and the provider has no default image",
        );
      }
      // refuses open egress under openEgress "off" before Docker is touched
      const plan = planInstance(limits, cfg.openEgress);
      const n = sandboxResourceNames(name);
      const v = sandboxResourceNames(fileSystem.id);
      // Docker would create a missing mount source as a new, empty volume: check first
      const gone = () =>
        new FileSystemGoneError(
          `sandbox file system ${fileSystem.id} is gone (volume ${v.workspace} or ${v.skills} missing)`,
        );
      if (!(await checkFileSystem(fileSystem.id, signal)).ok) throw gone();
      // An old instance of the same name (the kernel exited before recording the handle...):
      // replace the instance; the file system stays
      await destroyByName(name, signal);
      try {
        let networkMode = "none";
        if (plan.mode === "direct") {
          await ensureSharedNetwork(signal);
          networkMode = cfg.network;
        } else if (isProxyMode(plan.mode)) {
          await ensureSharedNetwork(signal);
          await ensureInternalNetwork(name, signal);
          await createEgress(name, plan.mode, plan.allowHosts, signal);
          networkMode = n.network;
        }

        const memory = limits.memoryMb * MIB;
        // /tmp 是 tmpfs（占内存配额）：取内存的一半，且不超过磁盘配额
        const tmpMb = Math.max(16, Math.min(limits.diskMb, Math.floor(limits.memoryMb / 2)));
        await createContainer(
          n.container,
          {
            Image: sandboxImage,
            User: INIT_USER,
            WorkingDir: "/workspace",
            Cmd: ["sleep", "infinity"],
            Env: sandboxEnv(name, plan.mode),
            Labels: { ...baseLabels(name, "sandbox"), ...planLabels(limits, plan) },
            HostConfig: {
              Runtime: cfg.runtime,
              Init: true,
              NanoCpus: Math.round(limits.cpu * 1e9),
              Memory: memory,
              MemorySwap: memory,
              PidsLimit: PIDS_LIMIT,
              ReadonlyRootfs: true,
              CapDrop: ["ALL"],
              SecurityOpt: ["no-new-privileges:true"],
              IpcMode: "private",
              NetworkMode: networkMode,
              // dev / open tiers: room for browsers and other shared-memory users
              ...(plan.shmBytes !== null && { ShmSize: plan.shmBytes }),
              Tmpfs: { "/tmp": `rw,nosuid,nodev,size=${tmpMb}m,mode=1777` },
              Mounts: [
                { Type: "volume", Source: v.workspace, Target: "/workspace" },
                { Type: "volume", Source: v.skills, Target: "/skills", ReadOnly: true },
                // 同一个卷的可写挂载：只有 root 进得去（/opt/capybara 是 0700），插件经它写技能
                { Type: "volume", Source: v.skills, Target: "/opt/capybara/skills" },
              ],
            },
          },
          signal,
        );
        // The volumes may have been removed between the check and the container create, in which
        // case Docker made empty, unlabelled ones for the mounts: drop the container that uses
        // them, remove those empty volumes (so a later createFileSystem of this name makes real
        // ones) and refuse
        const after = await checkFileSystem(fileSystem.id, signal);
        if (!after.ok) {
          await destroyByName(name, signal);
          await Promise.all(
            after.unlabelled.map((u) => removeWithRetry(`/volumes/${enc(u)}`, signal)),
          );
          throw gone();
        }
        await start(n.container, signal);
      } catch (e) {
        // No cleanup when aborted: a new lock holder may already use the same name; leftovers go
        // with the next create or destroyByName. The cleanup drops the instance only.
        if (!signal.aborted) {
          await destroyByName(name, AbortSignal.timeout(60_000)).catch(() => undefined);
        }
        throw e;
      }
      return { id: name };
    },

    resume,

    // Called under the kernel's exclusive lease when the effective tier or egress mode changed
    async update(h, limits, signal) {
      signal.throwIfAborted();
      checkLimits(limits);
      const plan = planInstance(limits, cfg.openEgress);
      let c: {
        State: { Running: boolean; Paused?: boolean };
        Config: { Labels: Record<string, string> | null };
      };
      try {
        c = await api.json("GET", `/containers/${enc(h.id)}/json`, { signal });
      } catch (e) {
        if (isStatus(e, 404)) return "recreate";
        throw e;
      }
      if (!isProxyMode(plan.mode) || updateDecision(c.Config.Labels ?? {}, plan) === "recreate") {
        return "recreate";
      }
      // Replace the egress proxy with the new mode and hosts; the container, its environment
      // and its internal network stay. Open connections through the old proxy end. If this
      // fails half-way, resume rebuilds the proxy from the container labels (a lower bound).
      const n = sandboxResourceNames(h.id);
      await api
        .json("DELETE", `/containers/${enc(n.egress)}`, { query: { force: true }, signal })
        .catch(ignore(404));
      await ensureSharedNetwork(signal);
      await ensureInternalNetwork(h.id, signal);
      await createEgress(h.id, plan.mode, plan.allowHosts, signal);
      // a suspended instance keeps its proxy stopped too
      if (!c.State.Running) {
        await api
          .json("POST", `/containers/${enc(n.egress)}/stop`, { query: { t: STOP_SECONDS }, signal })
          .catch(ignore(304, 404));
      }
      return "updated";
    },

    async suspend(h, signal) {
      signal.throwIfAborted();
      const n = sandboxResourceNames(h.id);
      for (const c of [n.container, n.egress]) {
        await api
          .json("POST", `/containers/${enc(c)}/stop`, { query: { t: STOP_SECONDS }, signal })
          .catch(ignore(304, 404));
      }
    },

    async destroy(h, signal) {
      await destroyByName(h.id, signal);
    },

    destroyByName,

    async killAll(h, signal) {
      signal.throwIfAborted();
      // 先确认容器在跑（停了就启动；不在抛 SandboxGoneError），再杀；杀进程的 exec 起不来时重启容器
      await autoStart(h, signal, () =>
        run(h.id, { cmd: ["true"], user: SANDBOX_USER, maxOutputBytes: 1024, signal }),
      );
      await killOrRestart(h.id, ["/bin/sh", "-c", KILL_ALL_SCRIPT, "capybara-killall"], signal);
    },

    async killTagged(h, tags, signal) {
      signal.throwIfAborted();
      for (const t of tags) {
        if (!SANDBOX_TAG_RE.test(t)) throw new Error("invalid sandbox tag");
      }
      if (tags.length === 0) return;
      // like killAll: the container must run first (started when stopped, SandboxGoneError when
      // missing); when the kill exec cannot start, the container restarts (siblings end too)
      await autoStart(h, signal, () =>
        run(h.id, { cmd: ["true"], user: SANDBOX_USER, maxOutputBytes: 1024, signal }),
      );
      await killOrRestart(
        h.id,
        ["/bin/sh", "-c", KILL_TAGGED_SCRIPT, "capybara-killtagged", ...tags],
        signal,
      );
    },

    // `args.actor` is informational in phase 1: not used for anything
    async exec(h, args): Promise<ExecResult> {
      args.signal.throwIfAborted();
      const ctl = execControlPath(args.tag);
      const env: string[] = [];
      for (const [k, v] of Object.entries(args.env ?? {})) {
        if (!ENV_KEY_RE.test(k)) throw new Error(`invalid environment variable name: ${k}`);
        env.push(`${k}=${v}`);
      }
      const r = await autoStart(h, args.signal, () =>
        run(h.id, {
          cmd: execArgv(ctl, args.command, args.timeoutMs),
          user: SANDBOX_USER,
          env,
          cwd: args.cwd ?? "/workspace",
          maxOutputBytes: args.maxOutputBytes,
          timeoutMs: args.timeoutMs,
          signal: args.signal,
          kill: killer(h.id, ctl),
        }),
      );
      return {
        exitCode: r.exitCode,
        stdout: decodeOutput(r.stdout, r.truncated),
        stderr: decodeOutput(r.stderr, r.truncated),
        truncated: r.truncated,
        timedOut: r.timedOut,
      };
    },

    async readFile(h, path, opts) {
      opts.signal.throwIfAborted();
      checkPath(path);
      const want = opts.maxBytes + 1;
      const r = await fileOp(
        h,
        {
          cmd: ["/bin/sh", "-c", READ_SCRIPT, "capybara-read", path, String(want)],
          user: SANDBOX_USER,
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
      const skills = path === "/skills" || path.startsWith("/skills/");
      const r = await fileOp(
        h,
        {
          cmd: [
            "/bin/sh",
            "-c",
            WRITE_SCRIPT,
            "capybara-write",
            skills ? `/opt/capybara${path}` : path,
            String(data.byteLength),
          ],
          user: skills ? ROOT_USER : SANDBOX_USER,
          stdin: data,
          maxOutputBytes: STDERR_ROOM,
        },
        signal,
      );
      if (r.exitCode !== 0) throw new Error(`cannot write ${path}: ${stderrOf(r)}`);
    },

    async stat(h, path, signal) {
      signal.throwIfAborted();
      checkPath(path);
      const r = await fileOp(
        h,
        {
          cmd: ["/bin/sh", "-c", STAT_SCRIPT, "capybara-stat", path],
          user: SANDBOX_USER,
          maxOutputBytes: STDERR_ROOM,
        },
        signal,
      );
      if (r.exitCode === 3) return null;
      const m = r.stdout.toString("utf8").match(/^(\d+) (.+)\n?$/);
      if (r.exitCode !== 0 || !m) throw new Error(`cannot stat ${path}: ${stderrOf(r)}`);
      return { size: Number(m[1]), isDir: m[2] === "directory" };
    },
  };
}

/**
 * 解码命令输出。被截断时先退回到完整的 UTF-8 字符边界（截断点落在多字节字符中间时丢掉残缺的尾巴），
 * 不在末尾留下替换字符。
 */
export function decodeOutput(buf: Buffer, truncated: boolean): string {
  let end = buf.byteLength;
  if (truncated) {
    // 从末尾往回找最后一个非续字节（10xxxxxx 之外），看它要求的长度是否完整
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
  if (l.egress === "allowlist") {
    for (const host of l.allowHosts) {
      const errors = validateAllowHost(host);
      if (errors.length > 0)
        throw new Error(`invalid allowHosts entry ${host}: ${errors.join("; ")}`);
    }
  }
}
