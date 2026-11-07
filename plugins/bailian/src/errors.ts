import { isModelError, ModelError, type ModelErrorKind } from "@capybara-hq/plugin-sdk";

/*
 * DashScope errors (https://www.alibabacloud.com/help/en/model-studio/error-code, checked live on
 * 2026-11-08): the body is `{ code, message, request_id }`, sent as JSON (any content type, also
 * text/plain) or as one SSE `event:error` (HTTP 200 or 400) whose data is the same object. The kind
 * comes from the HTTP status and the structured `code`; one message test below is a documented
 * patch.
 */

/** A DashScope error body. */
export interface ErrorBody {
  code?: string | null;
  message?: string | null;
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

/**
 * PATCH (DashScope, all models): a prompt over the model's input limit comes back as `code:
 * "InvalidParameter"` with the message "<400> InternalError.Algo.InvalidParameter: Range of input
 * length should be [1, N]" (live 2026-11-08, also as a 200 SSE error event); the same code carries
 * ordinary parameter errors ("Range of max_tokens should be ..."), so only the message tells them
 * apart. Remove when DashScope gives context overflow its own code.
 */
function isInputTooLong(message: string): boolean {
  return /Range of input length should be/i.test(message);
}

/**
 * The kind of a DashScope error. `status` is undefined for an error event inside a 200 stream;
 * an unknown code there is `server` (retryable), an unknown 4xx is `invalid_request`.
 */
export function kindFor(status: number | undefined, body: ErrorBody): ModelErrorKind {
  const code = body.code ?? "";
  const message = body.message ?? "";
  if (code === "InvalidApiKey" || code.startsWith("AccessDenied") || code === "Arrearage") {
    return "auth";
  }
  // Throttling.RateQuota / BurstRate / Concurrency are rates. Throttling.AllocationQuota is the
  // ambiguous one: the docs use it for a token-rate limit and for an exhausted free quota alike.
  // Treated as a rate (retryable): misreading a spent quota costs one retry and a fallback,
  // misreading a rate limit as auth would fail a run that could have succeeded.
  if (code.startsWith("Throttling")) return "rate_limited";
  if (isInputTooLong(message)) return "context_overflow";
  // Content moderation (input or output): the SDK has no refusal error kind; not retryable.
  if (code.startsWith("DataInspection")) return "invalid_request";
  if (status !== undefined) {
    if (status === 401 || status === 403) return "auth";
    if (status === 429) return "rate_limited";
    if (status === 408) return "timeout";
    if (status === 413) return "context_overflow";
    if (status === 503) return "overloaded";
    if (status >= 500) return "server";
  }
  if (code === "ServiceUnavailable") return "overloaded";
  if (code.startsWith("InternalError")) return "server";
  if (code.startsWith("InvalidParameter") || code === "ModelNotFound" || code === "BadRequest") {
    return "invalid_request";
  }
  if (status !== undefined && status >= 400) return "invalid_request";
  return "server";
}

/** A ModelError for a DashScope error body. */
export function errorFromBody(
  status: number | undefined,
  body: ErrorBody,
  headers?: Headers,
): ModelError {
  const kind = kindFor(status, body);
  const ms = kind === "rate_limited" ? retryAfterMs(headers) : undefined;
  const label = [status, body.code]
    .filter((x) => x !== undefined && x !== null && x !== "")
    .join(" ");
  return new ModelError(kind, `Bailian: ${label}${body.message ? `: ${body.message}` : ""}`, {
    ...(ms !== undefined ? { retryAfterMs: ms } : {}),
  });
}

/** Reads the error body of a non-2xx response: JSON, or an SSE `data:` line holding the JSON. */
export async function errorFromResponse(res: Response): Promise<ModelError> {
  const text = await res.text().catch(() => "");
  return errorFromBody(res.status, parseErrorText(text), res.headers);
}

export function parseErrorText(text: string): ErrorBody {
  const candidates = [
    text,
    ...text.split(/\r?\n/).flatMap((l) => (l.startsWith("data:") ? [l.slice(5)] : [])),
  ];
  for (const c of candidates) {
    try {
      const v: unknown = JSON.parse(c);
      if (typeof v === "object" && v !== null) return v as ErrorBody;
    } catch {
      // not JSON
    }
  }
  return { message: text.slice(0, 200) };
}

/** Anything thrown during a call → ModelError. An aborted signal wins over whatever was thrown. */
export function toModelError(e: unknown, signal?: AbortSignal): ModelError {
  if (signal?.aborted) {
    return isModelError(e) && e.kind === "aborted"
      ? (e as ModelError)
      : new ModelError("aborted", "Request aborted", { cause: e });
  }
  if (isModelError(e)) return e as ModelError;
  const message = e instanceof Error ? e.message : String(e);
  if (e instanceof Error && e.name === "TimeoutError") {
    return new ModelError("timeout", `Bailian: ${message}`, { cause: e });
  }
  if (e instanceof Error && e.name === "AbortError") {
    return new ModelError("aborted", "Request aborted", { cause: e });
  }
  // fetch rejects with a TypeError on connection failures (and a cut body while reading)
  if (e instanceof TypeError) return new ModelError("network", `Bailian: ${message}`, { cause: e });
  return new ModelError("server", `Bailian: ${message}`, { cause: e });
}
