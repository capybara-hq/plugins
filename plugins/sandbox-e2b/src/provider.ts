import { randomUUID } from "node:crypto";
import {
  type ExecResult,
  type Logger,
  SandboxGoneError,
  type SandboxLimits,
  type SandboxProvider,
  validateAllowHost,
  validateSandboxPath,
} from "@capybara-hq/plugin-sdk";
import {
  abortReason,
  createE2BApi,
  ENVD_PORT,
  type EnvdTarget,
  envdKill,
  envdStart,
  envdUpload,
  isStatus,
  type StartRequest,
} from "./e2b-api.js";

/** 部署配置（见 index.ts 的 DeploymentConfig）。 */
export interface E2BSandboxConfig {
  apiKey: string;
  /** 控制面 API 地址；不填为 `https://api.<domain>`。 */
  apiUrl?: string | undefined;
  /** 沙箱域名（API 返回了沙箱自己的域名时以返回的为准）。 */
  domain: string;
  template: string;
  /** 沙箱超时（秒）：到点 E2B 自动暂停。 */
  timeoutSeconds: number;
  /** E2B 支持按域名的出站白名单；false 时 allowlist 退化为 none 并打告警。 */
  domainAllowlist: boolean;
  /** 允许 `egress: "open"`。 */
  allowOpenEgress: boolean;
}

/**
 * **仅测试**的选项：只有直接调用 {@link createE2BSandbox} 的代码能传，插件的部署配置设不了（index.ts 的
 * 部署配置 schema 是 strict）。
 */
export interface E2BSandboxTestOptions {
  /** envd 地址改为这个（假 E2B 按 `E2b-Sandbox-Id` 请求头路由），不按沙箱 id 与域名拼。 */
  envdUrl?: string;
}

/** 沙箱上记名字的元数据键（`create` 的 name，`cap-<conversationId>`）；按它列出 / 清理同名实例。 */
export const METADATA_NAME = "capybara-sandbox-name";

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
/** 列出同名沙箱时每页条数。 */
const LIST_LIMIT = 100;

const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,100}$/;
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** E2B 沙箱 id（拼进 envd 主机名与 API 路径前先校验）。 */
const SANDBOX_ID_RE = /^[a-zA-Z0-9-]{1,128}$/;

/**
 * 命令包装：在新会话里跑（setsid），先把会话 id 写到 `<ctl>.pid`，再看有没有 `<ctl>.kill`（杀的请求先到）；
 * 中止时按会话杀掉命令派生的全部进程。`$0` 是标记、`$1` 是 ctl、`$2` 是命令。与 sandbox-docker 相同。
 */
const EXEC_WRAPPER =
  'c=$1; echo $$ > "$c.pid" 2>/dev/null; if [ -e "$c.kill" ]; then exit 137; fi; ' +
  '/bin/bash -c "$2"; s=$?; rm -f "$c.pid"; exit $s';

/**
 * 杀掉 ctl 对应的命令：先留 `.kill` 标记，等会话 id，按进程组与会话 SIGKILL；再按命令行兜底。
 * 找到了会话 id（命令确实已启动）才删 `.kill` 标记；没找到时留着，防止包装稍后才启动。
 */
const KILL_SCRIPT =
  'c=$1; : > "$c.kill" 2>/dev/null; i=0; ' +
  'while [ ! -s "$c.pid" ] && [ $i -lt 20 ]; do sleep 0.05; i=$((i+1)); done; ' +
  'p=$(cat "$c.pid" 2>/dev/null); ' +
  'if [ -n "$p" ]; then kill -9 -"$p" 2>/dev/null; pkill -9 -s "$p" 2>/dev/null; rm -f "$c.kill"; fi; ' +
  'for q in $(pgrep -f -- "capybara-exec $c"); do ' +
  'kill -9 -"$q" 2>/dev/null; pkill -9 -s "$q" 2>/dev/null; kill -9 "$q" 2>/dev/null; done; ' +
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

/** `ms` 毫秒后调用 `fn`（本次调用内的短暂等待；用 AbortSignal.timeout，不用进程级定时器 API）。 */
function after(ms: number, fn: () => void): { cancel(): void } {
  const t = AbortSignal.timeout(ms);
  t.addEventListener("abort", fn, { once: true });
  return { cancel: () => t.removeEventListener("abort", fn) };
}

function checkPath(p: string): void {
  const errors = validateSandboxPath(p);
  if (errors.length > 0)
    throw new Error(`invalid sandbox path ${JSON.stringify(p)}: ${errors.join("; ")}`);
}

interface RunOpts {
  user: string;
  cmd: string;
  args: string[];
  env?: Record<string, string>;
  cwd?: string;
  /** stdout + stderr 合计最多收集的字节。 */
  maxOutputBytes: number;
  timeoutMs?: number;
  signal: AbortSignal;
  /** 超时 / 中止时杀进程（不给则只断开连接）。 */
  kill?: (pid: number | undefined) => Promise<void>;
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
}

/** 按 E2B 的 sandbox@1 约定建提供方（插件 setup 与测试共用）。 */
export function createE2BSandbox(
  cfg: E2BSandboxConfig,
  deps: { log: Logger },
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
    return {
      url: test.envdUrl ?? `https://${ENVD_PORT}-${info.sandboxID}.${domain}`,
      sandboxId: info.sandboxID,
      accessToken: info.envdAccessToken ?? undefined,
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
    try {
      const r = await api.json<SandboxInfo>("POST", `/v2/sandboxes/${enc(id)}/connect`, {
        body: { timeout },
        signal,
      });
      return targetOf({ ...r.data, sandboxID: r.data?.sandboxID ?? id });
    } catch (e) {
      if (isStatus(e, 404)) {
        throw new SandboxGoneError(`E2B sandbox ${id} no longer exists`, { cause: e });
      }
      throw e;
    }
  };

  const destroyByName = async (name: string, signal: AbortSignal) => {
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
            state: "running,paused",
            limit: String(LIST_LIMIT),
            nextToken,
          },
          signal,
        },
      );
      for (const s of r.data ?? []) {
        // 服务端已按元数据过滤；再核对一次，绝不误删别的沙箱
        if (s.metadata?.[METADATA_NAME] === name) ids.push(s.sandboxID);
      }
      nextToken = r.headers.get("x-next-token") || undefined;
    } while (nextToken);
    for (const id of ids) await kill(id, signal);
  };

  const kill = async (id: string, signal: AbortSignal) => {
    checkId(id);
    try {
      await api.json("DELETE", `/sandboxes/${enc(id)}`, { signal });
    } catch (e) {
      if (!isStatus(e, 404)) throw e;
    }
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
    let exitCode: number | undefined;
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
    const stop = () => {
      if (stopping) return;
      stopping = true;
      const cut = () => {
        grace = after(KILL_GRACE_MS, () => conn.abort());
      };
      if (o.kill)
        killing = o
          .kill(pid)
          .catch(() => undefined)
          .finally(cut);
      else conn.abort();
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
    try {
      await envdStart(
        t,
        o.user,
        req,
        (e) => {
          if ("start" in e) pid = e.start.pid;
          else if ("data" in e) {
            if (e.data.stdout) collect("out", e.data.stdout);
            if (e.data.stderr) collect("err", e.data.stderr);
          } else if ("end" in e) exitCode = e.end.exitCode ?? 0;
        },
        conn.signal,
      );
    } catch (e) {
      streamError = e;
    }
    // 杀进程完成后才返回：调用方接着用沙箱时它已结束
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
    if (streamError !== undefined) throw streamError;
    if (exitCode === undefined) throw new Error("E2B process stream ended without an exit status");
    return { ...result, exitCode };
  }

  /**
   * 杀掉一条命令：以沙箱用户跑杀进程脚本（按会话杀掉它派生的全部进程），再按 pid 让 envd 发 SIGKILL 兜底
   * （脚本起不来时，至少结束会话首进程）。不受调用方 signal 影响（它往往正是已中止的那个）。
   */
  const killer = (t: EnvdTarget, ctl: string) => async (pid: number | undefined) => {
    await run(t, {
      user: SANDBOX_USER,
      cmd: "/bin/sh",
      args: ["-c", KILL_SCRIPT, "capybara-kill", ctl],
      maxOutputBytes: 4096,
      timeoutMs: 15_000,
      signal: AbortSignal.timeout(20_000),
    }).catch(() => undefined);
    if (pid !== undefined)
      await envdKill(t, pid, AbortSignal.timeout(15_000)).catch(() => undefined);
  };

  /** 文件操作：connect 后跑一个小脚本；被中止就以中止原因失败。 */
  const fileOp = async (
    t: EnvdTarget,
    o: Omit<RunOpts, "signal" | "kill" | "cmd" | "timeoutMs">,
    signal: AbortSignal,
  ): Promise<RunResult> => {
    const r = await run(t, { ...o, cmd: "/bin/sh", timeoutMs: FILE_OP_TIMEOUT_MS, signal });
    if (r.aborted) throw abortReason(signal);
    if (r.timedOut) throw new Error("sandbox file operation timed out");
    return r;
  };

  const stderrOf = (r: RunResult) => r.stderr.toString("utf8").trim().slice(0, 500);

  // ---------- 契约 ----------

  return {
    async create({ name, limits, signal }) {
      signal.throwIfAborted();
      if (!NAME_RE.test(name)) throw new Error(`invalid sandbox name: ${name}`);
      checkLimits(limits);
      if (limits.egress === "open" && !cfg.allowOpenEgress) {
        throw new Error(
          'sandbox egress "open" is disabled for this deployment (sandbox-e2b allowOpenEgress is false); use "allowlist" or "none"',
        );
      }
      let egress = limits.egress;
      if (egress === "allowlist" && !cfg.domainAllowlist) {
        deps.log.warn(
          "sandbox-e2b: domain allowlists are disabled for this deployment (domainAllowlist is false); egress allowlist degraded to none",
          { name },
        );
        egress = "none";
      }
      // 同名的旧实例（内核在记下句柄前退出等）：整个换掉
      await destroyByName(name, signal);
      const network =
        egress === "allowlist" && limits.allowHosts.length > 0
          ? { network: { allowOut: [...limits.allowHosts], denyOut: ["0.0.0.0/0"] } }
          : { allow_internet_access: egress === "open" };
      const r = await api.json<SandboxInfo>("POST", "/v2/sandboxes", {
        body: {
          templateID: cfg.template,
          metadata: { [METADATA_NAME]: name },
          timeout: cfg.timeoutSeconds,
          // 到点自动暂停而不是删除：内核来不及 suspend（如内核整个挂了）时文件也不丢
          autoPause: true,
          ...network,
        },
        signal,
      });
      if (!r.data?.sandboxID) throw new Error("E2B create sandbox returned no sandboxID");
      checkId(r.data.sandboxID);
      return { id: r.data.sandboxID };
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
      checkId(h.id);
      try {
        await api.json("POST", `/sandboxes/${enc(h.id)}/pause`, { body: {}, signal });
      } catch (e) {
        // 不存在（404）、已暂停（409）都算成功
        if (!isStatus(e, 404, 409)) throw e;
      }
    },

    async destroy(h, signal) {
      signal.throwIfAborted();
      await kill(h.id, signal);
    },

    destroyByName,

    async exec(h, args): Promise<ExecResult> {
      args.signal.throwIfAborted();
      const env: Record<string, string> = { HOME: "/workspace", LANG: "C.UTF-8" };
      for (const [k, v] of Object.entries(args.env ?? {})) {
        if (!ENV_KEY_RE.test(k)) throw new Error(`invalid environment variable name: ${k}`);
        env[k] = v;
      }
      const t = await attach(
        h.id,
        args.signal,
        Math.ceil(args.timeoutMs / 1000) + TIMEOUT_MARGIN_SECONDS,
      );
      const ctl = `/tmp/.capybara-exec-${randomUUID()}`;
      const r = await run(t, {
        user: SANDBOX_USER,
        cmd: "setsid",
        args: ["-w", "/bin/sh", "-c", EXEC_WRAPPER, "capybara-exec", ctl, args.command],
        env,
        cwd: args.cwd ?? "/workspace",
        maxOutputBytes: args.maxOutputBytes,
        timeoutMs: args.timeoutMs,
        signal: args.signal,
        kill: killer(t, ctl),
      });
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
  };
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
  if (l.egress === "allowlist") {
    for (const host of l.allowHosts) {
      const errors = validateAllowHost(host);
      if (errors.length > 0)
        throw new Error(`invalid allowHosts entry ${host}: ${errors.join("; ")}`);
    }
  }
}
