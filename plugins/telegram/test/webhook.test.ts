import type { ChannelWebhookRequest, InboundEvent } from "@capybara-hq/plugin-sdk";
import {
  type FakeTelegramServer,
  startFakeTelegram,
  telegramCallback,
  telegramPrivateMessage,
  telegramWebhookHeaders,
} from "@capybara-hq/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cardTokenStore } from "../src/actions.js";
import { createTelegramChannel } from "../src/channel.js";
import { updateToInbound } from "../src/inbound.js";
import { type Kv, threadStore } from "../src/threads.js";
import { BOT_IDENTITY_TTL_SECONDS, handleTelegramWebhook } from "../src/webhook.js";

const TOKEN = "444:s3cr3t-hook-token";
const BOT_ID = 444;
const SECRET = "hook_Secret-123";
const user = { id: 42, first_name: "Ada" };

const memoryKv = () => {
  const data = new Map<string, string>();
  const ttls = new Map<string, number | undefined>();
  const kv = {
    get: async (key: string) => data.get(key) ?? null,
    set: async (key: string, value: string, o?: { ttlSeconds?: number }) => {
      data.set(key, value);
      ttls.set(key, o?.ttlSeconds);
    },
  } as Kv;
  return { kv, data, ttls };
};

const logs: { level: string; msg: string; fields: Record<string, unknown> | undefined }[] = [];
const log = {
  info: (msg: string, fields?: Record<string, unknown>) =>
    void logs.push({ level: "info", msg, fields }),
  warn: (msg: string, fields?: Record<string, unknown>) =>
    void logs.push({ level: "warn", msg, fields }),
  error: (msg: string, fields?: Record<string, unknown>) =>
    void logs.push({ level: "error", msg, fields }),
};
beforeEach(() => {
  logs.length = 0;
});

const request = (
  body: string | object,
  headers: Record<string, string>,
): ChannelWebhookRequest => ({
  method: "POST",
  headers,
  body: new TextEncoder().encode(typeof body === "string" ? body : JSON.stringify(body)),
  receivedAt: Date.now(),
});

const config = { botToken: TOKEN, webhookSecret: SECRET };

describe("handleTelegramWebhook", () => {
  const update = { update_id: 7, ...telegramPrivateMessage(user, "hi", { messageId: 5 }) };
  const noEvent = vi.fn(async () => null);
  beforeEach(() => noEvent.mockClear());

  it("rejects a request without the secret header with 401, before reading the body", async () => {
    const r = await handleTelegramWebhook({
      config,
      request: request("not json", { "content-type": "application/json" }),
      toEvent: noEvent,
    });
    expect(r).toEqual({ kind: "reject", status: 401 });
    expect(noEvent).not.toHaveBeenCalled();
  });

  it("rejects a wrong secret of the same length and of another length with 401", async () => {
    const same = `${SECRET.slice(0, -1)}X`;
    for (const secret of [same, `${SECRET}x`, "a", ""]) {
      const r = await handleTelegramWebhook({
        config,
        request: request(update, telegramWebhookHeaders(secret)),
        toEvent: noEvent,
      });
      expect(r).toEqual({ kind: "reject", status: 401 });
    }
    expect(noEvent).not.toHaveBeenCalled();
  });

  it("rejects everything with 401 when no webhook secret is configured", async () => {
    for (const headers of [telegramWebhookHeaders(SECRET), telegramWebhookHeaders(""), {}]) {
      const r = await handleTelegramWebhook({
        config: { botToken: TOKEN },
        request: request(update, headers),
        toEvent: noEvent,
      });
      expect(r).toEqual({ kind: "reject", status: 401 });
    }
    expect(noEvent).not.toHaveBeenCalled();
  });

  it("rejects a genuine request whose body is not JSON with 400", async () => {
    const r = await handleTelegramWebhook({
      config,
      request: request("{nope", telegramWebhookHeaders(SECRET)),
      toEvent: noEvent,
    });
    expect(r).toEqual({ kind: "reject", status: 400 });
  });

  it("rejects a genuine JSON body that is not an update with 400", async () => {
    for (const body of [
      "[]",
      "null",
      "42",
      JSON.stringify(telegramPrivateMessage(user, "hi")),
      JSON.stringify({ update_id: "7", message: {} }),
      JSON.stringify({ update_id: 1.5 }),
    ]) {
      const r = await handleTelegramWebhook({
        config,
        request: request(body, telegramWebhookHeaders(SECRET)),
        toEvent: noEvent,
      });
      expect(r).toEqual({ kind: "reject", status: 400 });
    }
    expect(noEvent).not.toHaveBeenCalled();
  });

  it("hands a genuine update to the parser and acks with a plain 200", async () => {
    const event = { type: "message" } as InboundEvent;
    const toEvent = vi.fn(async () => event);
    const r = await handleTelegramWebhook({
      config,
      request: request(update, telegramWebhookHeaders(SECRET)),
      toEvent,
    });
    expect(toEvent).toHaveBeenCalledWith(update);
    expect(r).toEqual({ kind: "events", events: [event], ack: { status: 200 } });
  });

  it("acks an ignored update with no events", async () => {
    const r = await handleTelegramWebhook({
      config,
      request: request(update, telegramWebhookHeaders(SECRET)),
      toEvent: noEvent,
    });
    expect(r).toEqual({ kind: "events", events: [], ack: { status: 200 } });
  });
});

describe("Channel.webhook", () => {
  let tg: FakeTelegramServer;
  beforeEach(async () => {
    tg = await startFakeTelegram({ bots: [{ token: TOKEN, id: BOT_ID, username: "hook_bot" }] });
  });
  afterEach(async () => {
    await tg?.close();
  });

  const handle = (
    kv: Kv | undefined,
    body: string | object,
    headers = telegramWebhookHeaders(SECRET),
    signal = new AbortController().signal,
  ) => {
    const channel = createTelegramChannel({ apiUrl: tg.apiUrl, log, ...(kv && { kv }) });
    if (!channel.webhook) throw new Error("no webhook");
    return channel.webhook.handle({
      connectionId: "conn1",
      config,
      request: request(body, headers),
      signal,
    });
  };

  it("yields the same event as the long-poll parser for the same update", async () => {
    const { kv } = memoryKv();
    const update = { update_id: 11, ...telegramPrivateMessage(user, "hello", { messageId: 77 }) };
    const r = await handle(kv, update);
    const polled = await updateToInbound(
      update,
      { id: BOT_ID, username: "hook_bot" },
      threadStore(memoryKv().kv, String(BOT_ID)),
    );
    expect(r.kind).toBe("events");
    if (r.kind !== "events") return;
    expect(r.events).toEqual([polled]);
    expect(r.events[0]).toMatchObject({ type: "message", messageId: "42:77" });
    expect(r.ack).toEqual({ status: 200 });
  });

  it("acks an ignored update with no events", async () => {
    const r = await handle(memoryKv().kv, { update_id: 12, edited_message: { message_id: 1 } });
    expect(r).toEqual({ kind: "events", events: [], ack: { status: 200 } });
  });

  it("never calls Telegram for a request that fails the secret check", async () => {
    const r = await handle(memoryKv().kv, { update_id: 13 }, telegramWebhookHeaders("wrong"));
    expect(r).toEqual({ kind: "reject", status: 401 });
    expect(tg.calls).toHaveLength(0);
  });

  it("caches the bot identity in kv for an hour and calls getMe once", async () => {
    const { kv, data, ttls } = memoryKv();
    await handle(kv, { update_id: 20, ...telegramPrivateMessage(user, "one") });
    await handle(kv, { update_id: 21, ...telegramPrivateMessage(user, "two") });
    expect(tg.calls.filter((c) => c.method.toLowerCase() === "getme")).toHaveLength(1);
    expect(JSON.parse(data.get(`bot/${BOT_ID}`) ?? "null")).toEqual({
      id: BOT_ID,
      username: "hook_bot",
    });
    expect(ttls.get(`bot/${BOT_ID}`)).toBe(BOT_IDENTITY_TTL_SECONDS);
    expect(BOT_IDENTITY_TTL_SECONDS).toBe(3600);
  });

  it("falls back to getMe when the cached identity is unreadable or kv fails", async () => {
    const { kv, data } = memoryKv();
    data.set(`bot/${BOT_ID}`, "{broken");
    const r = await handle(kv, { update_id: 22, ...telegramPrivateMessage(user, "x") });
    expect(r.kind === "events" && r.events).toHaveLength(1);
    const failing = {
      get: async () => {
        throw new Error("kv down");
      },
      set: async () => {
        throw new Error("kv down");
      },
    } as unknown as Kv;
    const r2 = await handle(failing, { update_id: 23, ...telegramPrivateMessage(user, "y") });
    expect(r2.kind === "events" && r2.events).toHaveLength(1);
    expect(tg.calls.filter((c) => c.method.toLowerCase() === "getme")).toHaveLength(2);
  });

  it("throws (so Telegram redelivers) when getMe fails, without leaking the token", async () => {
    tg.failNext("getMe", { status: 500, description: "Internal Server Error" });
    const p = handle(memoryKv().kv, { update_id: 24, ...telegramPrivateMessage(user, "z") });
    await expect(p).rejects.toThrow();
    await p.catch((e: unknown) => {
      expect(String(e instanceof Error ? e.message : e)).not.toContain("s3cr3t");
    });
  });

  it("turns a card button press into an event and answers the callback query", async () => {
    const { kv } = memoryKv();
    const token = await cardTokenStore(kv, String(BOT_ID)).put({
      cardKind: "approval",
      cardId: "ap1",
      action: "deny",
    });
    const update = {
      update_id: 30,
      ...telegramCallback(user, { chatId: 42, messageId: 9 }, `cb:${token}`, { id: "cbq-w1" }),
    };
    const r = await handle(kv, update);
    expect(r.kind === "events" && r.events.map((e) => e.type)).toEqual(["card_action"]);
    expect(tg.callbackAnswers).toContain("cbq-w1");
  });

  it("answers an ignored callback query too, and logs a failed answer without the token", async () => {
    const update = {
      update_id: 31,
      ...telegramCallback(user, { chatId: 42, messageId: 9 }, "cb:AAAAAAAAAAAAAAAA", {
        id: "cbq-w2",
      }),
    };
    const r = await handle(memoryKv().kv, update);
    expect(r).toEqual({ kind: "events", events: [], ack: { status: 200 } });
    expect(tg.callbackAnswers).toContain("cbq-w2");

    tg.failNext("answerCallbackQuery", {
      status: 400,
      description: "Bad Request: query is too old",
    });
    const r2 = await handle(memoryKv().kv, { ...update, update_id: 32 });
    expect(r2.kind).toBe("events");
    const warn = logs.find((l) => /answerCallbackQuery failed/.test(l.msg));
    expect(warn).toBeDefined();
    expect(JSON.stringify(warn)).not.toContain("s3cr3t");
  });

  it("yields the same card_action event as long polling for the same callback query", async () => {
    const { kv } = memoryKv();
    const token = await cardTokenStore(kv, String(BOT_ID)).put({
      cardKind: "approval",
      cardId: "ap2",
      action: "approve",
      scope: "once",
    });
    const callback = telegramCallback(user, { chatId: 42, messageId: 9 }, `cb:${token}`, {
      id: "cbq-parity",
    });

    const polled: InboundEvent[] = [];
    const ac = new AbortController();
    const channel = createTelegramChannel({ apiUrl: tg.apiUrl, log, kv, pollTimeoutSec: 1 });
    const done = channel.connect({
      connectionId: "conn1",
      config: { botToken: TOKEN },
      signal: ac.signal,
      onEvent: async (e) => void polled.push(e),
    });
    const updateId = tg.push(callback);
    await vi.waitFor(() => expect(polled).toHaveLength(1));
    ac.abort();
    await done;

    const r = await handle(kv, { update_id: updateId, ...callback });
    expect(r.kind === "events" && r.events).toEqual(polled);
    expect(polled[0]).toMatchObject({
      type: "card_action",
      eventId: "cbq-parity",
      messageId: "42:9",
    });
  });

  it("does not warn when the callback answer fails because the request was aborted", async () => {
    const { kv, data } = memoryKv();
    data.set(`bot/${BOT_ID}`, JSON.stringify({ id: BOT_ID, username: "hook_bot" }));
    tg.delay("answerCallbackQuery", 2000);
    const ac = new AbortController();
    const update = {
      update_id: 40,
      ...telegramCallback(user, { chatId: 42, messageId: 9 }, "cb:AAAAAAAAAAAAAAAA"),
    };
    const p = handle(kv, update, telegramWebhookHeaders(SECRET), ac.signal);
    await vi.waitFor(() =>
      expect(tg.calls.some((c) => c.method.toLowerCase() === "answercallbackquery")).toBe(true),
    );
    ac.abort();
    expect(await p).toEqual({ kind: "events", events: [], ack: { status: 200 } });
    expect(logs.some((l) => /answerCallbackQuery failed/.test(l.msg))).toBe(false);
  });

  it("logs a group's migration to a supergroup at info and acks it without calling Telegram", async () => {
    const update = {
      update_id: 50,
      message: {
        message_id: 3,
        date: 1,
        chat: { id: -100, type: "group" },
        from: { id: 42, is_bot: false, first_name: "Ada" },
        migrate_to_chat_id: -1001234,
      },
    };
    const r = await handle(memoryKv().kv, update);
    expect(r).toEqual({ kind: "events", events: [], ack: { status: 200 } });
    const line = logs.find((l) => l.level === "info" && /supergroup/.test(l.msg));
    expect(line?.fields).toEqual({
      connectionId: "conn1",
      chatId: -100,
      migrateToChatId: -1001234,
    });
    expect(tg.calls).toHaveLength(0);
  });
});
