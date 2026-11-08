/**
 * A minimal Bot API client (https://core.telegram.org/bots/api, "Making requests", read
 * 2026-11-08): `POST <apiUrl>/bot<token>/<method>` with a JSON body; the answer is
 * `{ ok: true, result }` or `{ ok: false, error_code, description, parameters? }`.
 *
 * The token sits in the URL path, so the URL is never put into an error, log line or `cause`, and
 * fetch errors (which may describe the request) are dropped: every {@link TelegramApiError} is built
 * from the method name and Telegram's JSON envelope only. No retries here; the kernel retries.
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

export interface TelegramApi {
  /** Calls a Bot API method; resolves to `result`, rejects with {@link TelegramApiError}. */
  call<T>(method: string, params?: Record<string, unknown>, signal?: AbortSignal): Promise<T>;
}

interface Envelope {
  ok?: unknown;
  result?: unknown;
  error_code?: unknown;
  description?: unknown;
  parameters?: { retry_after?: unknown; migrate_to_chat_id?: unknown };
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

export function telegramApi(o: { apiUrl: string; token: string; timeoutMs?: number }): TelegramApi {
  const base = o.apiUrl.replace(/\/+$/, "");
  const timeoutMs = o.timeoutMs ?? 15_000;
  return {
    async call<T>(method: string, params?: Record<string, unknown>, signal?: AbortSignal) {
      const timer = AbortSignal.timeout(timeoutMs);
      let res: Response;
      let body: Envelope | undefined;
      try {
        res = await fetch(`${base}/bot${o.token}/${method}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(params ?? {}),
          signal: signal ? AbortSignal.any([signal, timer]) : timer,
        });
        body = (await res.json().catch(() => undefined)) as Envelope | undefined;
      } catch {
        // The fetch error is dropped on purpose (see the file comment).
        signal?.throwIfAborted();
        throw new TelegramApiError(method, { network: true, timeout: timer.aborted });
      }
      if (res.ok && body?.ok === true) return body.result as T;
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
    },
  };
}
