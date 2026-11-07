import { isModelError, ModelError, type ModelErrorKind } from "@capybara-hq/plugin-sdk";
import OpenAI from "openai";

/*
 * Error mapping adapted from plugins/openai-compatible (plugins never import each other): only the
 * SDK error classes, HTTP statuses and structured error `code`s decide, never message strings.
 * Ark bodies are OpenAI-shaped: `{ error: { code, message, param, type } }` (live 2026-11-08:
 * 401 AuthenticationError, 404 InvalidEndpointOrModel.NotFound, 400 InvalidParameter, also for a
 * prompt over the context window, which carries no dedicated code). The 429 / 403 codes follow
 * Ark's published error code list (docs.volcengine.com, Ark docs 82379); not reproduced live.
 */

/** The account's quota, its self-set spending limit or an overdue bill: retrying does not help. */
function notRetryable429(code: string | null | undefined): boolean {
  return code === "QuotaExceeded" || code === "SetLimitExceeded" || code === "AccountOverdueError";
}

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

/** Classification by a structured code alone (a mid-stream error event); unknown codes → null. */
export function kindFromCode(code: string | null | undefined): ModelErrorKind | null {
  if (code === null || code === undefined || code === "") return null;
  if (code === "ServerOverloaded") return "overloaded";
  if (code === "context_length_exceeded") return "context_overflow";
  if (notRetryable429(code) || code === "AuthenticationError") return "auth";
  if (code.includes("RateLimitExceeded") || code === "rate_limit_exceeded") return "rate_limited";
  if (code === "InternalServiceError" || code === "server_error") return "server";
  if (code.startsWith("InvalidParameter") || code.startsWith("MissingParameter")) {
    return "invalid_request";
  }
  return null;
}

/** The kind of an HTTP status, refined by the body's `code`. */
export function kindFromStatus(status: number, code?: string | null): ModelErrorKind {
  if (status === 401 || status === 402 || status === 403) return "auth";
  if (status === 408) return "timeout";
  if (status === 413) return "context_overflow";
  if (status === 429) {
    if (code === "ServerOverloaded") return "overloaded";
    return notRetryable429(code) ? "auth" : "rate_limited";
  }
  if (status === 503) return "overloaded";
  if (status >= 500) return "server";
  return code === "context_length_exceeded" ? "context_overflow" : "invalid_request";
}

/**
 * The hint for Ark's "model or endpoint does not exist or you do not have access" (404
 * `InvalidEndpointOrModel.NotFound`): the model list is catalog-wide, so a listed model the
 * account has not activated answers this way (live 2026-11-08).
 */
export const NOT_ACTIVATED_HINT =
  "check that the model is activated for this account in the Ark console (or the endpoint exists)";
const hintOf = (code: string | null | undefined) =>
  code === "InvalidEndpointOrModel.NotFound" ? ` (${NOT_ACTIVATED_HINT})` : "";

/** SDK error → ModelError. An aborted `signal` always means aborted. */
export function toModelError(e: unknown, signal?: AbortSignal): ModelError {
  if (isModelError(e)) return e as ModelError;
  const message = e instanceof Error ? e.message : String(e);
  const code = e instanceof OpenAI.APIError && typeof e.code === "string" ? e.code : null;
  const make = (kind: ModelErrorKind, extra?: { retryAfterMs?: number }) =>
    new ModelError(kind, `Ark: ${message}${hintOf(code)}`, { cause: e, ...extra });

  if (signal?.aborted || e instanceof OpenAI.APIUserAbortError) {
    return new ModelError("aborted", "Request aborted", { cause: e });
  }
  if (e instanceof OpenAI.APIConnectionTimeoutError) return make("timeout");
  if (e instanceof OpenAI.APIConnectionError) return make("network");
  if (e instanceof OpenAI.APIError) {
    const status = e.status;
    if (typeof status === "number") {
      const kind = kindFromStatus(status, code);
      const ms = kind === "rate_limited" ? retryAfterMs(e.headers) : undefined;
      return make(kind, ms !== undefined ? { retryAfterMs: ms } : undefined);
    }
    // no status: an error event in the middle of the stream
    return make(kindFromCode(code) ?? "server");
  }
  return make("server");
}

/** A non-2xx `fetch` response (list, embeddings) → ModelError. */
export async function httpError(res: Response, what: string): Promise<ModelError> {
  let code: string | null = null;
  let message = `HTTP ${res.status}`;
  try {
    const body = (await res.json()) as { error?: { code?: unknown; message?: unknown } };
    if (typeof body.error?.code === "string") code = body.error.code;
    if (typeof body.error?.message === "string") message = body.error.message;
  } catch {
    // not JSON: keep the status
  }
  const kind = kindFromStatus(res.status, code);
  const ms = kind === "rate_limited" ? retryAfterMs(res.headers) : undefined;
  return new ModelError(
    kind,
    `Ark: ${what}: ${message}${hintOf(code)}`,
    ms !== undefined ? { retryAfterMs: ms } : {},
  );
}

/** A failed `fetch` call → ModelError (aborted signal first, then timeout, else network). */
export function fetchError(cause: unknown, what: string, signal?: AbortSignal): ModelError {
  if (signal?.aborted) return new ModelError("aborted", "Request aborted", { cause });
  const timeout = cause instanceof Error && cause.name === "TimeoutError";
  return new ModelError(timeout ? "timeout" : "network", `Ark: ${what} failed`, { cause });
}
