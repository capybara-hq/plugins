import { ChannelSendError, isChannelSendError } from "@capybara-hq/plugin-sdk";
import { TelegramApiError } from "./api.js";

/**
 * {@link TelegramApiError} → {@link ChannelSendError}, per the spec's Errors table (Bot API error
 * texts read from https://core.telegram.org/bots/api on 2026-11-08):
 * 429 → retryable after `retry_after`; 5xx / network / timeout → retryable; 401 → `auth`;
 * 403 (blocked, kicked, can't initiate conversation, deactivated user: the bot can no longer reach
 * the chat) → `target_gone`; 400 chat not found or a migrated group → `target_gone`;
 * 400 "too long" (`message is too long`, `MESSAGE_TOO_LONG` on edits, `message caption is too long`)
 * → `too_large`; anything else → `rejected`.
 * The message is the client error's (method, `error_code`, description), never the URL.
 */
export function toChannelSendError(e: unknown): ChannelSendError {
  if (isChannelSendError(e)) return e;
  if (!(e instanceof TelegramApiError)) {
    // Its message or cause could carry anything (a URL with the token): neither is kept.
    return new ChannelSendError("Telegram API call failed", { retryable: true });
  }
  const opts = { cause: e };
  const code = e.errorCode ?? e.status ?? 0;
  if (e.network || code >= 500)
    return new ChannelSendError(e.message, { retryable: true, ...opts });
  if (code === 429) {
    return new ChannelSendError(e.message, {
      retryable: true,
      ...(e.retryAfterSec !== undefined && { retryAfterMs: e.retryAfterSec * 1000 }),
      ...opts,
    });
  }
  const reject = (reason: "auth" | "target_gone" | "too_large" | "rejected") =>
    new ChannelSendError(e.message, { retryable: false, reason, ...opts });
  if (code === 401) return reject("auth");
  if (code === 403) return reject("target_gone");
  const text = (e.description ?? "").toLowerCase();
  if (e.migrateToChatId !== undefined) return reject("target_gone");
  if (code === 400 && text.includes("chat not found")) return reject("target_gone");
  if (code === 400 && /too[ _]long/.test(text)) return reject("too_large");
  return reject("rejected");
}
