import { createHash } from "node:crypto";

/**
 * Lark OpenAPI 的最小客户端（发 / 回 / 改消息、机器人信息、企业信息、用户资料）。
 *
 * 为什么不用 SDK 的 `Client`：长连接用官方 SDK 的 `WSClient`（D8），但 REST 调用需要逐次的 AbortSignal 与超时、
 * 只带错误码的错误（SDK 的 axios 错误带着请求配置，其中有 `Authorization` 头），以及按凭据隔离、可失效重取的
 * tenant token 缓存（SDK 默认把 token 放进模块级缓存，只按 appId 分区：轮换 secret 后仍用旧 token）。
 *
 * tenant_access_token（https://open.larksuite.com/document/ukTMukTMukTM/ukDNz4SO0MjL5QzM/auth-v3/auth/tenant_access_token_internal ，
 * 2026-10-20 查阅）：最长有效 2 小时，剩余不足 30 分钟时再取会得到新 token（新旧同时有效）。缓存到「过期前 3 分钟」
 * （与 SDK 相同）；接口回 token 无效（99991663 / 99991665 / 99991677）时丢掉缓存、重取一次再试。
 * 缓存在渠道实例的闭包里（纯性能缓存，不是共享状态），键为 appId + secret 的哈希。
 *
 * 限流（https://open.larksuite.com/document/ukTMukTMukTM/uUzN04SN3QjL1cDN ，2026-10-20 查阅）：HTTP 429（旧接口为 400）
 * + `code: 99991400`，响应头 `x-ogw-ratelimit-reset` 为建议等待的秒数。
 */

export interface LarkCredentials {
  appId: string;
  appSecret: string;
}

/** OpenAPI 返回了错误（HTTP 非 2xx 或 `code ≠ 0`）。消息只带错误码与 HTTP 状态。 */
export class LarkApiError extends Error {
  readonly status: number;
  readonly code?: number;
  readonly retryAfterMs?: number;

  constructor(opts: { status: number; code?: number; retryAfterMs?: number }) {
    super(
      opts.code !== undefined
        ? `Lark API error ${opts.code} (HTTP ${opts.status})`
        : `Lark API returned HTTP ${opts.status}`,
    );
    this.name = "LarkApiError";
    this.status = opts.status;
    if (opts.code !== undefined) this.code = opts.code;
    if (opts.retryAfterMs !== undefined) this.retryAfterMs = opts.retryAfterMs;
  }
}

/** 网络错误 / 超时 / 响应不是 JSON。 */
export class LarkNetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LarkNetworkError";
  }
}

const TOKEN_INVALID: Record<number, true> = { 99991663: true, 99991665: true, 99991677: true };
const TOKEN_EARLY_MS = 3 * 60_000;

export interface LarkCallOptions {
  method?: "GET" | "POST" | "PATCH" | "PUT";
  query?: Record<string, string>;
  body?: unknown;
  signal: AbortSignal;
  /** 整次调用的时限（含取 token 与 token 失效后的重试；默认按单次请求取客户端的 timeoutMs）。 */
  timeoutMs?: number;
}

export interface LarkApi {
  /** 带 tenant token 调 OpenAPI，返回响应体（已确认 `code === 0`）。 */
  call<T = Record<string, unknown>>(
    creds: LarkCredentials,
    path: string,
    opts: LarkCallOptions,
  ): Promise<T>;
  /** 取（缓存的）tenant token；凭据错误时抛 {@link LarkApiError}（如 10014 app id 不存在、10015 secret 错误）。 */
  token(creds: LarkCredentials, signal: AbortSignal): Promise<string>;
}

export function createLarkApi(opts: { baseUrl: string; timeoutMs?: number }): LarkApi {
  const base = opts.baseUrl.replace(/\/+$/, "");
  const defaultTimeout = opts.timeoutMs ?? 15_000;
  const tokens = new Map<string, { token: string; expiresAt: number }>();
  /** 进行中的取 token 请求（同一凭据的并发调用共用一次）。 */
  const inflight = new Map<string, Promise<string>>();
  const keyOf = (c: LarkCredentials) =>
    `${c.appId}\u0000${createHash("sha256").update(c.appSecret).digest("hex").slice(0, 32)}`;

  /**
   * 发一次请求。`budget` 是整次调用的时限（如查资料的 1 秒，含取 token 与重试）；没有时按单次请求超时。
   * 调用方的 signal 中止时原样抛出中止；时限到了抛 {@link LarkNetworkError}。
   */
  async function request<T>(
    path: string,
    o: LarkCallOptions,
    token?: string,
    budget?: AbortSignal,
  ): Promise<T> {
    const url = new URL(`${base}${path}`);
    for (const [k, v] of Object.entries(o.query ?? {})) url.searchParams.set(k, v);
    const signal = AbortSignal.any([o.signal, budget ?? AbortSignal.timeout(defaultTimeout)]);
    let res: Response;
    try {
      res = await fetch(url, {
        method: o.method ?? "GET",
        headers: {
          ...(o.body !== undefined && { "content-type": "application/json; charset=utf-8" }),
          ...(token !== undefined && { authorization: `Bearer ${token}` }),
        },
        ...(o.body !== undefined && { body: JSON.stringify(o.body) }),
        signal,
        redirect: "error",
      });
    } catch (e) {
      if (o.signal.aborted) throw e;
      throw new LarkNetworkError(
        signal.aborted ? "Lark API request timed out" : "Lark API request failed (network)",
      );
    }
    const reset = Number(res.headers.get("x-ogw-ratelimit-reset"));
    const retryAfterMs = Number.isFinite(reset) && reset > 0 ? reset * 1000 : undefined;
    let body: Record<string, unknown> | undefined;
    try {
      body = (await res.json()) as Record<string, unknown>;
    } catch {
      body = undefined;
    }
    const code = typeof body?.code === "number" ? body.code : undefined;
    if (!res.ok || code !== 0) {
      throw new LarkApiError({
        status: res.status,
        ...(code !== undefined && { code }),
        ...(retryAfterMs !== undefined && { retryAfterMs }),
      });
    }
    return body as T;
  }

  /** 取一次 token 并写缓存（不跟任何调用方的 signal：同一凭据的并发调用共用这一次请求）。 */
  async function fetchToken(creds: LarkCredentials, key: string): Promise<string> {
    const r = await request<{ tenant_access_token?: unknown; expire?: unknown }>(
      "/open-apis/auth/v3/tenant_access_token/internal",
      {
        method: "POST",
        body: { app_id: creds.appId, app_secret: creds.appSecret },
        signal: new AbortController().signal,
      },
    );
    if (typeof r.tenant_access_token !== "string" || r.tenant_access_token === "") {
      throw new LarkApiError({ status: 200 });
    }
    const expire = typeof r.expire === "number" ? r.expire : 7200;
    tokens.set(key, {
      token: r.tenant_access_token,
      expiresAt: Date.now() + expire * 1000 - TOKEN_EARLY_MS,
    });
    if (tokens.size > 1000) {
      const oldest = tokens.keys().next().value;
      if (oldest !== undefined) tokens.delete(oldest);
    }
    return r.tenant_access_token;
  }

  /** 等共用的取 token 请求，但只等到调用方中止或时限到（共用的请求本身不受影响）。 */
  function within<T>(p: Promise<T>, signal: AbortSignal, budget?: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const stop = () => {
        signal.removeEventListener("abort", stop);
        budget?.removeEventListener("abort", stop);
        if (signal.aborted) reject(signal.reason);
        else reject(new LarkNetworkError("Lark API request timed out"));
      };
      if (signal.aborted || budget?.aborted) return stop();
      signal.addEventListener("abort", stop, { once: true });
      budget?.addEventListener("abort", stop, { once: true });
      p.then(
        (v) => {
          signal.removeEventListener("abort", stop);
          budget?.removeEventListener("abort", stop);
          resolve(v);
        },
        (e: unknown) => {
          signal.removeEventListener("abort", stop);
          budget?.removeEventListener("abort", stop);
          reject(e);
        },
      );
    });
  }

  async function token(
    creds: LarkCredentials,
    signal: AbortSignal,
    budget?: AbortSignal,
  ): Promise<string> {
    const key = keyOf(creds);
    const hit = tokens.get(key);
    if (hit && hit.expiresAt > Date.now()) return hit.token;
    let p = inflight.get(key);
    if (!p) {
      p = fetchToken(creds, key);
      inflight.set(key, p);
      const mine = p;
      void mine
        .finally(() => {
          if (inflight.get(key) === mine) inflight.delete(key);
        })
        .catch(() => {});
    }
    return within(p, signal, budget);
  }

  return {
    token: (creds, signal) => token(creds, signal),
    async call<T>(creds: LarkCredentials, path: string, o: LarkCallOptions): Promise<T> {
      const budget = o.timeoutMs !== undefined ? AbortSignal.timeout(o.timeoutMs) : undefined;
      const t = await token(creds, o.signal, budget);
      try {
        return await request<T>(path, o, t, budget);
      } catch (e) {
        if (!(e instanceof LarkApiError) || e.code === undefined || !TOKEN_INVALID[e.code]) throw e;
        if (tokens.get(keyOf(creds))?.token === t) tokens.delete(keyOf(creds));
        return request<T>(path, o, await token(creds, o.signal, budget), budget);
      }
    },
  };
}
