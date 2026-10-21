/**
 * 极简 E2B 客户端（不用官方 `e2b` SDK，理由见 README「客户端」）：控制面 REST API 与沙箱里的 envd。
 *
 * 协议依据（2026-10-21 核实）：
 * - 官方 JS SDK `e2b@2.58.0`（npm，2026-10-20 发布）的 `dist/index.mjs`：
 *   - 控制面：请求头 `X-API-KEY`；`POST /v2/sandboxes`（`templateID`、`metadata`、`timeout` 秒、`autoPause`、
 *     `allow_internet_access`、`network.{allowOut,denyOut}`）、`POST /v2/sandboxes/{id}/connect`（`timeout`
 *     秒；暂停的沙箱会被恢复；404 = 不存在）、`POST /sandboxes/{id}/pause`（404 不存在、409 已暂停）、
 *     `DELETE /sandboxes/{id}`（404 不存在）、`GET /v2/sandboxes?metadata=&state=&limit=&nextToken=`
 *     （分页游标在响应头 `x-next-token`）；错误体 `{code, message}`；默认地址 `https://api.<domain>`。
 *   - envd（端口 49983）：地址 `https://49983-<沙箱 id>.<domain>`（SDK 的 `getSandboxDirectUrl`），请求头
 *     `E2b-Sandbox-Id`、`E2b-Sandbox-Port`、`X-Access-Token`（建沙箱 / connect 返回的 `envdAccessToken`）；
 *     命令走 Connect 协议（`process.Process/Start` 服务端流，JSON 编码 `application/connect+json`；
 *     `process.Process/SendSignal` 一元 JSON），用户经 `Authorization: Basic base64(<user>:)`；
 *     上传 `POST /files?path=&username=`（multipart 字段 `file`）。
 * - E2B 文档：出站控制 https://docs.e2b.dev/sandbox/internet-access（`allowInternetAccess`、`network.allowOut`
 *   支持域名与 `*.` 通配，须同时 `denyOut` 全部；域名只对 80 端口 Host 与 443 端口 SNI 生效）；暂停 / 恢复
 *   https://docs.e2b.dev/sandbox/persistence（pause 保留文件与内存，connect 自动恢复且只延长超时，暂停的沙箱无限期保留，
 *   `onTimeout: pause` 即 API 的 `autoPause`）；生命周期 https://docs.e2b.dev/sandbox（连续运行上限 Pro 24 小时）；
 *   模板 https://docs.e2b.dev/template/quickstart 、https://docs.e2b.dev/template/migration-v2（`fromDockerfile`，
 *   CPU / 内存在构建模板时给出）。
 * - envd 源码 https://github.com/e2b-dev/infra/blob/main/packages/envd/internal/api/upload.go：上传以 root 打开
 *   目标再 chown 给指定用户（不防符号链接），所以本插件只往 root 专用的中转目录上传，再以沙箱用户在沙箱里搬运。
 */

/** envd 端口。 */
export const ENVD_PORT = 49983;
/** 控制面请求的默认上限（毫秒；调用方的 signal 另外生效）。 */
const API_TIMEOUT_MS = 60_000;
/** envd 每隔多少秒发一次保活事件（官方 SDK 用 50）。 */
const KEEPALIVE_SECONDS = 50;

/** 控制面或 envd 返回的非 2xx。 */
export class E2BHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "E2BHttpError";
  }
}

export function isStatus(e: unknown, ...status: number[]): boolean {
  return e instanceof E2BHttpError && status.includes(e.status);
}

/** 调用方 signal 的中止原因（没有原因时给一个英文的 AbortError）。 */
export function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted", "AbortError");
}

/** 请求被调用方中止时，换成调用方的中止原因（而不是 fetch 的 AbortError）。 */
function rethrow(e: unknown, signal: AbortSignal): never {
  if (signal.aborted) throw abortReason(signal);
  throw e;
}

async function errorOf(res: Response, what: string): Promise<E2BHttpError> {
  let message = "";
  try {
    const text = await res.text();
    try {
      const j = JSON.parse(text) as { message?: unknown };
      message = typeof j.message === "string" ? j.message : text;
    } catch {
      message = text;
    }
  } catch {
    // 读不到正文
  }
  return new E2BHttpError(
    res.status,
    `E2B ${what} failed: HTTP ${res.status}${message ? `: ${message.slice(0, 300)}` : ""}`,
  );
}

export interface E2BApi {
  json<T>(
    method: string,
    path: string,
    opts: { body?: unknown; query?: Record<string, string | undefined>; signal: AbortSignal },
  ): Promise<{ status: number; data: T; headers: Headers }>;
}

/** 控制面 REST 客户端。 */
export function createE2BApi(apiUrl: string, apiKey: string): E2BApi {
  const base = apiUrl.replace(/\/+$/, "");
  return {
    async json(method, path, opts) {
      opts.signal.throwIfAborted();
      const url = new URL(base + path);
      for (const [k, v] of Object.entries(opts.query ?? {})) {
        if (v !== undefined) url.searchParams.set(k, v);
      }
      let res: Response;
      try {
        res = await fetch(url, {
          method,
          headers: {
            "X-API-KEY": apiKey,
            ...(opts.body !== undefined && { "content-type": "application/json" }),
          },
          ...(opts.body !== undefined && { body: JSON.stringify(opts.body) }),
          redirect: "error",
          signal: AbortSignal.any([opts.signal, AbortSignal.timeout(API_TIMEOUT_MS)]),
        });
      } catch (e) {
        rethrow(e, opts.signal);
      }
      if (!res.ok) throw await errorOf(res, `${method} ${path}`);
      const text = await res.text().catch((e: unknown) => rethrow(e, opts.signal));
      return {
        status: res.status,
        data: (text === "" ? undefined : JSON.parse(text)) as never,
        headers: res.headers,
      };
    },
  };
}

/** 一个沙箱的 envd 连接信息（每次操作前经 connect 取得）。 */
export interface EnvdTarget {
  /** envd 基址（不带结尾斜杠）。 */
  url: string;
  sandboxId: string;
  accessToken?: string | undefined;
}

/** envd 的进程事件（Connect JSON：字段按 proto3 JSON 规则，取默认值的字段省略）。 */
export type ProcessEvent =
  | { start: { pid?: number } }
  | { data: { stdout?: string; stderr?: string } }
  | { end: { exitCode?: number; exited?: boolean; status?: string; error?: string } }
  | { keepalive: Record<string, never> };

export interface StartRequest {
  cmd: string;
  args: string[];
  envs?: Record<string, string>;
  cwd?: string;
}

const basic = (user: string) => `Basic ${Buffer.from(`${user}:`).toString("base64")}`;

function envdHeaders(t: EnvdTarget, extra: Record<string, string> = {}): Record<string, string> {
  return {
    "E2b-Sandbox-Id": t.sandboxId,
    "E2b-Sandbox-Port": String(ENVD_PORT),
    ...(t.accessToken && { "X-Access-Token": t.accessToken }),
    ...extra,
  };
}

/** Connect 信封：1 字节标志 + 4 字节大端长度 + 消息。 */
function envelope(msg: unknown): Uint8Array {
  const json = Buffer.from(JSON.stringify(msg), "utf8");
  const out = Buffer.alloc(5 + json.byteLength);
  out.writeUInt8(0, 0);
  out.writeUInt32BE(json.byteLength, 1);
  json.copy(out, 5);
  return out;
}

/** 以 root 上传到沙箱里的 `path`（multipart）。 */
export async function envdUpload(
  t: EnvdTarget,
  path: string,
  user: string,
  data: Uint8Array,
  signal: AbortSignal,
): Promise<void> {
  const url = new URL(`${t.url}/files`);
  url.searchParams.set("path", path);
  url.searchParams.set("username", user);
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(data)]), path.split("/").pop() ?? "file");
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: envdHeaders(t),
      body: form,
      redirect: "error",
      signal,
    });
  } catch (e) {
    rethrow(e, signal);
  }
  if (!res.ok) throw await errorOf(res, "file upload");
  await res.body?.cancel().catch(() => undefined);
}

/** 给进程发 SIGKILL（envd 按 pid）。进程已不在（404）也算成功。 */
export async function envdKill(t: EnvdTarget, pid: number, signal: AbortSignal): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`${t.url}/process.Process/SendSignal`, {
      method: "POST",
      headers: envdHeaders(t, {
        "content-type": "application/json",
        "Connect-Protocol-Version": "1",
      }),
      body: JSON.stringify({ process: { pid }, signal: "SIGNAL_SIGKILL" }),
      redirect: "error",
      signal,
    });
  } catch (e) {
    rethrow(e, signal);
  }
  if (res.status === 404) {
    await res.body?.cancel().catch(() => undefined);
    return;
  }
  if (!res.ok) throw await errorOf(res, "process signal");
  await res.body?.cancel().catch(() => undefined);
}

/**
 * 启动进程并读事件流（`process.Process/Start`）。每个事件回调一次；流正常结束返回，Connect 结尾帧里的错误、
 * 非 200 或连接中断抛错。`signal` 中止时断开连接（**不会**结束沙箱里的进程，要另外杀）。
 */
export async function envdStart(
  t: EnvdTarget,
  user: string,
  req: StartRequest,
  onEvent: (e: ProcessEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`${t.url}/process.Process/Start`, {
      method: "POST",
      headers: envdHeaders(t, {
        "content-type": "application/connect+json",
        "Connect-Protocol-Version": "1",
        Authorization: basic(user),
        "Keepalive-Ping-Interval": String(KEEPALIVE_SECONDS),
      }),
      body: envelope({ process: req, stdin: false }),
      redirect: "error",
      signal,
    });
  } catch (e) {
    rethrow(e, signal);
  }
  if (res.status !== 200 || !res.body) throw await errorOf(res, "process start");
  const reader = res.body.getReader();
  let buf = Buffer.alloc(0);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf = buf.byteLength === 0 ? Buffer.from(value) : Buffer.concat([buf, value]);
      while (buf.byteLength >= 5) {
        const len = buf.readUInt32BE(1);
        if (buf.byteLength < 5 + len) break;
        const flags = buf.readUInt8(0);
        const msg = JSON.parse(buf.subarray(5, 5 + len).toString("utf8")) as {
          event?: ProcessEvent;
          error?: { code?: string; message?: string };
        };
        buf = buf.subarray(5 + len);
        if (flags & 0x02) {
          if (msg.error) {
            throw new Error(
              `E2B process stream failed: ${msg.error.code ?? "unknown"}: ${msg.error.message ?? ""}`,
            );
          }
          return;
        }
        if (msg.event) onEvent(msg.event);
      }
    }
  } catch (e) {
    await reader.cancel().catch(() => undefined);
    rethrow(e, signal);
  }
  throw new Error("E2B process stream ended without an end-of-stream message");
}
