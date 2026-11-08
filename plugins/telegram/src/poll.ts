import type { ChannelConnectArgs, Logger } from "@capybara-hq/plugin-sdk";
import type { CardTokenStore } from "./actions.js";
import { type TelegramApi, TelegramApiError } from "./api.js";
import { type BotIdentity, chatMigration, fetchBotIdentity, updateToInbound } from "./inbound.js";
import type { Kv, ThreadStore } from "./threads.js";
import { pause } from "./wait.js";

/** The stored offset lives 7 days (Telegram keeps updates for 24 hours). */
export const OFFSET_TTL_SECONDS = 604_800;
/** The backoff never waits longer than this (except a longer 429 `retry_after`). */
export const BACKOFF_CAP_MS = 30_000;
/** This many `getUpdates` failures in a row end `connect` with an error. */
export const MAX_CONSECUTIVE_FAILURES = 5;

export const WEBHOOK_SET_ERROR =
  "A webhook is set for this Telegram bot; switch the connection to webhook mode or call deleteWebhook";
export const CONFLICT_ERROR = "Telegram getUpdates conflict: another client is polling this bot";
export const TOKEN_REJECTED_ERROR = "Telegram bot token rejected";

export interface LongPollingArgs {
  /** Short calls: `getMe`, `getWebhookInfo`, `answerCallbackQuery`. */
  api: TelegramApi;
  /**
   * `getUpdates` only: a client whose request timeout exceeds the long-poll timeout (the caller
   * builds it with `pollTimeoutSec * 1000 + 10_000`). Defaults to `api`.
   */
  pollApi?: TelegramApi;
  connectionId: string;
  onEvent: ChannelConnectArgs["onEvent"];
  signal: AbortSignal;
  log: Logger;
  kv?: Kv | undefined;
  threads: ThreadStore;
  tokens: CardTokenStore;
  pollTimeoutSec: number;
  backoffBaseMs: number;
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | undefined =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Obj) : undefined;
const int = (v: unknown) => (typeof v === "number" && Number.isSafeInteger(v) ? v : undefined);

/** Exponential backoff with jitter (50–100 % of the step), capped. `attempt` starts at 1. */
function backoffMs(base: number, attempt: number): number {
  const step = Math.min(BACKOFF_CAP_MS, base * 2 ** Math.min(attempt - 1, 20));
  return Math.round(step * (0.5 + Math.random() * 0.5));
}

/** A refusal that retrying cannot fix: a bad token, another client polling, or a webhook. */
function refusal(e: unknown): Error | undefined {
  if (!(e instanceof TelegramApiError)) return undefined;
  const code = e.errorCode ?? e.status;
  if (code === 401) return new Error(TOKEN_REJECTED_ERROR);
  if (code === 409) {
    // Telegram also answers 409 while a webhook is set (one was set after connect started).
    return new Error(/webhook/i.test(e.description ?? "") ? WEBHOOK_SET_ERROR : CONFLICT_ERROR);
  }
  return undefined;
}

/** Network errors, timeouts, 5xx and 429 are worth another `getUpdates`. */
function transient(e: TelegramApiError): boolean {
  const code = e.errorCode ?? e.status;
  return e.network || code === 429 || (e.status !== undefined && e.status >= 500);
}

/** A token-free message for any error (Bot API errors never carry the token). */
const messageOf = (e: unknown) =>
  e instanceof TelegramApiError ? e.message : "unexpected error while polling Telegram";

/**
 * The long-polling loop behind `connect` (spec "Long polling"). Every update is confirmed to
 * Telegram (by the next `getUpdates` offset) only after its `onEvent` resolved or it was ignored;
 * an `onEvent` rejection stops the batch and the same update is fetched again after a backoff.
 * Resolves when `signal` aborts; throws on a refusal (401, 409, a webhook) or after
 * {@link MAX_CONSECUTIVE_FAILURES} `getUpdates` failures in a row, so the kernel records
 * `last_error`.
 */
export async function runLongPolling(a: LongPollingArgs): Promise<void> {
  const { api, signal, log } = a;
  const pollApi = a.pollApi ?? api;

  const bot = await startup(a);
  if (!bot) return; // aborted
  const offsetKey = `offset/${bot.id}`;
  let offset = await readOffset(a.kv, offsetKey, log);

  let failures = 0; // getUpdates failures in a row
  let rejections = 0; // onEvent rejections in a row (backoff only; the kernel recovers)

  while (!signal.aborted) {
    let updates: unknown[];
    try {
      const result = await pollApi.call<unknown>(
        "getUpdates",
        {
          ...(offset !== undefined && { offset }),
          timeout: a.pollTimeoutSec,
          allowed_updates: ["message", "callback_query"],
        },
        signal,
      );
      updates = Array.isArray(result) ? result : [];
      failures = 0;
    } catch (e) {
      if (signal.aborted) return;
      const refused = refusal(e);
      if (refused) throw refused;
      if (!(e instanceof TelegramApiError) || !transient(e)) throw new Error(messageOf(e));
      failures++;
      if (failures >= MAX_CONSECUTIVE_FAILURES) throw new Error(e.message);
      const wait = Math.max(backoffMs(a.backoffBaseMs, failures), (e.retryAfterSec ?? 0) * 1000);
      log.warn("telegram: getUpdates failed; retrying", {
        connectionId: a.connectionId,
        error: e.message,
        attempt: failures,
        waitMs: wait,
      });
      await pause(wait, signal);
      continue;
    }

    // No filter on ids below the offset: Telegram only returns unconfirmed updates (ids may restart
    // after a long idle) and the kernel dedupes, so every returned update is processed.
    let usable = 0;
    for (const update of updates) {
      const updateId = int(obj(update)?.update_id);
      if (updateId === undefined) continue; // not an update; nothing to confirm by
      usable++;

      let delivered: boolean;
      try {
        delivered = await deliver(a, update, bot);
      } catch (e) {
        if (signal.aborted) return; // the rejection came from the shutdown; nothing to report
        // onEvent rejected (or the parser's kv failed): do not confirm; fetch it again later.
        rejections++;
        const wait = backoffMs(a.backoffBaseMs, rejections);
        log.warn("telegram: an update was not accepted; fetching it again", {
          connectionId: a.connectionId,
          updateId,
          error: e instanceof Error ? e.message : String(e),
          waitMs: wait,
        });
        await pause(wait, signal);
        break;
      }
      if (delivered) rejections = 0;
      offset = updateId + 1;
      await writeOffset(a.kv, offsetKey, offset, log);
      const callbackId = obj(obj(update)?.callback_query)?.id;
      if (typeof callbackId === "string" && callbackId !== "") {
        await answerCallback(a, callbackId);
      }
      if (signal.aborted) return;
    }
    // A batch with nothing to confirm by would come back unchanged: do not hammer the API.
    if (updates.length > 0 && usable === 0) {
      await pause(backoffMs(a.backoffBaseMs, 1), signal);
    }
  }
}

/** `getMe` then `getWebhookInfo`; `undefined` when aborted. */
async function startup(a: LongPollingArgs): Promise<BotIdentity | undefined> {
  try {
    const bot = await fetchBotIdentity(a.api, a.signal);
    const hook = await a.api.call<{ url?: unknown } | undefined>(
      "getWebhookInfo",
      undefined,
      a.signal,
    );
    if (typeof hook?.url === "string" && hook.url !== "") throw new Error(WEBHOOK_SET_ERROR);
    return bot;
  } catch (e) {
    if (a.signal.aborted) return undefined;
    if (e instanceof TelegramApiError) throw refusal(e) ?? new Error(e.message);
    throw e;
  }
}

/** Hands one update to the kernel; `true` when an event was delivered, `false` when ignored. */
async function deliver(a: LongPollingArgs, update: unknown, bot: BotIdentity): Promise<boolean> {
  const migration = chatMigration(update);
  if (migration) {
    a.log.info("telegram: a group became a supergroup; its old conversations stop", {
      connectionId: a.connectionId,
      ...migration,
    });
    return false;
  }
  const event = await updateToInbound(update, bot, a.threads, a.tokens);
  if (!event) return false;
  await a.onEvent(event);
  return true;
}

/** Stops the client's progress indicator; best-effort, never blocks the confirmation. */
async function answerCallback(a: LongPollingArgs, callbackQueryId: string): Promise<void> {
  try {
    await a.api.call("answerCallbackQuery", { callback_query_id: callbackQueryId }, a.signal);
  } catch (e) {
    if (a.signal.aborted) return;
    a.log.warn("telegram: answerCallbackQuery failed", {
      connectionId: a.connectionId,
      error: messageOf(e),
    });
  }
}

async function readOffset(kv: Kv | undefined, key: string, log: Logger) {
  if (!kv) return undefined;
  try {
    const raw = await kv.get(key);
    const n = raw === null || raw === undefined ? undefined : Number(raw);
    return n !== undefined && Number.isSafeInteger(n) && n > 0 ? n : undefined;
  } catch {
    log.warn("telegram: could not read the stored getUpdates offset; starting without it");
    return undefined;
  }
}

async function writeOffset(kv: Kv | undefined, key: string, offset: number, log: Logger) {
  if (!kv) return;
  try {
    await kv.set(key, String(offset), { ttlSeconds: OFFSET_TTL_SECONDS });
  } catch {
    log.warn("telegram: could not store the getUpdates offset", { offset });
  }
}
