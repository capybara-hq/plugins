import Anthropic from "@anthropic-ai/sdk";
import { isModelError, ModelError, type ModelErrorKind } from "@capybara-hq/plugin-sdk";

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

/** 按 API 返回的错误 `type` 分类（流中途的 error 事件没有 HTTP 状态码，只能看 type）。 */
function kindFromType(type: string | null | undefined): ModelErrorKind | null {
  switch (type) {
    case "rate_limit_error":
      return "rate_limited";
    case "overloaded_error":
      return "overloaded";
    case "api_error":
      return "server";
    case "timeout_error":
      return "timeout";
    case "authentication_error":
    case "permission_error":
    case "billing_error":
      return "auth";
    case "request_too_large":
      return "context_overflow";
    case "invalid_request_error":
    case "not_found_error":
      return "invalid_request";
    default:
      return null;
  }
}

/**
 * SDK 异常 → ModelError。只按异常类、HTTP 状态码与 API 错误 `type` 判断，不匹配错误信息字符串。
 * `signal` 已中止时一律视为 aborted（中止后 SDK 可能抛出连接类错误）。
 */
export function toModelError(e: unknown, signal?: AbortSignal): ModelError {
  if (isModelError(e)) return e as ModelError;
  const message = e instanceof Error ? e.message : String(e);
  const make = (kind: ModelErrorKind, extra?: { retryAfterMs?: number }) =>
    new ModelError(kind, `Anthropic: ${message}`, { cause: e, ...extra });

  if (signal?.aborted || e instanceof Anthropic.APIUserAbortError) {
    return new ModelError("aborted", "Request aborted", { cause: e });
  }
  if (e instanceof Anthropic.APIConnectionTimeoutError) return make("timeout");
  if (e instanceof Anthropic.APIConnectionError) return make("network");
  if (e instanceof Anthropic.RateLimitError) {
    const ms = retryAfterMs(e.headers);
    return make("rate_limited", ms !== undefined ? { retryAfterMs: ms } : undefined);
  }
  if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) {
    return make("auth");
  }
  if (e instanceof Anthropic.BadRequestError) {
    // Anthropic 目前没有专门的「超出上下文」错误 type；仅 type 明确时才归为 context_overflow
    return make(
      kindFromType(e.type) === "context_overflow" ? "context_overflow" : "invalid_request",
    );
  }
  if (e instanceof Anthropic.APIError) {
    const status = e.status;
    if (status === 529 || e.type === "overloaded_error") return make("overloaded");
    if (status === 413) return make("context_overflow");
    if (status === 408) return make("timeout");
    if (status === 429) return make("rate_limited");
    if (typeof status === "number" && status >= 500) return make("server");
    if (typeof status === "number" && status >= 400)
      return make(kindFromType(e.type) ?? "invalid_request");
    // 无状态码：流中途的 error 事件
    return make(kindFromType(e.type) ?? "server");
  }
  return make("server");
}
