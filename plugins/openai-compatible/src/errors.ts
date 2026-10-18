import { isModelError, ModelError, type ModelErrorKind } from "@capybara-hq/plugin-sdk";
import OpenAI from "openai";

/*
 * 错误映射沿用 openai 插件（plugins/openai/src/errors.ts）的规则：只按 SDK 异常类、HTTP 状态码与
 * 结构化错误 `code` 判断，不匹配错误信息字符串。插件之间不互相 import，所以这里是一份改编的副本，
 * 另补兼容服务常见的状态码：402（DeepSeek 余额不足，重试无用）→ auth；503（DeepSeek「Server Overloaded」）→ overloaded。
 */

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

/** 按结构化错误 `code` 分类（OpenAI 风格的 code，兼容服务多数沿用）；未知 code 返回 null。 */
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
      return code.startsWith("invalid_") ? "invalid_request" : null;
  }
}

/**
 * SDK 异常 → ModelError。`signal` 已中止时一律视为 aborted（中止后 SDK 可能抛出连接类错误）。
 */
export function toModelError(e: unknown, signal?: AbortSignal): ModelError {
  if (isModelError(e)) return e as ModelError;
  const message = e instanceof Error ? e.message : String(e);
  const make = (kind: ModelErrorKind, extra?: { retryAfterMs?: number }) =>
    new ModelError(kind, `OpenAI-compatible: ${message}`, { cause: e, ...extra });

  if (signal?.aborted || e instanceof OpenAI.APIUserAbortError) {
    return new ModelError("aborted", "Request aborted", { cause: e });
  }
  if (e instanceof OpenAI.APIConnectionTimeoutError) return make("timeout");
  if (e instanceof OpenAI.APIConnectionError) return make("network");
  if (e instanceof OpenAI.RateLimitError) {
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
  if (e instanceof OpenAI.APIError) {
    const status = e.status;
    if (status === 402) return make("auth");
    if (status === 408) return make("timeout");
    if (status === 413) return make("context_overflow");
    if (status === 503) return make("overloaded");
    if (typeof status === "number" && status >= 500) return make("server");
    if (typeof status === "number" && status >= 400)
      return make(kindFromCode(e.code) ?? "invalid_request");
    // 无状态码：流中途的 error 事件
    return make(kindFromCode(e.code) ?? "server");
  }
  return make("server");
}
