import { type IncomingMessage, request } from "node:http";
import type { Duplex } from "node:stream";

/**
 * 极简 Docker Engine HTTP API 客户端（node:http，无第三方依赖）：JSON 请求与 exec 的连接劫持（HTTP Upgrade）。
 * 只经 endpoint（socket 代理）访问，`tcp://host:port` 或 `unix:///path`。每个请求都带调用方的 AbortSignal。
 */

/** API 版本：Docker 25+（Docker 29 起最低支持 1.44）。 */
export const DOCKER_API_VERSION = "v1.44";

/** 响应体（错误消息、JSON）读取的上限。 */
const MAX_BODY_BYTES = 4 * 1024 * 1024;

/** Engine API 返回了非 2xx。 */
export class DockerApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "DockerApiError";
  }
}

export const isStatus = (e: unknown, ...status: number[]): boolean =>
  e instanceof DockerApiError && status.includes(e.status);

type Target = { socketPath: string } | { host: string; port: number };

/** `tcp://host:port` / `unix:///path` → node:http 的连接目标。 */
export function parseEndpoint(endpoint: string): Target {
  if (endpoint.startsWith("unix://")) {
    const socketPath = endpoint.slice("unix://".length);
    if (!socketPath.startsWith("/")) throw new Error(`invalid unix endpoint: ${endpoint}`);
    return { socketPath };
  }
  const m = endpoint.match(/^tcp:\/\/(\[[^\]]+\]|[^:/]+):(\d{1,5})\/?$/);
  if (!m)
    throw new Error(`invalid endpoint (expected tcp://host:port or unix:///path): ${endpoint}`);
  return { host: (m[1] as string).replace(/^\[|\]$/g, ""), port: Number(m[2]) };
}

export interface RequestOpts {
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  signal: AbortSignal;
}

function readBody(res: IncomingMessage, signal: AbortSignal): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const onAbort = () => {
      res.destroy();
      reject(abortReason(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    res.on("data", (c: Buffer) => {
      size += c.byteLength;
      if (size <= MAX_BODY_BYTES) chunks.push(c);
    });
    res.on("end", () => {
      signal.removeEventListener("abort", onAbort);
      resolve(Buffer.concat(chunks));
    });
    res.on("error", (e) => {
      signal.removeEventListener("abort", onAbort);
      reject(e);
    });
  });
}

export function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("aborted");
}

function errorMessage(status: number, body: Buffer): string {
  try {
    const j = JSON.parse(body.toString("utf8")) as { message?: unknown };
    if (typeof j.message === "string") return j.message;
  } catch {
    // 不是 JSON
  }
  return body.toString("utf8").trim() || `HTTP ${status}`;
}

export interface DockerClient {
  /** JSON 请求；2xx 返回解析后的 JSON（无内容为 undefined），否则抛 {@link DockerApiError}。 */
  json<T = unknown>(method: string, path: string, opts: RequestOpts): Promise<T>;
  /** POST 并劫持连接（exec 的 start）：返回双向的原始流。 */
  hijack(path: string, body: unknown, signal: AbortSignal): Promise<Duplex>;
}

export function createDockerClient(endpoint: string): DockerClient {
  const target = parseEndpoint(endpoint);
  const pathOf = (path: string, query?: RequestOpts["query"]) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined) qs.set(k, String(v));
    const s = qs.toString();
    return `/${DOCKER_API_VERSION}${path}${s === "" ? "" : `?${s}`}`;
  };

  return {
    json<T>(method: string, path: string, opts: RequestOpts): Promise<T> {
      opts.signal.throwIfAborted();
      const payload = opts.body === undefined ? undefined : Buffer.from(JSON.stringify(opts.body));
      return new Promise<T>((resolve, reject) => {
        const req = request({
          ...target,
          method,
          path: pathOf(path, opts.query),
          headers: {
            ...(payload && {
              "content-type": "application/json",
              "content-length": payload.byteLength,
            }),
          },
          signal: opts.signal,
        });
        req.on("error", (e) => reject(opts.signal.aborted ? abortReason(opts.signal) : e));
        req.on("response", (res) => {
          readBody(res, opts.signal).then((body) => {
            const status = res.statusCode ?? 0;
            if (status < 200 || status >= 300) {
              reject(new DockerApiError(status, errorMessage(status, body)));
              return;
            }
            const text = body.toString("utf8").trim();
            if (text === "") {
              resolve(undefined as T);
              return;
            }
            // 拉取镜像等接口返回逐行 JSON：逐行解析，遇到 {"error": …} 抛错，返回最后一行
            const lines = text.split("\n").filter((l) => l.trim() !== "");
            try {
              let last: unknown;
              for (const l of lines) {
                last = JSON.parse(l);
                const err = (last as { error?: unknown }).error;
                if (typeof err === "string") {
                  reject(new DockerApiError(500, err));
                  return;
                }
              }
              resolve(last as T);
            } catch {
              resolve(text as T);
            }
          }, reject);
        });
        req.end(payload);
      });
    },

    hijack(path: string, body: unknown, signal: AbortSignal): Promise<Duplex> {
      signal.throwIfAborted();
      const payload = Buffer.from(JSON.stringify(body));
      return new Promise<Duplex>((resolve, reject) => {
        const req = request({
          ...target,
          method: "POST",
          path: pathOf(path),
          headers: {
            "content-type": "application/json",
            "content-length": payload.byteLength,
            connection: "Upgrade",
            upgrade: "tcp",
          },
        });
        const onAbort = () => req.destroy(abortReason(signal));
        signal.addEventListener("abort", onAbort, { once: true });
        const done = () => signal.removeEventListener("abort", onAbort);
        req.on("error", (e) => {
          done();
          reject(signal.aborted ? abortReason(signal) : e);
        });
        req.on("upgrade", (_res, socket, head) => {
          done();
          if (head.byteLength > 0) socket.unshift(head);
          resolve(socket);
        });
        req.on("response", (res) => {
          done();
          readBody(res, AbortSignal.timeout(10_000)).then((b) => {
            const status = res.statusCode ?? 0;
            reject(new DockerApiError(status, errorMessage(status, b)));
          }, reject);
        });
        req.end(payload);
      });
    },
  };
}

/**
 * 拆 Docker 的多路复用流（无 TTY 的 exec 输出）：每帧 8 字节头 `[流类型, 0, 0, 0, 长度(大端 uint32)]`，
 * 流类型 1 是 stdout、2 是 stderr。
 */
export class StreamDemuxer {
  private buf: Buffer = Buffer.alloc(0);

  constructor(private readonly onFrame: (stream: 1 | 2, data: Buffer) => void) {}

  push(chunk: Buffer): void {
    this.buf = this.buf.byteLength === 0 ? chunk : Buffer.concat([this.buf, chunk]);
    while (this.buf.byteLength >= 8) {
      const size = this.buf.readUInt32BE(4);
      if (this.buf.byteLength < 8 + size) return;
      const kind = this.buf[0];
      const data = this.buf.subarray(8, 8 + size);
      this.buf = this.buf.subarray(8 + size);
      if (kind === 1 || kind === 2) this.onFrame(kind, data);
    }
  }
}
