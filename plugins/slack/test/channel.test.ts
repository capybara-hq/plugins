import type { InboundEvent } from "@capybara-hq/plugin-sdk";
import {
  type FakeSlackServer,
  findSlackButton,
  slackBlockAction,
  slackDmEvent,
  slackMentionEvent,
  startFakeSlack,
} from "@capybara-hq/testing";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { decodeActionValue } from "../src/actions.js";
import { createSlackChannel } from "../src/channel.js";
import plugin from "../src/index.js";

let slack: FakeSlackServer;
const log = { info() {}, warn() {}, error() {} };
const stops: (() => Promise<void>)[] = [];

beforeAll(async () => {
  slack = await startFakeSlack({ teamId: "T1", botUserId: "UBOT" });
  slack.users.set("U1", {
    id: "U1",
    teamId: "T1",
    name: "alice",
    realName: "Alice Liddell",
    displayName: "Ally",
    image72: "https://avatars.example/u1.png",
  });
});
afterEach(async () => {
  for (const s of stops.splice(0)) await s();
  await waitFor(() => slack.openSockets() === 0 || undefined, 5000, "sockets closed");
});
afterAll(async () => {
  await slack?.stop();
});

const channel = () => createSlackChannel({ apiUrl: slack.apiUrl, log, reconnectBaseMs: 20 });
const config = () => ({ appToken: slack.appToken, botToken: slack.botToken });
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

/** 起一条 Socket Mode 长连接；返回收到的事件与停止函数。 */
async function connect(onEvent?: (e: InboundEvent) => Promise<void>) {
  const events: InboundEvent[] = [];
  const ac = new AbortController();
  const before = slack.connectionsOpened();
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
    () => (slack.connectionsOpened() > before && slack.openSockets() > 0) || undefined,
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
  it("provides channel@1, declares only network permissions, connection schema validates tokens", () => {
    expect(plugin.name).toBe("slack");
    expect(plugin.provides).toEqual(["channel@1", "identity-source@1", "directory@1"]);
    expect(plugin.permissions).toEqual({ network: ["slack.com", "wss-primary.slack.com"] });
    // 部署级：登录的 client id / secret 可选（只用机器人时不填）；组织级：通讯录的 teamId / botToken 可选
    const dep = plugin.config?.deployment;
    expect(dep?.parse({})).toMatchObject({ apiUrl: "https://slack.com/api/" });
    expect(dep?.parse({ clientId: "c", clientSecret: "s" })).toMatchObject({ clientId: "c" });
    expect(plugin.config?.org?.parse({})).toEqual({});
    expect(plugin.config?.org?.parse({ teamId: "T1", botToken: "xoxb-1" })).toEqual({
      teamId: "T1",
      botToken: "xoxb-1",
    });
    expect(plugin.config?.org?.safeParse({ teamId: "T1", botToken: "xapp-1" }).success).toBe(false);
    // Ruling A26：租户是工作区（T…），企业 id（E…）会把身份拆开
    expect(plugin.config?.org?.safeParse({ teamId: "E1", botToken: "xoxb-1" }).success).toBe(false);
    const ch = channel();
    expect(ch.features).toEqual({
      cards: true,
      edit: true,
      threads: true,
      minEditIntervalMs: 2500,
    });
    expect(ch.connectionSchema.safeParse(config()).success).toBe(true);
    expect(
      ch.connectionSchema.safeParse({ appToken: "xoxb-1", botToken: slack.botToken }).success,
    ).toBe(false);
    expect(
      ch.connectionSchema.safeParse({ appToken: slack.appToken, botToken: "xapp-1" }).success,
    ).toBe(false);
  });
});

describe("verify", () => {
  it("auth.test → bot user, name and team (tenant)", async () => {
    expect(await channel().verify({ config: config(), signal: signal() })).toEqual({
      botUserId: "UBOT",
      botName: "capybara",
      tenantId: "T1",
    });
  });

  it("bad bot token → error without the token", async () => {
    const bad = { ...config(), botToken: "xoxb-wrong-secret-value" };
    const err = await channel()
      .verify({ config: bad, signal: signal() })
      .catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/invalid_auth/);
    expect((err as Error).message).not.toContain("xoxb-wrong");
  });
});

describe("send / update", () => {
  const dmTarget = { chatId: "D1", chatType: "dm" as const };

  it("posts mrkdwn text and returns channel:ts; update edits that message", async () => {
    const ch = channel();
    const { messageId } = await ch.send({
      config: config(),
      target: dmTarget,
      message: { text: "**draft**" },
      signal: signal(),
      locale: "en",
    });
    const m = slack.messages.at(-1);
    expect(m).toMatchObject({ channel: "D1", text: "*draft*" });
    expect(messageId).toBe(`D1:${m?.ts}`);
    await ch.update({
      config: config(),
      target: dmTarget,
      messageId,
      message: { text: "**final**" },
      signal: signal(),
      locale: "en",
    });
    expect(slack.finalText(m as never)).toBe("*final*");
  });

  it("group target with threadId replies in that thread (thread_ts from the root message id)", async () => {
    await channel().send({
      config: config(),
      target: { chatId: "C1", chatType: "group", threadId: "C1:1700.000100" },
      message: { text: "in thread" },
      signal: signal(),
      locale: "en",
    });
    expect(slack.messages.at(-1)).toMatchObject({ channel: "C1", threadTs: "1700.000100" });
  });

  it("oversize text is split into several posts in order; the last message id is returned", async () => {
    const before = slack.messages.length;
    const text = `${"lorem ipsum ".repeat(400)}\n\n`.repeat(3);
    const { messageId } = await channel().send({
      config: config(),
      target: dmTarget,
      message: { text },
      signal: signal(),
      locale: "en",
    });
    const posted = slack.messages.slice(before);
    expect(posted.length).toBeGreaterThan(1);
    for (const p of posted) expect(p.text.length).toBeLessThanOrEqual(4000);
    expect(messageId).toBe(`D1:${posted.at(-1)?.ts}`);
  });

  it("update with oversize text throws too_large without calling Slack", async () => {
    const calls = slack.calls.length;
    const err = await channel()
      .update({
        config: config(),
        target: dmTarget,
        messageId: "D1:1.1",
        message: { text: "y".repeat(4001) },
        signal: signal(),
        locale: "en",
      })
      .catch((e) => e);
    expect(err).toMatchObject({ name: "ChannelSendError", retryable: false, reason: "too_large" });
    expect(slack.calls.length).toBe(calls);
  });

  it("maps Slack failures to ChannelSendError", async () => {
    const ch = channel();
    const send = () =>
      ch
        .send({
          config: config(),
          target: dmTarget,
          message: { text: "x" },
          signal: signal(),
          locale: "en",
        })
        .catch((e) => e);
    slack.failNext("chat.postMessage", { status: 429, retryAfter: 3 });
    expect(await send()).toMatchObject({ retryable: true, retryAfterMs: 3000 });
    slack.failNext("chat.postMessage", { status: 503 });
    expect(await send()).toMatchObject({ retryable: true });
    slack.failNext("chat.postMessage", { error: "token_revoked" });
    expect(await send()).toMatchObject({ retryable: false, reason: "auth" });
    slack.failNext("chat.postMessage", { error: "not_in_channel" });
    expect(await send()).toMatchObject({ retryable: false, reason: "target_gone" });
    slack.failNext("chat.postMessage", { error: "msg_too_long" });
    expect(await send()).toMatchObject({ retryable: false, reason: "too_large" });
    slack.failNext("chat.postMessage", { error: "invalid_blocks" });
    expect(await send()).toMatchObject({ retryable: false, reason: "rejected" });
    slack.failNext("chat.postMessage", { body: { ok: true, channel: "D1" } });
    expect(await send()).toMatchObject({ retryable: false, reason: "rejected" });
  });

  it("cards are posted as Block Kit with locale-specific labels", async () => {
    await channel().send({
      config: config(),
      target: dmTarget,
      message: {
        text: "Link first",
        cards: [{ kind: "bind", url: "https://cap.example/b", text: "Link first" }],
      },
      signal: signal(),
      locale: "zh",
    });
    const m = slack.messages.at(-1);
    expect(findSlackButton(m?.blocks, (b) => b.url === "https://cap.example/b")).toBeDefined();
    expect(JSON.stringify(m?.blocks)).toContain("绑定账号");
  });
});

describe("connect (Socket Mode)", () => {
  it("DM → onEvent with profile, then ack; ack happens only after onEvent resolves", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const { events } = await connect(() => gate);
    const env = slack.pushEvent(slackDmEvent("U1", "hi <@UBOT>", { ts: "1.1", team: "T1" }));
    await new Promise((r) => setTimeout(r, 300));
    expect(slack.acked(env)).toBe(false);
    release();
    await slack.waitForAck(env);
    expect(events).toEqual([
      {
        type: "message",
        messageId: "DU1:1.1",
        target: { chatId: "DU1", chatType: "dm" },
        sender: {
          externalId: "U1",
          tenantId: "T1",
          displayName: "Ally",
          avatarUrl: "https://avatars.example/u1.png",
        },
        text: "hi",
        mentionsBot: false,
      },
    ]);
  });

  it("onEvent rejects → no ack (Slack redelivers)", async () => {
    await connect(async () => {
      throw new Error("enqueue failed");
    });
    const env = slack.pushEvent(slackDmEvent("U1", "hello", { ts: "1.2" }));
    await new Promise((r) => setTimeout(r, 500));
    expect(slack.acked(env)).toBe(false);
  });

  it("ignored events (bot messages, edits) are acked without onEvent", async () => {
    const { events } = await connect();
    const e1 = slack.pushEvent(slackDmEvent("U1", "x", { extra: { bot_id: "B1" } }));
    const e2 = slack.pushEvent(slackDmEvent("U1", "x", { extra: { subtype: "message_changed" } }));
    await slack.waitForAck(e1);
    await slack.waitForAck(e2);
    expect(events).toEqual([]);
  });

  it("app_mention → group message; team_join → directory_changed", async () => {
    const { events } = await connect();
    const e1 = slack.pushEvent(
      slackMentionEvent("U1", "UBOT", "help", { ts: "2.1", channel: "C9" }),
    );
    await slack.waitForAck(e1);
    const e2 = slack.pushEvent({ type: "team_join", user: { id: "U5" } });
    await slack.waitForAck(e2);
    expect(events[0]).toMatchObject({
      type: "message",
      messageId: "C9:2.1",
      target: { chatId: "C9", chatType: "group" },
      text: "help",
      mentionsBot: true,
    });
    expect(events[1]).toEqual({ type: "directory_changed", tenantId: "T1" });
  });

  it("button click → card_action (eventId, card message id), then ack", async () => {
    const ch = channel();
    await ch.send({
      config: config(),
      target: { chatId: "C1", chatType: "group", threadId: "C1:1700.000100" },
      message: {
        text: "Approve?",
        cards: [
          {
            kind: "approval",
            id: "ap-1",
            title: "Approve?",
            toolName: "t",
            agentName: "A",
            inputPreview: "{}",
            scopes: ["once"],
            expiresAt: "2026-10-20T10:00:00Z",
            state: "pending",
            webUrl: "https://cap.example/c",
          },
        ],
      },
      signal: signal(),
      locale: "en",
    });
    const msg = slack.messages.at(-1);
    if (!msg) throw new Error("no message");
    const btn = findSlackButton(msg.blocks, (b) => b.action_id === "cap_a_once");
    expect(decodeActionValue(btn?.value ?? "")).toEqual({
      k: "a",
      id: "ap-1",
      action: "approve",
      scope: "once",
    });
    const { events } = await connect();
    const env = slack.pushInteractive(
      slackBlockAction({ id: "U1", teamId: "T1" }, msg, btn as never, { actionTs: "1800.5" }),
    );
    await slack.waitForAck(env);
    expect(events).toEqual([
      {
        type: "card_action",
        messageId: `C1:${msg.ts}`,
        eventId: `C1:${msg.ts}:U1:1800.5`,
        target: { chatId: "C1", chatType: "group", threadId: "C1:1700.000100" },
        sender: {
          externalId: "U1",
          tenantId: "T1",
          displayName: "Ally",
          avatarUrl: "https://avatars.example/u1.png",
        },
        action: { cardKind: "approval", cardId: "ap-1", action: "approve", scope: "once" },
      },
    ]);
    // 链接按钮的点击也要确认，但不交给内核
    const link = findSlackButton(msg.blocks, (b) => b.url !== undefined);
    const env2 = slack.pushInteractive(
      slackBlockAction({ id: "U1", teamId: "T1" }, msg, link as never),
    );
    await slack.waitForAck(env2);
    expect(events).toHaveLength(1);
  });

  it("users.info lookups are cached per process (one call per user)", async () => {
    slack.users.set("U7", { id: "U7", teamId: "T1", name: "gus" });
    const { events } = await connect();
    const before = slack.calls.filter((c) => c.method === "users.info").length;
    for (const ts of ["7.1", "7.2", "7.3"]) {
      await slack.waitForAck(slack.pushEvent(slackDmEvent("U7", "hey", { ts })));
    }
    expect(slack.calls.filter((c) => c.method === "users.info").length - before).toBe(1);
    expect(events.map((e) => e.type === "message" && e.sender.displayName)).toEqual([
      "gus",
      "gus",
      "gus",
    ]);
  });

  it("profile lookup failure does not block the event", async () => {
    const { events } = await connect();
    const env = slack.pushEvent(slackDmEvent("U404", "hey", { ts: "8.1" }));
    await slack.waitForAck(env);
    expect(events[0]).toMatchObject({ sender: { externalId: "U404" } });
    expect((events[0] as { sender: { displayName?: string } }).sender.displayName).toBeUndefined();
  });

  it("reconnects after Slack asks to refresh the connection", async () => {
    const { events } = await connect();
    const opened = slack.connectionsOpened();
    slack.disconnectAll();
    await waitFor(
      () => slack.connectionsOpened() > opened && slack.openSockets() === 1,
      10_000,
      "reconnect",
    );
    const env = slack.pushEvent(slackDmEvent("U1", "again", { ts: "9.1" }));
    await slack.waitForAck(env);
    expect(events.at(-1)).toMatchObject({ text: "again" });
  });

  it("returns promptly when aborted and closes the socket", async () => {
    const { stop, done } = await connect();
    const t = Date.now();
    await stop();
    await done;
    expect(Date.now() - t).toBeLessThan(4000);
    await waitFor(() => slack.openSockets() === 0 || undefined, 3000, "socket closed");
  });

  it("abort while apps.connections.open is in flight leaves no socket open", async () => {
    slack.delay("apps.connections.open", 400);
    try {
      const calls = slack.calls.filter((c) => c.method === "apps.connections.open").length;
      const opened = slack.connectionsOpened();
      const ac = new AbortController();
      const done = channel().connect({
        connectionId: "c-abort",
        config: config(),
        signal: ac.signal,
        onEvent: async () => {},
      });
      await waitFor(
        () =>
          slack.calls.filter((c) => c.method === "apps.connections.open").length > calls ||
          undefined,
        5000,
        "apps.connections.open in flight",
      );
      ac.abort();
      await done;
      await waitFor(() => slack.connectionsOpened() > opened || undefined, 5000, "open answered");
      await new Promise((r) => setTimeout(r, 800));
      expect(slack.openSockets()).toBe(0);
    } finally {
      slack.delay("apps.connections.open", 0);
    }
  });

  it("link_disabled → connect rejects with the reason (kernel records last_error)", async () => {
    const { done } = await connect();
    slack.disconnectAll("link_disabled");
    const err = await done.then(
      () => undefined,
      (e: Error) => e,
    );
    expect(err?.message).toMatch(/link_disabled/);
  });

  it("connections that keep closing right away → backoff, then reject after 5 in a row", async () => {
    slack.dropNextConnections(100);
    try {
      const opened = slack.connectionsOpened();
      const t = Date.now();
      const err = await channel()
        .connect({
          connectionId: "c-flap",
          config: config(),
          signal: AbortSignal.timeout(20_000),
          onEvent: async () => {},
        })
        .then(
          () => undefined,
          (e: Error) => e,
        );
      expect(err?.message).toMatch(/keeps closing/);
      expect(slack.connectionsOpened() - opened).toBe(5);
      // 退避：20 + 40 + 80 + 160 毫秒（各乘 0.5–1 的抖动）≥ 150 毫秒
      expect(Date.now() - t).toBeGreaterThanOrEqual(150);
    } finally {
      slack.dropNextConnections(0);
    }
  }, 20_000);

  it("invalid app token → connect rejects without leaking the token", async () => {
    const err = await channel()
      .connect({
        connectionId: "c",
        config: { appToken: "xapp-wrong-app-token", botToken: slack.botToken },
        signal: signal(),
        onEvent: async () => {},
      })
      .catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/invalid_auth/);
    expect((err as Error).message).not.toContain("xapp-wrong");
  });
});
