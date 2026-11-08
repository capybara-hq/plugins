import { ChannelSendError } from "@capybara-hq/plugin-sdk";
import { type FakeTelegramServer, startFakeTelegram } from "@capybara-hq/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTelegramChannel } from "../src/channel.js";
import { TEXT_LIMIT } from "../src/html.js";
import type { Kv } from "../src/threads.js";

let tg: FakeTelegramServer;
beforeAll(async () => {
  tg = await startFakeTelegram({
    bots: [
      { token: "111:plain", id: 111, username: "plain_bot" },
      {
        token: "222:loud",
        id: 222,
        username: "loud_bot",
        canReadAllGroupMessages: true,
        hasTopicsEnabled: true,
      },
    ],
  });
});
afterAll(async () => {
  await tg?.close();
});
beforeEach(() => {
  tg.messages.length = 0;
  tg.edits.length = 0;
  tg.calls.length = 0;
});

const memoryKv = () => {
  const data = new Map<string, string>();
  const kv = {
    get: async (key: string) => data.get(key) ?? null,
    set: async (key: string, value: string) => {
      data.set(key, value);
    },
  } as unknown as Kv;
  return { kv, data };
};
const warnings: string[] = [];
const log = {
  info() {},
  warn: (m: string) => void warnings.push(m),
  error() {},
};
const config = { botToken: "111:plain" };
const signal = () => new AbortController().signal;
const make = (kv?: Kv) => createTelegramChannel({ apiUrl: tg.apiUrl, log, ...(kv && { kv }) });
const dm = { chatId: "42", chatType: "dm" as const };
const approval = {
  kind: "approval" as const,
  id: "ap1",
  title: "Run deploy",
  toolName: "deploy",
  agentName: "Bot",
  inputPreview: "{}",
  scopes: ["once" as const],
  expiresAt: "2026-11-09T00:00:00Z",
  state: "pending" as const,
  webUrl: "https://cap.example/c/1",
};
const base = { config, locale: "en" as const, signal: signal() };
const sendErr = async (p: Promise<unknown>) => {
  const e = await p.then(
    () => undefined,
    (x) => x,
  );
  expect(e).toBeInstanceOf(ChannelSendError);
  return e as ChannelSendError;
};

describe("verify", () => {
  it("returns the bot identity with a tenant that is never the sender tenant", async () => {
    const r = await make().verify({ config, signal: signal() });
    expect(r).toEqual({ botUserId: "111", botName: "@plain_bot", tenantId: "bot111" });
    expect(r.tenantId).not.toBe("global");
  });

  it("warns about privacy mode off and private-chat topics, never with the token", async () => {
    warnings.length = 0;
    await make().verify({ config: { botToken: "222:loud" }, signal: signal() });
    expect(warnings).toHaveLength(2);
    expect(warnings.join(" ")).not.toContain("loud");
    warnings.length = 0;
    await make().verify({ config, signal: signal() });
    expect(warnings).toHaveLength(0);
  });
});

describe("send", () => {
  it("sends a dm as HTML without link previews and returns <chat>:<id>", async () => {
    const r = await make().send({ ...base, target: dm, message: { text: "**hi** a<b" } });
    expect(tg.messages).toHaveLength(1);
    expect(r.messageId).toBe(`42:${tg.messages[0]?.messageId}`);
    const call = tg.calls.find((c) => c.method === "sendMessage");
    expect(call?.params).toMatchObject({
      chat_id: "42",
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    });
    expect(String(call?.params.text)).toBe("<b>hi</b> a&lt;b");
  });

  it("splits long text and returns the last id; ignores idempotencyKey", async () => {
    const text = `${"a".repeat(TEXT_LIMIT - 10)} ${"b".repeat(100)}`;
    const r = await make().send({ ...base, target: dm, message: { text }, idempotencyKey: "k1" });
    expect(tg.messages).toHaveLength(2);
    expect(r.messageId).toBe(`42:${tg.messages[1]?.messageId}`);
    expect(JSON.stringify(tg.calls.map((c) => c.params))).not.toContain("k1");
  });

  it("sends one message per card after the text, with a keyboard", async () => {
    await make().send({
      ...base,
      target: dm,
      message: { text: "see", cards: [approval] },
    });
    expect(tg.messages).toHaveLength(2);
    expect(tg.messages[0]?.replyMarkup).toBeUndefined();
    expect(tg.messages[1]?.replyMarkup).toBeDefined();
  });

  it("sends only the card when the text repeats the card's headline (the bind prompt)", async () => {
    const text = "Please link your Capybara account before chatting with me.";
    await make().send({
      ...base,
      target: dm,
      message: { text, cards: [{ kind: "bind", url: "https://cap.example/bind/t", text }] },
    });
    expect(tg.messages).toHaveLength(1);
    expect(tg.messages[0]?.text).toBe(text);
    expect(tg.messages[0]?.replyMarkup).toBeDefined();
  });

  it("still sends the text when it only starts with the card's headline", async () => {
    const headline = "Please link your Capybara account before chatting with me.";
    const text = `${headline} It takes a minute.`;
    await make().send({
      ...base,
      target: dm,
      message: {
        text,
        cards: [{ kind: "bind", url: "https://cap.example/bind/t", text: headline }],
      },
    });
    expect(tg.messages).toHaveLength(2);
    expect(tg.messages[0]?.text).toBe(text);
    expect(tg.messages[0]?.replyMarkup).toBeUndefined();
    expect(tg.messages[1]?.text).toBe(headline);
    expect(tg.messages[1]?.replyMarkup).toBeDefined();
  });

  it("sends only the card when the text is empty", async () => {
    await make().send({ ...base, target: dm, message: { text: "", cards: [approval] } });
    expect(tg.messages).toHaveLength(1);
  });

  it("rejects an empty message without calling Telegram", async () => {
    const e = await sendErr(make().send({ ...base, target: dm, message: { text: " " } }));
    expect(e.retryable).toBe(false);
    expect(tg.calls).toHaveLength(0);
  });

  it("replies to the thread root in a group and records every sent message", async () => {
    const { kv, data } = memoryKv();
    const group = { chatId: "-100", chatType: "group" as const, threadId: "-100:5" };
    const r = await make(kv).send({
      ...base,
      target: group,
      message: { text: "ok", cards: [approval] },
    });
    expect(tg.calls.filter((c) => c.method === "sendMessage")[0]?.params).toMatchObject({
      reply_parameters: { message_id: 5, allow_sending_without_reply: true },
    });
    expect(tg.messages).toHaveLength(2);
    for (const m of tg.messages) expect(data.get(`thread/111/-100:${m.messageId}`)).toBe("-100:5");
    expect(r.messageId).toBe(`-100:${tg.messages[1]?.messageId}`);
  });

  it("records nothing for a group send without a threadId", async () => {
    const { kv, data } = memoryKv();
    await make(kv).send({
      ...base,
      target: { chatId: "-100", chatType: "group" },
      message: { text: "ok" },
    });
    expect(data.size).toBe(0);
  });

  it("uses the recorded forum topic as message_thread_id", async () => {
    const { kv } = memoryKv();
    await kv.set("topic/111/-100:5", "77", { ttlSeconds: 1 });
    await make(kv).send({
      ...base,
      target: { chatId: "-100", chatType: "group", threadId: "-100:5" },
      message: { text: "ok" },
    });
    expect(tg.calls.find((c) => c.method === "sendMessage")?.params.message_thread_id).toBe(77);
  });

  it("maps a blocked bot to target_gone and a flood wait to a retryable error", async () => {
    tg.failNext("sendMessage", {
      status: 403,
      description: "Forbidden: bot was blocked by the user",
    });
    const gone = await sendErr(make().send({ ...base, target: dm, message: { text: "x" } }));
    expect(gone).toMatchObject({ retryable: false, reason: "target_gone" });
    tg.failNext("sendMessage", {
      status: 429,
      description: "Too Many Requests: retry after 3",
      retryAfter: 3,
    });
    const limited = await sendErr(make().send({ ...base, target: dm, message: { text: "x" } }));
    expect(limited).toMatchObject({ retryable: true, retryAfterMs: 3000 });
  });

  it("still resolves when recording the thread fails, and warns", async () => {
    const kv = {
      get: async () => null,
      set: async () => {
        throw new Error("kv down");
      },
    } as unknown as Kv;
    warnings.length = 0;
    const r = await make(kv).send({
      ...base,
      target: { chatId: "-100", chatType: "group", threadId: "-100:5" },
      message: { text: "ok" },
    });
    expect(r.messageId).toMatch(/^-100:\d+$/);
    expect(tg.messages).toHaveLength(1);
    expect(warnings).toHaveLength(1);
  });

  it("part 2 failing with 429 is retryable and part 1 stays recorded", async () => {
    const { kv, data } = memoryKv();
    const inner = kv.set.bind(kv);
    // The first record happens after part 1 and before part 2: arm the failure there.
    kv.set = (async (k: string, v: string, o: { ttlSeconds: number }) => {
      await inner(k, v, o as never);
      tg.failNext("sendMessage", { status: 429, description: "Too Many Requests", retryAfter: 2 });
    }) as Kv["set"];
    const text = `${"a".repeat(TEXT_LIMIT - 10)} ${"b".repeat(100)}`;
    const e = await sendErr(
      make(kv).send({
        ...base,
        target: { chatId: "-100", chatType: "group", threadId: "-100:5" },
        message: { text },
      }),
    );
    expect(e).toMatchObject({ retryable: true, retryAfterMs: 2000 });
    expect(tg.messages).toHaveLength(1);
    expect(data.get(`thread/111/-100:${tg.messages[0]?.messageId}`)).toBe("-100:5");
  });

  it("rejects a malformed thread id without calling Telegram", async () => {
    const e = await sendErr(
      make().send({
        ...base,
        target: { chatId: "-100", chatType: "group", threadId: "nope" },
        message: { text: "x" },
      }),
    );
    expect(e.retryable).toBe(false);
  });
});

describe("update", () => {
  it("edits the message text as HTML", async () => {
    const { messageId } = await make().send({ ...base, target: dm, message: { text: "a" } });
    await make().update({ ...base, target: dm, messageId, message: { text: "**b**" } });
    expect(tg.edits).toHaveLength(1);
    expect(tg.edits[0]?.text).toBe("<b>b</b>");
    const call = tg.calls.find((c) => c.method === "editMessageText");
    expect(call?.params).toMatchObject({
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    });
  });

  it("resolves on 'message is not modified'", async () => {
    const { messageId } = await make().send({ ...base, target: dm, message: { text: "a" } });
    tg.failNext("editMessageText", {
      status: 400,
      description:
        "Bad Request: message is not modified: specified new message content and reply markup are exactly the same as a current content and reply markup of the message",
    });
    await expect(
      make().update({ ...base, target: dm, messageId, message: { text: "a" } }),
    ).resolves.toBeUndefined();
  });

  it("throws a non-retryable too_large over the limit, without calling Telegram", async () => {
    const { messageId } = await make().send({ ...base, target: dm, message: { text: "a" } });
    tg.calls.length = 0;
    const e = await sendErr(
      make().update({
        ...base,
        target: dm,
        messageId,
        message: { text: "x".repeat(TEXT_LIMIT + 1) },
      }),
    );
    expect(e).toMatchObject({ retryable: false, reason: "too_large" });
    expect(tg.calls).toHaveLength(0);
  });

  it("card-only update edits to the card text and keyboard", async () => {
    const { messageId } = await make().send({ ...base, target: dm, message: { text: "a" } });
    await make().update({
      ...base,
      target: dm,
      messageId,
      message: { text: "", cards: [approval] },
    });
    expect(tg.edits[0]?.text).toContain("deploy");
    expect(tg.edits[0]?.replyMarkup).toBeDefined();
  });

  it("text-only update sends no reply_markup, which removes a keyboard", async () => {
    const { messageId } = await make().send({
      ...base,
      target: dm,
      message: { text: "", cards: [approval] },
    });
    tg.calls.length = 0;
    await make().update({ ...base, target: dm, messageId, message: { text: "done" } });
    const call = tg.calls.find((c) => c.method === "editMessageText");
    expect(call?.params).not.toHaveProperty("reply_markup");
  });

  it("text plus a card is too_large without calling Telegram", async () => {
    const e = await sendErr(
      make().update({
        ...base,
        target: dm,
        messageId: "42:1",
        message: { text: "b", cards: [approval] },
      }),
    );
    expect(e).toMatchObject({ retryable: false, reason: "too_large" });
    expect(tg.calls).toHaveLength(0);
  });

  it("maps a gone chat to target_gone", async () => {
    tg.failNext("editMessageText", { status: 400, description: "Bad Request: chat not found" });
    const e = await sendErr(
      make().update({ ...base, target: dm, messageId: "42:1", message: { text: "a" } }),
    );
    expect(e.reason).toBe("target_gone");
  });
});
