import { isModelError, ModelError, type ModelErrorKind } from "@capybara-hq/plugin-sdk";
import OpenAI from "openai";

/*
 * Error mapping adapted from plugins/openai-compatible (plugins never import each other): only the
 * SDK error classes, HTTP statuses and structured error `code`s decide, never message strings.
 * DeepSeek table (https://api-docs.deepseek.com/quick_start/error_codes): 400 / 422 invalid_request,
 * 401 auth, 402 auth (insufficient balance, retrying is useless), 429 rate_limited, 500 server,
 * 503 overloaded (retryable).
 */

/** `retry-after-ms` (milliseconds) first, then `retry-after` (seconds or an HTTP date). */
export function retryAfterMs(headers: Headers | undefined): number | undefined {
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

/** Classification by the structured error `code`; unknown codes return null. */
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

/** The kind of an HTTP status (with the body's `code` when it has one). */
export function kindFromStatus(status: number, code?: string | null): ModelErrorKind {
  if (status === 401 || status === 402 || status === 403) return "auth";
  if (status === 408) return "timeout";
  if (status === 413) return "context_overflow";
  if (status === 429) return code === "insufficient_quota" ? "auth" : "rate_limited";
  if (status === 503) return "overloaded";
  if (status >= 500) return "server";
  // DeepSeek documents no structured context-overflow code, so a real overflow 400 maps to
  // invalid_request below.
  if (status === 400 && code === "context_length_exceeded") return "context_overflow";
  return kindFromCode(code) ?? "invalid_request";
}

/** SDK error → ModelError. An aborted `signal` always means aborted. */
export function toModelError(e: unknown, signal?: AbortSignal): ModelError {
  if (isModelError(e)) return e as ModelError;
  const message = e instanceof Error ? e.message : String(e);
  const make = (kind: ModelErrorKind, extra?: { retryAfterMs?: number }) =>
    new ModelError(kind, `DeepSeek: ${message}`, { cause: e, ...extra });

  if (signal?.aborted || e instanceof OpenAI.APIUserAbortError) {
    return new ModelError("aborted", "Request aborted", { cause: e });
  }
  if (e instanceof OpenAI.APIConnectionTimeoutError) return make("timeout");
  if (e instanceof OpenAI.APIConnectionError) return make("network");
  if (e instanceof OpenAI.APIError) {
    const status = e.status;
    if (typeof status === "number") {
      const kind = kindFromStatus(status, e.code);
      const ms = kind === "rate_limited" ? retryAfterMs(e.headers) : undefined;
      return make(kind, ms !== undefined ? { retryAfterMs: ms } : undefined);
    }
    // no status: an error event in the middle of the stream
    return make(kindFromCode(e.code) ?? "server");
  }
  return make("server");
}
