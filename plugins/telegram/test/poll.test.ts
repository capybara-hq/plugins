import type { InboundEvent } from "@capybara-hq/plugin-sdk";
import {
  type FakeTelegramServer,
  startFakeTelegram,
  telegramCallback,
  telegramPrivateMessage,
} from "@capybara-hq/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cardTokenStore } from "../src/actions.js";
import { createTelegramChannel } from "../src/channel.js";
import { OFFSET_TTL_SECONDS } from "../src/poll.js";
import type { Kv } from "../src/threads.js";

const TOKEN = "333:s3cr3t-poll-token";
const BOT_ID = 333;
const user = { id: 42, first_name: "Ada" };

let tg: FakeTelegramServer;
beforeEach(async () => {
  tg = await startFakeTelegram({ bots: [{ token: TOKEN, id: BOT_ID, username: "poll_bot" }] });
});
afterEach(async () => {
  await tg?.close();
});

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

/** Starts `connect`; the returned promise is observed so a rejection never goes unhandled. */
function connect(o: {
  onEvent?: (e: InboundEvent) => Promise<void>;
  kv?: Kv;
  token?: string;
  pollTimeoutSec?: number;
}) {
  const ac = new AbortController();
  const events: InboundEvent[] = [];
  const channel = createTelegramChannel({
    apiUrl: tg.apiUrl,
    log,
    backoffBaseMs: 10,
    pollTimeoutSec: o.pollTimeoutSec ?? 1,
    ...(o.kv && { kv: o.kv }),
  });
  const done = channel.connect({
    connectionId: "conn1",
    config: { botToken: o.token ?? TOKEN },
    signal: ac.signal,
    onEvent: async (e) => {
      if (o.onEvent) await o.onEvent(e);
      events.push(e);
    },
  });
  const settled = done.then(
    () => ({ ok: true as const }),
    (error: unknown) => ({ ok: false as const, error: error as Error }),
  );
  return { ac, events, done: settled };
}

const idOf = (e: InboundEvent): string =>
  e.type === "message" ? e.messageId : e.type === "card_action" ? (e.eventId ?? "") : "";
const failedWith = async (done: Promise<{ ok: boolean; error?: Error }>) => {
  const r = await done;
  expect(r.ok).toBe(false);
  expect(r.error?.message).not.toContain(TOKEN);
  expect(r.error?.message).not.toContain("s3cr3t");
  return r.error?.message;
};

describe("long polling", () => {
  it("delivers pushed messages in order and confirms past them", async () => {
    const c = connect({});
    tg.push(telegramPrivateMessage(user, "one", { messageId: 1 }));
    const last = tg.push(telegramPrivateMessage(user, "two", { messageId: 2 }));
    await vi.waitFor(() => expect(tg.confirmedOffset()).toBe(last + 1));
    expect(c.events.map(idOf)).toEqual(["42:1", "42:2"]);
    c.ac.abort();
    expect((await c.done).ok).toBe(true);
  });

  it("does not confirm or skip past an update whose onEvent rejected", async () => {
    let failing = true;
    const attempts: string[] = [];
    const c = connect({
      onEvent: async (e) => {
        attempts.push(idOf(e));
        if (failing && idOf(e) === "42:2") throw new Error("queue down");
      },
    });
    const first = tg.push(telegramPrivateMessage(user, "one", { messageId: 1 }));
    tg.push(telegramPrivateMessage(user, "two", { messageId: 2 }));
    const third = tg.push(telegramPrivateMessage(user, "three", { messageId: 3 }));
    await vi.waitFor(() => expect(attempts.filter((a) => a === "42:2").length).toBeGreaterThan(2));
    expect(attempts).not.toContain("42:3");
    expect(tg.confirmedOffset()).toBe(first + 1);
    failing = false;
    await vi.waitFor(() => expect(tg.confirmedOffset()).toBe(third + 1));
    // Every accepted event exactly once, in order.
    expect(c.events.map(idOf)).toEqual(["42:1", "42:2", "42:3"]);
    expect(logs.some((l) => l.level === "warn" && /not accepted/.test(l.msg))).toBe(true);
    c.ac.abort();
    expect((await c.done).ok).toBe(true);
  });

  it("refetches when the parser's kv fails, without confirming", async () => {
    const { kv } = memoryKv();
    let down = true;
    const flaky = {
      get: async (k: string) => {
        if (down && k.startsWith("card/")) throw new Error("kv down");
        return kv.get(k);
      },
      set: kv.set,
    } as Kv;
    const token = await cardTokenStore(kv, String(BOT_ID)).put({
      cardKind: "approval",
      cardId: "ap1",
      action: "deny",
    });
    const c = connect({ kv: flaky });
    const id = tg.push(telegramCallback(user, { chatId: 42, messageId: 9 }, `cb:${token}`));
    await vi.waitFor(() => expect(logs.some((l) => /not accepted/.test(l.msg))).toBe(true));
    expect(c.events).toHaveLength(0);
    expect(tg.confirmedOffset()).toBeLessThanOrEqual(id);
    down = false;
    await vi.waitFor(() => expect(tg.confirmedOffset()).toBe(id + 1));
    expect(c.events).toHaveLength(1);
    c.ac.abort();
    await c.done;
  });

  it("refuses to poll while a webhook is set", async () => {
    tg.setWebhook("https://example.com/hook");
    const c = connect({});
    expect(await failedWith(c.done)).toBe(
      "A webhook is set for this Telegram bot; switch the connection to webhook mode or call deleteWebhook",
    );
    expect(tg.calls.some((x) => x.method.toLowerCase() === "getupdates")).toBe(false);
  });

  it("throws on 409 Conflict", async () => {
    tg.failNext("getUpdates", {
      status: 409,
      description: "Conflict: terminated by other getUpdates request",
    });
    const c = connect({});
    expect(await failedWith(c.done)).toBe(
      "Telegram getUpdates conflict: another client is polling this bot",
    );
  });

  it("throws on a rejected token (getMe or getUpdates)", async () => {
    const unknown = connect({ token: "999:s3cr3t-unknown" });
    expect(await failedWith(unknown.done)).toBe("Telegram bot token rejected");
    tg.failNext("getUpdates", { status: 401, description: "Unauthorized" });
    const revoked = connect({});
    expect(await failedWith(revoked.done)).toBe("Telegram bot token rejected");
  });

  it("backs off on 5xx and recovers; five in a row throw", async () => {
    tg.failNext("getUpdates", { status: 502, description: "Bad Gateway" }, 4);
    const ok = connect({});
    tg.push(telegramPrivateMessage(user, "hi", { messageId: 1 }));
    await vi.waitFor(() => expect(ok.events).toHaveLength(1));
    ok.ac.abort();
    expect((await ok.done).ok).toBe(true);

    tg.failNext("getUpdates", { status: 500, description: "Internal Server Error" }, 5);
    const bad = connect({});
    expect(await failedWith(bad.done)).toBe(
      "Telegram getUpdates failed: 500 Internal Server Error",
    );
  });

  it("honors retry_after on 429", async () => {
    tg.failNext("getUpdates", {
      status: 429,
      description: "Too Many Requests: retry after 1",
      retryAfter: 1,
    });
    const started = Date.now();
    const c = connect({});
    tg.push(telegramPrivateMessage(user, "hi", { messageId: 1 }));
    await vi.waitFor(() => expect(c.events).toHaveLength(1), { timeout: 3000 });
    expect(Date.now() - started).toBeGreaterThanOrEqual(950);
    c.ac.abort();
    await c.done;
  });

  it("returns within a second of the abort while getUpdates is pending", async () => {
    const c = connect({ pollTimeoutSec: 25 });
    await vi.waitFor(() => expect(tg.activePollers()).toBe(1));
    const t0 = Date.now();
    c.ac.abort();
    expect((await c.done).ok).toBe(true);
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it("returns within a second of the abort during a backoff", async () => {
    const c = connect({ onEvent: () => Promise.reject(new Error("down")) });
    tg.push(telegramPrivateMessage(user, "hi", { messageId: 1 }));
    await vi.waitFor(() => expect(logs.some((l) => /not accepted/.test(l.msg))).toBe(true));
    const t0 = Date.now();
    c.ac.abort();
    expect((await c.done).ok).toBe(true);
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it("stores the offset in kv and a new connect resumes from it", async () => {
    const { kv, data, ttls } = memoryKv();
    const a = connect({ kv });
    const id = tg.push(telegramPrivateMessage(user, "one", { messageId: 1 }));
    await vi.waitFor(() => expect(data.get(`offset/${BOT_ID}`)).toBe(String(id + 1)));
    expect(ttls.get(`offset/${BOT_ID}`)).toBe(OFFSET_TTL_SECONDS);
    a.ac.abort();
    await a.done;

    tg.calls.length = 0;
    const b = connect({ kv });
    const getUpdates = () => tg.calls.find((x) => x.method.toLowerCase() === "getupdates");
    await vi.waitFor(() => expect(getUpdates()).toBeDefined());
    expect(getUpdates()?.params.offset).toBe(id + 1);
    b.ac.abort();
    await b.done;
  });

  it("keeps polling when storing the offset fails", async () => {
    const kv = {
      get: async () => null,
      set: () => Promise.reject(new Error("kv down")),
    } as unknown as Kv;
    const c = connect({ kv });
    tg.push(telegramPrivateMessage(user, "one", { messageId: 1 }));
    const last = tg.push(telegramPrivateMessage(user, "two", { messageId: 2 }));
    await vi.waitFor(() => expect(tg.confirmedOffset()).toBe(last + 1));
    expect(c.events).toHaveLength(2);
    expect(logs.some((l) => /could not store/.test(l.msg))).toBe(true);
    c.ac.abort();
    expect((await c.done).ok).toBe(true);
  });

  it("answers a callback query only after its onEvent resolved", async () => {
    const { kv } = memoryKv();
    const token = await cardTokenStore(kv, String(BOT_ID)).put({
      cardKind: "approval",
      cardId: "ap1",
      action: "approve",
      scope: "once",
    });
    const answeredDuringOnEvent: boolean[] = [];
    const c = connect({
      kv,
      onEvent: async () => {
        await new Promise((r) => setTimeout(r, 50));
        answeredDuringOnEvent.push(tg.callbackAnswers.includes("cbq-1"));
      },
    });
    tg.push(telegramCallback(user, { chatId: 42, messageId: 9 }, `cb:${token}`, { id: "cbq-1" }));
    await vi.waitFor(() => expect(tg.callbackAnswers).toContain("cbq-1"));
    expect(answeredDuringOnEvent).toEqual([false]);
    expect(c.events.map(idOf)).toEqual(["cbq-1"]);
    c.ac.abort();
    await c.done;
  });

  it("answers and confirms an ignored click without an event", async () => {
    const { kv } = memoryKv();
    const c = connect({ kv });
    const id = tg.push(
      telegramCallback(user, { chatId: 42, messageId: 9 }, "cb:AAAAAAAAAAAAAAAA", { id: "cbq-2" }),
    );
    await vi.waitFor(() => expect(tg.confirmedOffset()).toBe(id + 1));
    expect(tg.callbackAnswers).toContain("cbq-2");
    expect(c.events).toHaveLength(0);
    c.ac.abort();
    await c.done;
  });

  it("logs a group migration and confirms it", async () => {
    const c = connect({});
    const id = tg.push({
      message: {
        message_id: 7,
        date: 1,
        chat: { id: -100, type: "group", title: "Team" },
        from: { id: 42, is_bot: false, first_name: "Ada" },
        migrate_to_chat_id: -1001234,
      },
    });
    await vi.waitFor(() => expect(tg.confirmedOffset()).toBe(id + 1));
    const line = logs.find((l) => l.level === "info" && /supergroup/.test(l.msg));
    expect(line?.fields).toMatchObject({ chatId: -100, migrateToChatId: -1001234 });
    expect(c.events).toHaveLength(0);
    c.ac.abort();
    await c.done;
  });
});
