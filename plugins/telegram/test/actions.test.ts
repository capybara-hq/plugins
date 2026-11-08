import { describe, expect, it } from "vitest";
import {
  CALLBACK_PREFIX,
  type CardTokenStore,
  cardTokenStore,
  decodeCardAction,
  parseCallback,
} from "../src/actions.js";
import { updateToInbound } from "../src/inbound.js";
import { type Kv, threadStore } from "../src/threads.js";

const memoryKv = () => {
  const data = new Map<string, string>();
  const ttls = new Map<string, number>();
  const kv = {
    get: async (key: string) => data.get(key) ?? null,
    set: async (key: string, value: string, opts: { ttlSeconds: number }) => {
      data.set(key, value);
      ttls.set(key, opts.ttlSeconds);
    },
  } as Kv;
  return { kv, data, ttls };
};

const approve = {
  cardKind: "approval",
  cardId: "c1",
  action: "approve",
  scope: "once",
} as const;
const BOT = { id: 999, username: "mybot" };
const ann = { id: 42, is_bot: false, first_name: "Ann" };

const click = (message: Record<string, unknown>, data: string) => ({
  update_id: 5,
  callback_query: { id: "cq1", from: ann, message, data },
});

describe("card tokens", () => {
  it("round trips an action under a 16-char base64url token with a 30-day TTL", async () => {
    const { kv, data, ttls } = memoryKv();
    const store = cardTokenStore(kv, "999");
    const token = await store.put(approve);
    expect(token).toMatch(/^[A-Za-z0-9_-]{16}$/);
    expect(Buffer.byteLength(`${CALLBACK_PREFIX}${token}`)).toBeLessThanOrEqual(64);
    expect(ttls.get(`card/999/${token}`)).toBe(2_592_000);
    expect(data.get(`card/999/${token}`)).toBe(JSON.stringify(approve));
    expect(await store.take(token)).toEqual(approve);
    expect(await store.take(token)).toEqual(approve); // clicks may repeat
  });

  it("an unknown or malformed token, or another bot's token, is null", async () => {
    const { kv } = memoryKv();
    const store = cardTokenStore(kv, "999");
    const token = await store.put(approve);
    expect(await store.take("AAAAAAAAAAAAAAAA")).toBeNull();
    expect(await store.take("short")).toBeNull();
    expect(await cardTokenStore(kv, "1").take(token)).toBeNull();
    expect(await cardTokenStore(undefined, "999").take(token)).toBeNull();
  });

  it("put without a kv throws so renderers fall back to URL buttons", async () => {
    await expect(cardTokenStore(undefined, "999").put(approve)).rejects.toThrow();
  });
});

describe("decodeCardAction", () => {
  const ok = (v: unknown) => decodeCardAction(JSON.stringify(v));
  it("accepts the three action shapes", () => {
    expect(ok(approve)).toEqual(approve);
    expect(ok({ cardKind: "approval", cardId: "c", action: "deny" })).toEqual({
      cardKind: "approval",
      cardId: "c",
      action: "deny",
    });
    const q = { cardKind: "question", cardId: "c", action: "answer", answer: { k: "a" } };
    expect(ok(q)).toEqual(q);
  });
  it("rejects tampered payloads", () => {
    expect(ok({ ...approve, scope: "forever" })).toBeNull();
    expect(ok({ ...approve, scope: undefined })).toBeNull();
    expect(ok({ ...approve, cardKind: "bogus" })).toBeNull();
    expect(ok({ ...approve, cardKind: "question" })).toBeNull();
    expect(ok({ ...approve, cardId: "" })).toBeNull();
    expect(ok({ cardKind: "approval", cardId: "c", action: "deny", scope: "once" })).toBeNull();
    expect(ok({ cardKind: "question", cardId: "c", action: "answer" })).toBeNull();
    expect(ok({ cardKind: "question", cardId: "c", action: "answer", answer: {} })).toBeNull();
    expect(
      ok({ cardKind: "question", cardId: "c", action: "answer", answer: { k: { x: 1 } } }),
    ).toBeNull();
    expect(
      ok({ cardKind: "question", cardId: "c", action: "answer", answer: { k: [1] } }),
    ).toBeNull();
    expect(ok([approve])).toBeNull();
    expect(decodeCardAction("not json")).toBeNull();
    expect(decodeCardAction("")).toBeNull();
    expect(decodeCardAction("x".repeat(9000))).toBeNull();
  });
});

describe("parseCallback", () => {
  const setup = async () => {
    const { kv } = memoryKv();
    const tokens = cardTokenStore(kv, "999");
    const threads = threadStore(kv, "999");
    const token = await tokens.put(approve);
    return { tokens, threads, data: `${CALLBACK_PREFIX}${token}` };
  };
  const dmMsg = { message_id: 7, chat: { id: 42, type: "private" } };
  const groupMsg = { message_id: 8, chat: { id: -100, type: "supergroup" } };

  it("a dm click becomes a card_action with the callback query id as eventId", async () => {
    const { tokens, threads, data } = await setup();
    const r = await parseCallback(click(dmMsg, data), tokens, threads);
    expect(r?.callbackQueryId).toBe("cq1");
    expect(r?.event).toEqual({
      type: "card_action",
      messageId: "42:7",
      eventId: "cq1",
      target: { chatId: "42", chatType: "dm" },
      sender: { externalId: "42", tenantId: "global", displayName: "Ann" },
      action: approve,
    });
  });

  it("a group click carries the thread recorded for the card message", async () => {
    const { tokens, threads, data } = await setup();
    const none = await parseCallback(click(groupMsg, data), tokens, threads);
    expect(none?.event).toMatchObject({ target: { chatId: "-100", chatType: "group" } });
    expect(none?.event).not.toHaveProperty("target.threadId");
    await threads.recordSent("-100", 8, "-100:3");
    const r = await parseCallback(click(groupMsg, data), tokens, threads);
    expect(r?.event).toMatchObject({
      messageId: "-100:8",
      target: { chatId: "-100", chatType: "group", threadId: "-100:3" },
    });
  });

  it("ignores unknown tokens, foreign data, tampered kv and bad shapes", async () => {
    const { kv, data: store } = memoryKv();
    const tokens = cardTokenStore(kv, "999");
    const threads = threadStore(kv, "999");
    const good = `${CALLBACK_PREFIX}${await tokens.put(approve)}`;
    const key = [...store.keys()].find((k) => k.startsWith("card/"));
    if (!key) throw new Error("no card key");
    store.set(key, JSON.stringify({ ...approve, scope: "forever" }));
    expect(await parseCallback(click(dmMsg, good), tokens, threads)).toBeNull();
    for (const data of [`${CALLBACK_PREFIX}AAAAAAAAAAAAAAAA`, "other:abc", "cb:", ""]) {
      expect(await parseCallback(click(dmMsg, data), tokens, threads)).toBeNull();
    }
    const q = (patch: Record<string, unknown>) => ({
      callback_query: { id: "x", from: ann, message: dmMsg, data: good, ...patch },
    });
    for (const u of [
      q({ from: { ...ann, is_bot: true } }),
      q({ message: undefined }), // inline-mode or inaccessible message
      q({ message: { message_id: 0, chat: dmMsg.chat } }),
      q({ message: { message_id: 1, chat: { id: 1, type: "channel" } } }),
      q({ id: "" }),
      {},
      null,
    ]) {
      expect(await parseCallback(u, tokens, threads)).toBeNull();
    }
  });

  it("updateToInbound routes callback_query updates through the token store", async () => {
    const { tokens, threads, data } = await setup();
    const e = await updateToInbound(click(dmMsg, data), BOT, threads, tokens);
    expect(e).toMatchObject({ type: "card_action", eventId: "cq1" });
    const stub = { take: async () => null, put: async () => "" } as CardTokenStore;
    expect(await updateToInbound(click(dmMsg, data), BOT, threads, stub)).toBeNull();
    expect(await updateToInbound(click(dmMsg, data), BOT, threads)).toBeNull();
  });
});
