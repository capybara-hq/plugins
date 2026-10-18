import { isModelError, ModelError, type ModelErrorKind } from "@capybara-hq/plugin-sdk";
import OpenAI from "openai";

/** `retry-after-ms`（毫秒）优先，其次 `retry-after`（秒或 HTTP 日期）。 */
function retryAfterMs(headers: Headers | undefined): number | undefined {
  if (headers === undefined) return undefined;
  const ms = headers.get("retry-after-ms");
  if (ms !== null && ms.trim() !== "" && Number.isFinite(Number(ms)))
    return Math.max(0, Number(ms));
  const ra = headers.get("retry-after");
  if (ra === null || ra.trim() === "") return undefined;
  const secs = Number(ra);
  if (Number.isFinite(secs)) return Math.max(0, Math.round(secs * 1000));
  const at = Date.parse(ra);
  return Number.isNaN(at) ? undefined : Math.max(0, at - Date.now());
}

/**
 * 按结构化错误 `code` 分类：流中途的 error 事件与 `response.failed` 没有 HTTP 状态码，只能看 code。
 * 未知 code 返回 null，由调用方决定默认值。
 */
export function kindFromCode(code: string | null | undefined): ModelErrorKind | null {
  switch (code) {
    case "rate_limit_exceeded":
      return "rate_limited";
    case "server_error":
      return "server";
    case "context_length_exceeded":
      return "context_overflow";
    case "insufficient_quota":
    case "invalid_api_key":
      return "auth";
    case null:
    case undefined:
      return null;
    default:
      // 其余已知 code（invalid_prompt、invalid_image 等）都是请求本身的问题
      return code.startsWith("invalid_") || code.startsWith("image_") ? "invalid_request" : null;
  }
}

/**
 * SDK 异常 → ModelError。只按异常类、HTTP 状态码与结构化错误 `code` 判断，不匹配错误信息字符串。
 * `signal` 已中止时一律视为 aborted（中止后 SDK 可能抛出连接类错误）。
 */
export function toModelError(e: unknown, signal?: AbortSignal): ModelError {
  if (isModelError(e)) return e as ModelError;
  const message = e instanceof Error ? e.message : String(e);
  const make = (kind: ModelErrorKind, extra?: { retryAfterMs?: number }) =>
    new ModelError(kind, `OpenAI: ${message}`, { cause: e, ...extra });

  if (signal?.aborted || e instanceof OpenAI.APIUserAbortError) {
    return new ModelError("aborted", "Request aborted", { cause: e });
  }
  if (e instanceof OpenAI.APIConnectionTimeoutError) return make("timeout");
  if (e instanceof OpenAI.APIConnectionError) return make("network");
  if (e instanceof OpenAI.RateLimitError) {
    // 额度用尽同样是 429，但重试无用
    if (e.code === "insufficient_quota") return make("auth");
    const ms = retryAfterMs(e.headers);
    return make("rate_limited", ms !== undefined ? { retryAfterMs: ms } : undefined);
  }
  if (e instanceof OpenAI.AuthenticationError || e instanceof OpenAI.PermissionDeniedError) {
    return make("auth");
  }
  if (e instanceof OpenAI.BadRequestError) {
    return make(e.code === "context_length_exceeded" ? "context_overflow" : "invalid_request");
  }
  if (e instanceof OpenAI.InternalServerError) return make("server");
  if (e instanceof OpenAI.APIError) {
    const status = e.status;
    if (status === 408) return make("timeout");
    if (status === 413) return make("context_overflow");
    if (typeof status === "number" && status >= 500) return make("server");
    if (typeof status === "number" && status >= 400)
      return make(kindFromCode(e.code) ?? "invalid_request");
    // 无状态码：流中途的 error 事件
    return make(kindFromCode(e.code) ?? "server");
  }
  return make("server");
}
