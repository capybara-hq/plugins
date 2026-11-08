import { timingSafeEqual } from "node:crypto";
import type {
  ChannelWebhookRequest,
  ChannelWebhookResponse,
  ChannelWebhookResult,
  InboundEvent,
  Logger,
} from "@capybara-hq/plugin-sdk";
import { type TelegramApi, TelegramApiError } from "./api.js";
import type { TelegramConnectionConfig } from "./config.js";
import { type BotIdentity, fetchBotIdentity } from "./inbound.js";
import type { Kv } from "./threads.js";

/**
 * Telegram webhook inbound (spec "Webhook"), the alternative to long polling. Reference (checked
 * 2026-11-08): https://core.telegram.org/bots/api#setwebhook. Telegram POSTs one JSON `Update` per
 * request and, when `setWebhook` got a `secret_token`, sends it in `X-Telegram-Bot-API-Secret-Token`;
 * any non-2xx answer makes Telegram redeliver. The kernel puts no auth on the route: that header is
 * the only proof a request comes from Telegram, so no secret configured means every request is
 * rejected. The update goes through the long-poll parser, so `messageId`s and dedupe match.
 */

/** The secret header, lowercase as the kernel passes header names. */
export const SECRET_HEADER = "x-telegram-bot-api-secret-token";

/** TTL of the cached bot identity (`bot/<bot id>` in plugin kv), in seconds. */
export const BOT_IDENTITY_TTL_SECONDS = 3600;

/** Telegram ignores the body of the answer; a plain 200 confirms the update. */
export const TELEGRAM_WEBHOOK_ACK: ChannelWebhookResponse = { status: 200 };

const obj = (v: unknown): Record<string, unknown> | undefined =>
  typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;

/**
 * Compares the secret header with the configured secret in constant time. Only the length can show
 * through timing (`timingSafeEqual` needs equal lengths); Telegram's secrets are short and the
 * length alone reveals nothing usable.
 */
function secretMatches(header: string | undefined, secret: string | undefined): boolean {
  if (secret === undefined || secret === "" || header === undefined) return false;
  const got = Buffer.from(header, "utf8");
  const want = Buffer.from(secret, "utf8");
  return got.length === want.length && timingSafeEqual(got, want);
}

/**
 * One webhook request → kernel result. The secret is checked before the body is read: missing or
 * wrong → reject 401 (also when no secret is configured); a body that is not JSON or not an object
 * with an integer `update_id` → reject 400; otherwise `toEvent` (the long-poll parser, resolving
 * the bot identity only now) decides, and an ignored update is acked with no events. A `toEvent`
 * failure propagates: the kernel answers non-2xx and Telegram redelivers.
 */
export async function handleTelegramWebhook(a: {
  config: TelegramConnectionConfig;
  request: ChannelWebhookRequest;
  toEvent: (update: unknown) => Promise<InboundEvent | null>;
}): Promise<ChannelWebhookResult> {
  if (!secretMatches(a.request.headers[SECRET_HEADER], a.config.webhookSecret)) {
    return { kind: "reject", status: 401 };
  }
  let update: unknown;
  try {
    update = JSON.parse(new TextDecoder().decode(a.request.body));
  } catch {
    return { kind: "reject", status: 400 };
  }
  const id = obj(update)?.update_id;
  if (typeof id !== "number" || !Number.isSafeInteger(id)) return { kind: "reject", status: 400 };
  const event = await a.toEvent(update);
  return { kind: "events", events: event ? [event] : [], ack: TELEGRAM_WEBHOOK_ACK };
}

/**
 * The bot identity the parser needs (the @handle to strip, the id replies point at): the kv copy
 * when it is readable, else `getMe` (then cached). kv failures only cost a `getMe`; a `getMe`
 * failure throws, so the kernel answers non-2xx and Telegram redelivers the update.
 */
export async function webhookBotIdentity(
  api: TelegramApi,
  kv: Kv | undefined,
  botId: string,
  signal: AbortSignal,
): Promise<BotIdentity> {
  const key = `bot/${botId}`;
  if (kv) {
    try {
      const raw = await kv.get(key);
      const cached = obj(raw ? JSON.parse(raw) : undefined);
      if (
        typeof cached?.id === "number" &&
        Number.isSafeInteger(cached.id) &&
        typeof cached.username === "string" &&
        cached.username !== ""
      ) {
        return { id: cached.id, username: cached.username };
      }
    } catch {
      // Unreadable or kv down: ask Telegram.
    }
  }
  const bot = await fetchBotIdentity(api, signal);
  if (kv) {
    try {
      await kv.set(key, JSON.stringify(bot), { ttlSeconds: BOT_IDENTITY_TTL_SECONDS });
    } catch {
      // The next request asks Telegram again.
    }
  }
  return bot;
}

/**
 * Stops the client's progress indicator for a callback query update; best-effort. The webhook
 * contract gives no hook after the kernel's `onEvent`, so this runs before the events are handed
 * over (documented trade-off: if the kernel then answers 503 and Telegram redelivers, the spinner
 * already stopped; the redelivery is deduped). Errors are logged without the token.
 */
export async function answerWebhookCallback(
  api: TelegramApi,
  update: unknown,
  log: Logger,
  connectionId: string,
  signal: AbortSignal,
): Promise<void> {
  const id = obj(obj(update)?.callback_query)?.id;
  if (typeof id !== "string" || id === "") return;
  try {
    await api.call("answerCallbackQuery", { callback_query_id: id }, signal);
  } catch (e) {
    if (signal.aborted) return; // the kernel gave up on the request; nothing to report
    log.warn("telegram: answerCallbackQuery failed", {
      connectionId,
      error: e instanceof TelegramApiError ? e.message : "unexpected error",
    });
  }
}
