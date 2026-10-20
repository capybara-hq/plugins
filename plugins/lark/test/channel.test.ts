import type { InboundEvent } from "@capybara-hq/plugin-sdk";
import {
  type FakeLarkServer,
  findLarkButton,
  larkCardAction,
  larkMessageEvent,
  startFakeLark,
} from "@capybara-hq/testing";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { decodeActionValue, VALUE_KEY } from "../src/actions.js";
import { createLarkChannel, MIN_EDIT_INTERVAL_MS } from "../src/channel.js";
import plugin from "../src/index.js";

let lark: FakeLarkServer;
const log = { info() {}, warn() {}, error() {} };
const stops: (() => Promise<void>)[] = [];

beforeAll(async () => {
  lark = await startFakeLark({ tenantKey: "t1", botOpenId: "ou_bot", botName: "Capybara" });
  lark.users.set("ou_alice", {
    openId: "ou_alice",
    name: "Alice Liddell",
    avatar72: "https://avatars.example/alice.png",
  });
});
afterEach(async () => {
  for (const s of stops.splice(0)) await s();
  await waitFor(() => lark.openSockets() === 0 || undefined, 5000, "sockets closed");
});
afterAll(async () => {
  await lark?.stop();
});

const channel = (o: { reconnectBaseMs?: number } = {}) =>
  createLarkChannel({
    apiUrl: lark.url,
    log,
    reconnectBaseMs: o.reconnectBaseMs ?? 20,
    statusPollMs: 50,
  });
const config = () => ({ appId: lark.appId, appSecret: lark.appSecret });
const signal = () => new AbortController().signal;
const waitFor = async <T>(fn: () => T | undefined, ms = 5000, what = "condition"): Promise<T> => {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v !== undefined && v !== false) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
};
const dm = { chatId: "oc_dm", chatType: "dm" as const };

/** 起一条长连接；返回收到的事件与停止函数。 */
async function connect(onEvent?: (e: InboundEvent) => Promise<void>) {
  const events: InboundEvent[] = [];
  const ac = new AbortController();
  const before = lark.connectionsOpened();
  const done = channel().connect({
    connectionId: "conn-1",
    config: config(),
    signal: ac.signal,
    onEvent: async (e) => {
      if (onEvent) await onEvent(e);
      events.push(e);
    },
  });
  done.catch(() => {});
  await waitFor(
    () => (lark.connectionsOpened() > before && lark.openSockets() > 0) || undefined,
    5000,
    "socket",
  );
  const stop = async () => {
    ac.abort();
    await done.catch(() => {});
  };
  stops.push(stop);
  return { events, stop, done };
}

describe("plugin manifest", () => {
  it("provides channel@1, declares only network permissions; region lark only", () => {
    expect(plugin.name).toBe("lark");
    expect(plugin.provides).toEqual(["channel@1"]);
    expect(plugin.permissions).toEqual({ network: ["open.larksuite.com"] });
    const dep = plugin.config?.deployment;
    expect(dep?.parse({})).toEqual({ region: "lark" });
    expect(dep?.safeParse({ region: "feishu" }).success).toBe(false);
    expect(dep?.safeParse({ region: "mars" }).success).toBe(false);
    const ch = channel();
    expect(ch.features).toEqual({
      cards: true,
      edit: true,
      threads: true,
      minEditIntervalMs: MIN_EDIT_INTERVAL_MS,
    });
    expect(MIN_EDIT_INTERVAL_MS).toBe(1500);
    expect(ch.connectionSchema.safeParse(config()).success).toBe(true);
    expect(ch.connectionSchema.safeParse({ appId: "app", appSecret: "x" }).success).toBe(false);
    expect(ch.connectionSchema.safeParse({ appId: lark.appId, appSecret: "" }).success).toBe(false);
  });
});

describe("verify", () => {
  it("tenant token → bot info (open_id, name) + tenant_key", async () => {
    expect(await channel().verify({ config: config(), signal: signal() })).toEqual({
      botUserId: "ou_bot",
      botName: "Capybara",
      tenantId: "t1",
    });
  });

  it("wrong secret → error with the code, never the secret", async () => {
    const err = await channel()
      .verify({
        config: { appId: lark.appId, appSecret: "wrong-secret-value-123" },
        signal: signal(),
      })
      .catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/code 10015/);
    expect((err as Error).message).not.toContain("wrong-secret");
  });
});

describe("send / update", () => {
  it("DM: creates an interactive card in the chat with the idempotency uuid; update patches it", async () => {
    const ch = channel();
    const { messageId } = await ch.send({
      config: config(),
      target: dm,
      message: { text: "Hello **there**" },
      signal: signal(),
      locale: "en",
      idempotencyKey: "key-1",
    });
    const m = lark.messages.find((x) => x.messageId === messageId);
    expect(m).toMatchObject({ chatId: "oc_dm", msgType: "interactive", uuid: "key-1" });
    expect(lark.cardText(m?.card)).toBe("Hello **there**");
    await ch.update({
      config: config(),
      target: dm,
      messageId,
      message: { text: "Hello again" },
      signal: signal(),
      locale: "en",
    });
    expect(lark.cardText(lark.finalCard(m ?? never()))).toBe("Hello again");
  });

  it("same idempotency key → Lark dedupes (one message)", async () => {
    const ch = channel();
    const before = lark.messages.length;
    const send = () =>
      ch.send({
        config: config(),
        target: dm,
        message: { text: "once" },
        signal: signal(),
        locale: "en",
        idempotencyKey: "dup-key",
      });
    const a = await send();
    const b = await send();
    expect(a).toEqual(b);
    expect(lark.messages.length).toBe(before + 1);
  });

  it("group thread: replies in thread to the root message", async () => {
    lark.registerMessage("om_root", "oc_group");
    const { messageId } = await channel().send({
      config: config(),
      target: { chatId: "oc_group", chatType: "group", threadId: "om_root" },
      message: { text: "in thread" },
      signal: signal(),
      locale: "en",
    });
    const m = lark.messages.find((x) => x.messageId === messageId);
    expect(m).toMatchObject({ chatId: "oc_group", rootId: "om_root", replyInThread: true });
  });

  it("long text is split; returns the last id; parts get distinct uuids", async () => {
    const before = lark.messages.length;
    const text = Array.from(
      { length: 300 },
      (_, i) => `line ${i} ${"lorem ipsum ".repeat(4)}`,
    ).join("\n");
    const { messageId } = await channel().send({
      config: config(),
      target: dm,
      message: { text },
      signal: signal(),
      locale: "en",
      idempotencyKey: "long",
    });
    const sent = lark.messages.slice(before);
    expect(sent.length).toBeGreaterThan(1);
    expect(sent.at(-1)?.messageId).toBe(messageId);
    expect(sent.map((m) => m.uuid)).toEqual(sent.map((_, i) => (i === 0 ? "long" : `long-${i}`)));
  });

  it("update with oversize text → too_large without calling Lark", async () => {
    const patches = lark.calls.filter((c) => c.api === "patch").length;
    const err = await channel()
      .update({
        config: config(),
        target: dm,
        messageId: "om_whatever",
        message: { text: "z".repeat(20_000) },
        signal: signal(),
        locale: "en",
      })
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ retryable: false, reason: "too_large" });
    expect(lark.calls.filter((c) => c.api === "patch").length).toBe(patches);
  });

  it("maps platform errors (rate limit with reset, bot not in group, auth)", async () => {
    const ch = channel();
    const send = () =>
      ch.send({
        config: config(),
        target: dm,
        message: { text: "x" },
        signal: signal(),
        locale: "en",
      });
    lark.failNext("create", { status: 429, code: 99991400, retryAfter: 7 });
    expect(await send().catch((e: unknown) => e)).toMatchObject({
      retryable: true,
      retryAfterMs: 7000,
    });
    lark.failNext("create", { status: 400, code: 230002 });
    expect(await send().catch((e: unknown) => e)).toMatchObject({
      retryable: false,
      reason: "target_gone",
    });
    lark.failNext("create", { status: 400, code: 99991672 });
    expect(await send().catch((e: unknown) => e)).toMatchObject({
      retryable: false,
      reason: "auth",
    });
    lark.failNext("create", { status: 502 });
    expect(await send().catch((e: unknown) => e)).toMatchObject({ retryable: true });
  });

  it("an invalidated tenant token is refreshed once and the call retried", async () => {
    const ch = channel();
    await ch.send({
      config: config(),
      target: dm,
      message: { text: "warm" },
      signal: signal(),
      locale: "en",
    });
    const issued = lark.tokensIssued();
    lark.revokeTokens();
    await ch.send({
      config: config(),
      target: dm,
      message: { text: "after" },
      signal: signal(),
      locale: "en",
    });
    expect(lark.tokensIssued()).toBe(issued + 1);
  });

  it("cards follow the locale; update re-renders a decided approval without buttons", async () => {
    const ch = channel();
    const card = {
      kind: "approval" as const,
      id: "apr_9",
      title: "Run it",
      toolName: "run",
      agentName: "Helper",
      inputPreview: "{}",
      scopes: ["once" as const],
      expiresAt: "2026-10-20T10:00:00Z",
      state: "pending" as const,
      webUrl: "https://cap.example/c/9",
    };
    const { messageId } = await ch.send({
      config: config(),
      target: dm,
      message: { text: "", cards: [card] },
      signal: signal(),
      locale: "zh",
    });
    const m = lark.messages.find((x) => x.messageId === messageId) ?? never();
    expect(findLarkButton(m.card, (b) => b.text === "批准一次")).toBeDefined();
    await ch.update({
      config: config(),
      target: dm,
      messageId,
      message: { text: "", cards: [{ ...card, state: "approved", decidedBy: "Alice" }] },
      signal: signal(),
      locale: "zh",
    });
    const final = lark.finalCard(m);
    expect(findLarkButton(final, (b) => b.text === "批准一次")).toBeUndefined();
    expect(lark.cardText(final)).toContain("已批准");
  });
});

describe("connect (long connection)", () => {
  it("acks (code 200) only after onEvent resolves; delivers a DM with profile", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const { events } = await connect(() => gate);
    const id = lark.pushEvent(
      larkMessageEvent({ openId: "ou_alice", chatId: "oc_dm", chatType: "p2p", text: "hi" }),
    );
    await new Promise((r) => setTimeout(r, 300));
    expect(lark.acked(id)).toBe(false);
    release();
    const ack = await lark.waitForAck(id);
    expect(ack.code).toBe(200);
    expect(events).toEqual([
      {
        type: "message",
        messageId: expect.stringMatching(/^om_/),
        target: { chatId: "oc_dm", chatType: "dm" },
        sender: {
          externalId: "ou_alice",
          tenantId: "t1",
          displayName: "Alice Liddell",
          avatarUrl: "https://avatars.example/alice.png",
        },
        text: "hi",
        mentionsBot: false,
      },
    ]);
  });

  it("onEvent rejects → the handler throws, Lark gets a failure (500), never a 200", async () => {
    await connect(async () => {
      throw new Error("queue down");
    });
    const id = lark.pushEvent(
      larkMessageEvent({ openId: "ou_alice", chatId: "oc_dm", chatType: "p2p", text: "hi" }),
    );
    const ack = await lark.waitForAck(id);
    expect(ack.code).toBe(500);
  });

  it("ignored events are acked; group @bot with root_id threads on the root", async () => {
    const { events } = await connect();
    const ignored = lark.pushEvent(
      larkMessageEvent({
        openId: "ou_alice",
        chatId: "oc_g",
        chatType: "group",
        text: "no mention",
      }),
    );
    expect((await lark.waitForAck(ignored)).code).toBe(200);
    const id = lark.pushEvent(
      larkMessageEvent({
        openId: "ou_alice",
        chatId: "oc_g",
        chatType: "group",
        text: "@_user_1 status?",
        rootId: "om_root",
        threadId: "omt_x",
        mentions: [{ key: "@_user_1", openId: "ou_bot", name: "Capybara" }],
      }),
    );
    await lark.waitForAck(id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "message",
      target: { chatId: "oc_g", chatType: "group", threadId: "om_root" },
      text: "status?",
      mentionsBot: true,
    });
  });

  it("caches profile lookups per connection (3 messages → 1 contact call)", async () => {
    await connect();
    const before = lark.calls.filter((c) => c.api === "user").length;
    for (let i = 0; i < 3; i++) {
      await lark.waitForAck(
        lark.pushEvent(
          larkMessageEvent({ openId: "ou_alice", chatId: "oc_dm", chatType: "p2p", text: `m${i}` }),
        ),
      );
    }
    expect(lark.calls.filter((c) => c.api === "user").length - before).toBeLessThanOrEqual(1);
  });

  it("profile lookup failure does not block the event", async () => {
    const { events } = await connect();
    lark.failNext("user", { status: 400, code: 40003 });
    const id = lark.pushEvent(
      larkMessageEvent({ openId: "ou_carol", chatId: "oc_dm2", chatType: "p2p", text: "yo" }),
    );
    expect((await lark.waitForAck(id)).code).toBe(200);
    expect(events[0]).toMatchObject({ sender: { externalId: "ou_carol", tenantId: "t1" } });
    expect(events[0] && "displayName" in (events[0] as { sender: object }).sender).toBe(false);
  });

  it("card button → card_action (eventId, chat type from value); callback answered with no card change", async () => {
    const { events } = await connect();
    const sent = await channel().send({
      config: config(),
      target: { chatId: "oc_g", chatType: "group" },
      message: {
        text: "",
        cards: [
          {
            kind: "approval",
            id: "apr_7",
            title: "Deploy",
            toolName: "deploy",
            agentName: "Helper",
            inputPreview: "{}",
            scopes: ["once"],
            expiresAt: "2026-10-20T10:00:00Z",
            state: "pending",
            webUrl: "https://cap.example/c/7",
          },
        ],
      },
      signal: signal(),
      locale: "en",
    });
    const msg = lark.messages.find((m) => m.messageId === sent.messageId) ?? never();
    const btn = findLarkButton(msg.card, (b) => b.text === "Approve once") ?? never();
    expect(
      decodeActionValue((btn.value as Record<string, string>)[VALUE_KEY] as string),
    ).toMatchObject({
      chat: "g",
    });
    const id = lark.pushEvent(
      larkCardAction({ openId: "ou_alice", tenantKey: "t1" }, msg, btn, { eventId: "evt_click" }),
    );
    const ack = await lark.waitForAck(id);
    expect(ack.code).toBe(200);
    expect(ack.data).toBeUndefined();
    expect(events).toEqual([
      {
        type: "card_action",
        messageId: sent.messageId,
        eventId: "evt_click",
        target: { chatId: "oc_g", chatType: "group" },
        sender: {
          externalId: "ou_alice",
          tenantId: "t1",
          displayName: "Alice Liddell",
          avatarUrl: "https://avatars.example/alice.png",
        },
        action: { cardKind: "approval", cardId: "apr_7", action: "approve", scope: "once" },
      },
    ]);
  });

  it("contact change → directory_changed", async () => {
    const { events } = await connect();
    const id = lark.pushEvent({
      schema: "2.0",
      header: {
        event_id: "e1",
        event_type: "contact.user.updated_v3",
        tenant_key: "t1",
        app_id: lark.appId,
      },
      event: { object: { open_id: "ou_alice" } },
    });
    await lark.waitForAck(id);
    expect(events).toEqual([{ type: "directory_changed", tenantId: "t1" }]);
  });

  it("reconnects after the server drops the connection", async () => {
    const { events } = await connect();
    const opened = lark.connectionsOpened();
    lark.disconnectAll();
    await waitFor(
      () => (lark.connectionsOpened() > opened && lark.openSockets() === 1) || undefined,
      5000,
      "reconnect",
    );
    const id = lark.pushEvent(
      larkMessageEvent({ openId: "ou_alice", chatId: "oc_dm", chatType: "p2p", text: "back" }),
    );
    await lark.waitForAck(id);
    expect(events.at(-1)).toMatchObject({ text: "back" });
    expect(lark.maxConcurrentSockets()).toBeGreaterThanOrEqual(1);
  });

  it("keeps failing to stay connected → throws after 5 short-lived connections", async () => {
    lark.dropNextConnections(5);
    const before = lark.connectionsOpened();
    const started = Date.now();
    const err = await channel()
      .connect({ connectionId: "c", config: config(), signal: signal(), onEvent: async () => {} })
      .catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/keeps closing/);
    expect(lark.connectionsOpened() - before).toBe(5);
    expect(Date.now() - started).toBeGreaterThanOrEqual(150);
  });

  it("endpoint refusing the connection (e.g. connection limit) → throws with the code", async () => {
    lark.failNext("endpoint", { code: 1000040350 });
    const err = await channel()
      .connect({ connectionId: "c", config: config(), signal: signal(), onEvent: async () => {} })
      .catch((e: Error) => e);
    expect((err as Error).message).toMatch(/1000040350/);
  });

  it("bad credentials → throws before opening the long connection, without the secret", async () => {
    const before = lark.endpointCalls();
    const err = await channel()
      .connect({
        connectionId: "c",
        config: { appId: lark.appId, appSecret: "nope-nope-secret" },
        signal: signal(),
        onEvent: async () => {},
      })
      .catch((e: Error) => e);
    expect((err as Error).message).toMatch(/10015/);
    expect((err as Error).message).not.toContain("nope-nope");
    expect(lark.endpointCalls()).toBe(before);
  });

  it("abort returns promptly and leaves no socket open (also mid-handshake)", async () => {
    const { stop } = await connect();
    const t = Date.now();
    await stop();
    expect(Date.now() - t).toBeLessThan(2000);
    await waitFor(() => lark.openSockets() === 0 || undefined, 3000, "closed");

    lark.delay("endpoint", 400);
    const calls = lark.endpointCalls();
    const ac = new AbortController();
    const done = channel().connect({
      connectionId: "c",
      config: config(),
      signal: ac.signal,
      onEvent: async () => {},
    });
    await waitFor(() => lark.endpointCalls() > calls || undefined, 3000, "endpoint call");
    ac.abort();
    const t2 = Date.now();
    await done;
    expect(Date.now() - t2).toBeLessThan(2000);
    await new Promise((r) => setTimeout(r, 800));
    lark.delay("endpoint", 0);
    expect(lark.openSockets()).toBe(0);
  });
});

function never(): never {
  throw new Error("missing");
}
