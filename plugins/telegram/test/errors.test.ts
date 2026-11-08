import { ChannelSendError } from "@capybara-hq/plugin-sdk";
import { describe, expect, it } from "vitest";
import { TelegramApiError } from "../src/api.js";
import { toChannelSendError } from "../src/errors.js";

const api = (
  errorCode: number,
  description: string,
  extra: { retryAfterSec?: number; migrateToChatId?: number } = {},
) => new TelegramApiError("sendMessage", { status: errorCode, errorCode, description, ...extra });

describe("toChannelSendError", () => {
  const rows: [string, unknown, Record<string, unknown>][] = [
    [
      "429 → retryable with retryAfterMs",
      api(429, "Too Many Requests: retry after 3", { retryAfterSec: 3 }),
      { retryable: true, retryAfterMs: 3000 },
    ],
    ["500 → retryable", api(500, "Internal Server Error"), { retryable: true }],
    ["502 → retryable", api(502, "Bad Gateway"), { retryable: true }],
    [
      "network → retryable",
      new TelegramApiError("sendMessage", { network: true }),
      { retryable: true },
    ],
    [
      "timeout → retryable",
      new TelegramApiError("sendMessage", { network: true, timeout: true }),
      { retryable: true },
    ],
    ["401 → auth", api(401, "Unauthorized"), { retryable: false, reason: "auth" }],
    [
      "403 blocked → target_gone",
      api(403, "Forbidden: bot was blocked by the user"),
      { retryable: false, reason: "target_gone" },
    ],
    [
      "403 kicked → target_gone",
      api(403, "Forbidden: bot was kicked from the group chat"),
      { retryable: false, reason: "target_gone" },
    ],
    [
      "403 can't initiate → target_gone",
      api(403, "Forbidden: bot can't initiate conversation with a user"),
      { retryable: false, reason: "target_gone" },
    ],
    [
      "400 chat not found → target_gone",
      api(400, "Bad Request: chat not found"),
      { retryable: false, reason: "target_gone" },
    ],
    [
      "400 group migrated → target_gone",
      api(400, "Bad Request: group chat was upgraded to a supergroup chat", {
        migrateToChatId: -1001234,
      }),
      { retryable: false, reason: "target_gone" },
    ],
    [
      "400 message too long → too_large",
      api(400, "Bad Request: message is too long"),
      { retryable: false, reason: "too_large" },
    ],
    [
      "400 MESSAGE_TOO_LONG (edit) → too_large",
      api(400, "Bad Request: MESSAGE_TOO_LONG"),
      { retryable: false, reason: "too_large" },
    ],
    [
      "400 caption too long → too_large",
      api(400, "Bad Request: message caption is too long"),
      { retryable: false, reason: "too_large" },
    ],
    [
      "other 400 → rejected",
      api(400, "Bad Request: can't parse entities"),
      { retryable: false, reason: "rejected" },
    ],
    ["404 → rejected", api(404, "Not Found"), { retryable: false, reason: "rejected" }],
  ];

  it.each(rows)("%s", (_name, input, expected) => {
    const e = toChannelSendError(input);
    expect(e).toBeInstanceOf(ChannelSendError);
    expect(e).toMatchObject(expected);
    if (expected.retryable) expect(e.reason).toBeUndefined();
    if (!("retryAfterMs" in expected)) expect(e.retryAfterMs).toBeUndefined();
  });

  it("keeps the method, code and description in the message", () => {
    expect(toChannelSendError(api(400, "Bad Request: chat not found")).message).toBe(
      "Telegram sendMessage failed: 400 Bad Request: chat not found",
    );
  });

  it("passes a ChannelSendError through unchanged", () => {
    const original = new ChannelSendError("x", { retryable: false, reason: "rejected" });
    expect(toChannelSendError(original)).toBe(original);
  });

  it("an unknown error → retryable, without its message or cause", () => {
    const e = toChannelSendError(new Error("https://api.telegram.org/bot1:secret/getMe"));
    expect(e).toMatchObject({ retryable: true, message: "Telegram API call failed" });
    expect(e.cause).toBeUndefined();
  });
});
