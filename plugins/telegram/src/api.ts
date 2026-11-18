/**
 * A minimal Bot API client (https://core.telegram.org/bots/api, "Making requests", read
 * 2026-11-08): `POST <apiUrl>/bot<token>/<method>` with a JSON body; the answer is
 * `{ ok: true, result }` or `{ ok: false, error_code, description, parameters? }`.
 *
 * The token sits in the URL path, so the URL is never put into an error, log line or `cause`, and
 * fetch errors (which may describe the request) are dropped: every {@link TelegramApiError} is built
 * from the method name and Telegram's JSON envelope only. No retries here; the kernel retries.
 * Uploads (`sendPhoto`, `sendDocument`) take the same path with a multipart body.
 */

export interface TelegramApiErrorInit {
  /** HTTP status, when an answer arrived. */
  status?: number;
  /** The envelope's `error_code`. */
  errorCode?: number;
  /** The envelope's `description`, verbatim (Telegram never echoes the token). */
  description?: string;
  /** `parameters.retry_after` (seconds). */
  retryAfterSec?: number;
  /** `parameters.migrate_to_chat_id`: the group became a supergroup with this id. */
  migrateToChatId?: number;
  /** No answer arrived (connection error or timeout). */
  network?: boolean;
  /** The request ran over the client's timeout (implies `network`). */
  timeout?: boolean;
}

export class TelegramApiError extends Error {
  override name = "TelegramApiError";
  readonly method: string;
  readonly status?: number;
  readonly errorCode?: number;
  readonly description?: string;
  readonly retryAfterSec?: number;
  readonly migrateToChatId?: number;
  readonly network: boolean;

  constructor(method: string, init: TelegramApiErrorInit) {
    super(`Telegram ${method} failed: ${detail(init)}`);
    this.method = method;
    this.network = init.network === true || init.timeout === true;
    if (init.status !== undefined) this.status = init.status;
    if (init.errorCode !== undefined) this.errorCode = init.errorCode;
    if (init.description !== undefined) this.description = init.description;
    if (init.retryAfterSec !== undefined) this.retryAfterSec = init.retryAfterSec;
    if (init.migrateToChatId !== undefined) this.migrateToChatId = init.migrateToChatId;
  }
}

function detail(init: TelegramApiErrorInit): string {
  if (init.timeout) return "timeout";
  if (init.network) return "network error";
  // Telegram's error_code; only the HTTP status when the body was no envelope (e.g. a proxy page).
  const code =
    init.errorCode !== undefined
      ? String(init.errorCode)
      : init.status !== undefined
        ? `HTTP ${init.status}`
        : "unknown error";
  return init.description ? `${code} ${init.description}` : code;
}

/** The file part of a multipart upload (`sendPhoto` field `photo`, `sendDocument` field `document`). */
export interface TelegramUploadFile {
  field: string;
  name: string;
  contentType: string;
  data: Uint8Array;
}

export interface TelegramApi {
  /** Calls a Bot API method; resolves to `result`, rejects with {@link TelegramApiError}. */
  call<T>(method: string, params?: Record<string, unknown>, signal?: AbortSignal): Promise<T>;
  /**
   * Calls a Bot API method with a `multipart/form-data` body: the string `fields` (objects
   * JSON-encoded by the caller, as the Bot API expects) and one file. Same answers and errors as
   * {@link call}, with its own (longer) timeout.
   */
  upload<T>(
    method: string,
    fields: Record<string, string>,
    file: TelegramUploadFile,
    signal?: AbortSignal,
  ): Promise<T>;
}

interface Envelope {
  ok?: unknown;
  result?: unknown;
  error_code?: unknown;
  description?: unknown;
  parameters?: { retry_after?: unknown; migrate_to_chat_id?: unknown };
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

export function telegramApi(o: {
  apiUrl: string;
  token: string;
  timeoutMs?: number;
  /** One upload's timeout (default 115 s: a 50 MB document over a slow link). */
  uploadTimeoutMs?: number;
}): TelegramApi {
  const base = o.apiUrl.replace(/\/+$/, "");
  const timeoutMs = o.timeoutMs ?? 15_000;
  const uploadTimeoutMs = o.uploadTimeoutMs ?? 115_000;

  async function request<T>(
    method: string,
    init: { headers?: Record<string, string>; body: string | FormData },
    ms: number,
    signal?: AbortSignal,
  ): Promise<T> {
    const timer = AbortSignal.timeout(ms);
    let res: Response;
    let text: string;
    try {
      res = await fetch(`${base}/bot${o.token}/${method}`, {
        method: "POST",
        ...(init.headers && { headers: init.headers }),
        body: init.body,
        signal: signal ? AbortSignal.any([signal, timer]) : timer,
      });
      // The body is read inside this try: a timeout, abort or reset after the headers is a
      // network failure like one before them.
      text = await res.text();
    } catch {
      // The fetch error is dropped on purpose (see the file comment).
      signal?.throwIfAborted();
      throw new TelegramApiError(method, { network: true, timeout: timer.aborted });
    }
    let body: Envelope | undefined;
    try {
      body = JSON.parse(text) as Envelope | undefined;
    } catch {
      body = undefined; // Not an envelope (e.g. a proxy's HTML error page).
    }
    if (res.ok && body?.ok === true) return body.result as T;
    // Anything else is an error built from the status and whatever envelope fields exist. A 2xx
    // without a valid `ok: true` envelope keeps its 2xx status and so maps to `rejected` (not
    // retryable: a broken answer is not expected to fix itself); a non-envelope 5xx stays retryable.
    const errorCode = num(body?.error_code);
    const description = typeof body?.description === "string" ? body.description : undefined;
    const retryAfterSec = num(body?.parameters?.retry_after);
    const migrateToChatId = num(body?.parameters?.migrate_to_chat_id);
    throw new TelegramApiError(method, {
      status: res.status,
      ...(errorCode !== undefined && { errorCode }),
      ...(description !== undefined && { description }),
      ...(retryAfterSec !== undefined && { retryAfterSec }),
      ...(migrateToChatId !== undefined && { migrateToChatId }),
    });
  }

  return {
    call<T>(method: string, params?: Record<string, unknown>, signal?: AbortSignal) {
      return request<T>(
        method,
        {
          headers: { "content-type": "application/json" },
          body: JSON.stringify(params ?? {}),
        },
        timeoutMs,
        signal,
      );
    },
    upload<T>(
      method: string,
      fields: Record<string, string>,
      file: TelegramUploadFile,
      signal?: AbortSignal,
    ) {
      const form = new FormData();
      for (const [k, v] of Object.entries(fields)) form.append(k, v);
      // fetch sets the multipart content type with its boundary; the name is only the part's
      // filename (FormData escapes it), never a path.
      form.append(
        file.field,
        new Blob([file.data as Uint8Array<ArrayBuffer>], { type: file.contentType }),
        file.name,
      );
      return request<T>(method, { body: form }, uploadTimeoutMs, signal);
    },
  };
}
