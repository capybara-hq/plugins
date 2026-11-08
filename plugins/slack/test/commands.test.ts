import type { ChannelWebhookResult, InboundEvent } from "@capybara-hq/plugin-sdk";
import { type FakeSlackServer, signSlackWebhook, startFakeSlack } from "@capybara-hq/testing";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createSlackChannel, SlackConnection } from "../src/channel.js";
import { parseSlashCommand, SLASH_REPLIES, slashCommandText } from "../src/commands.js";

const SIGNING_SECRET = "8f742231b10e8888abcd99yyyzzz85a5";
const log = { info() {}, warn() {}, error() {} };

let slack: FakeSlackServer;
const stops: (() => Promise<void>)[] = [];

/** Test kv (TTLs not enforced). */
function memoryKv() {
  const m = new Map<string, string>();
  return {
    map: m,
    async get(k: string) {
      return m.get(k) ?? null;
    },
    async set(k: string, v: string, _o: { ttlSeconds: number }) {
      m.set(k, v);
    },
    async del(k: string) {
      m.delete(k);
    },
    async incr(k: string, _o: { ttlSeconds: number }) {
      const n = Number(m.get(k) ?? 0) + 1;
      m.set(k, String(n));
      return n;
    },
  };
}

beforeAll(async () => {
  slack = await startFakeSlack({ teamId: "T1", botUserId: "UBOT" });
  slack.users.set("U1", { id: "U1", teamId: "T1", name: "alice", displayName: "Ally" });
});
afterEach(async () => {
  for (const s of stops.splice(0)) await s();
});
afterAll(async () => {
  await slack?.stop();
});

const config = () => ({
  appToken: slack.appToken,
  botToken: slack.botToken,
  signingSecret: SIGNING_SECRET,
});
const waitFor = async <T>(fn: () => T | undefined, ms = 5000, what = "condition"): Promise<T> => {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v !== undefined && v !== false) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
};

let triggers = 0;
/** A slash command payload as Slack sends it (Socket Mode payload / webhook form fields). */
const command = (cmd: string, text: string, o: { channel?: string; user?: string } = {}) => ({
  token: "legacy-verification-token",
  team_id: "T1",
  team_domain: "acme",
  channel_id: o.channel ?? "DU1",
  channel_name: (o.channel ?? "DU1").startsWith("D") ? "directmessage" : "general",
  user_id: o.user ?? "U1",
  user_name: "alice",
  command: cmd,
  text,
  api_app_id: "A1",
  is_enterprise_install: "false",
  response_url: "https://hooks.slack.com/commands/T1/1/x",
  trigger_id: `${++triggers}.1.abc`,
});

/** The bot's DM with the user, as `conversations.open` answers (the fake has no such method). */
const botDmIs = (id: string) =>
  slack.failNext("conversations.open", { body: { ok: true, channel: { id } } });

async function connect(
  ch: ReturnType<typeof createSlackChannel>,
  onEvent?: (e: InboundEvent) => Promise<void>,
) {
  const events: InboundEvent[] = [];
  const ac = new AbortController();
  const before = slack.connectionsOpened();
  const done = ch.connect({
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
  stops.push(async () => {
    ac.abort();
    await done.catch(() => {});
    await waitFor(() => slack.openSockets() === 0 || undefined, 5000, "sockets closed");
  });
  return events;
}

const pushCommand = (payload: Record<string, unknown>) =>
  slack.push({ type: "slash_commands", payload });

describe("slash command text mapping", () => {
  it("/new and /env keep their name; the generic command becomes /<skill> args", () => {
    expect(slashCommandText("/new", "")).toBe("/new");
    expect(slashCommandText("/env", "  staging ")).toBe("/env staging");
    expect(slashCommandText("/env", "")).toBe("/env");
    expect(slashCommandText("/capybara", "foo bar")).toBe("/foo bar");
    expect(slashCommandText("/capybara", "/fix-issue 12")).toBe("/fix-issue 12");
    expect(slashCommandText("/capybara", "github:fix-issue 12")).toBe("/github:fix-issue 12");
    // A renamed generic command maps the same way
    expect(slashCommandText("/cap", "foo")).toBe("/foo");
    expect(slashCommandText("/capybara", "  ")).toBeNull();
    // Slack's entities are undone, newlines kept
    expect(slashCommandText("/capybara", "q a &lt;b&gt; &amp;\nline 2")).toBe("/q a <b> &\nline 2");
  });

  it("parses a payload and rejects malformed ones", () => {
    expect(parseSlashCommand(command("/new", ""))).toMatchObject({
      command: "/new",
      text: "",
      userId: "U1",
      userName: "alice",
      channelId: "DU1",
      teamId: "T1",
    });
    expect(parseSlashCommand({ ...command("/new", ""), user_id: "" })).toBeNull();
    expect(parseSlashCommand({ ...command("new", "") })).toBeNull();
    expect(parseSlashCommand("x")).toBeNull();
  });
});

describe("slash commands over Socket Mode", () => {
  it("DM /new → a DM message '/new', acked only after onEvent resolves, with an ephemeral echo", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const events = await connect(createSlackChannel({ apiUrl: slack.apiUrl, log }), () => gate);
    botDmIs("DU1");
    const p = command("/new", "");
    const env = pushCommand(p);
    await new Promise((r) => setTimeout(r, 300));
    expect(slack.acked(env)).toBe(false);
    release();
    const ack = await slack.waitForAck(env);
    expect(ack.payload).toEqual({ response_type: "ephemeral", text: "/new" });
    expect(events).toEqual([
      {
        type: "message",
        messageId: `DU1:cmd-${p.trigger_id}`,
        target: { chatId: "DU1", chatType: "dm" },
        sender: { externalId: "U1", tenantId: "T1", displayName: "Ally" },
        text: "/new",
        mentionsBot: false,
      },
    ]);
  });

  it("DM /env x and /capybara foo bar → '/env x' and '/foo bar'", async () => {
    const events = await connect(createSlackChannel({ apiUrl: slack.apiUrl, log }));
    botDmIs("DU1");
    await slack.waitForAck(pushCommand(command("/env", "x")));
    botDmIs("DU1");
    const env = pushCommand(command("/capybara", "foo <@U2> &lt;!channel&gt;"));
    const ack = await slack.waitForAck(env);
    expect(events.map((e) => e.type === "message" && e.text)).toEqual([
      "/env x",
      "/foo <@U2> <!channel>",
    ]);
    // The echo is escaped: a typed <!channel> stays text
    expect(ack.payload).toEqual({
      response_type: "ephemeral",
      text: "/capybara foo &lt;@U2&gt; &lt;!channel&gt;",
    });
  });

  it("onEvent rejects → no ack", async () => {
    await connect(createSlackChannel({ apiUrl: slack.apiUrl, log }), async () => {
      throw new Error("enqueue failed");
    });
    botDmIs("DU1");
    const env = pushCommand(command("/new", ""));
    await new Promise((r) => setTimeout(r, 500));
    expect(slack.acked(env)).toBe(false);
  });

  it("/capybara with no skill → usage reply, no event", async () => {
    const events = await connect(createSlackChannel({ apiUrl: slack.apiUrl, log }));
    const ack = await slack.waitForAck(pushCommand(command("/capybara", " ")));
    expect(ack.payload).toEqual({ response_type: "ephemeral", text: SLASH_REPLIES.usage });
    expect(events).toEqual([]);
  });

  it("a DM between two people (not the bot's) → hint, no event; the bot DM is cached in kv", async () => {
    const kv = memoryKv();
    const events = await connect(createSlackChannel({ apiUrl: slack.apiUrl, log, kv }));
    botDmIs("DU1");
    const ack = await slack.waitForAck(pushCommand(command("/new", "", { channel: "DOTHER" })));
    expect(ack.payload).toEqual({ response_type: "ephemeral", text: SLASH_REPLIES.wrongDm });
    expect(events).toEqual([]);
    const opens = slack.calls.filter((c) => c.method === "conversations.open").length;
    await slack.waitForAck(pushCommand(command("/new", "")));
    expect(slack.calls.filter((c) => c.method === "conversations.open").length).toBe(opens);
    expect(events).toHaveLength(1);
  });

  it("channel → a visible echo is posted and the event is that message, mentioning the bot", async () => {
    const events = await connect(createSlackChannel({ apiUrl: slack.apiUrl, log }));
    const env = pushCommand(command("/capybara", "fix-issue 12", { channel: "C9" }));
    const ack = await slack.waitForAck(env);
    expect(ack.payload).toEqual({});
    const echo = slack.messages.find((m) => m.channel === "C9" && m.text.includes("fix-issue"));
    expect(echo?.text).toBe("<@U1>: /capybara fix-issue 12");
    expect(echo?.threadTs).toBeUndefined();
    expect(events).toEqual([
      {
        type: "message",
        messageId: `C9:${echo?.ts}`,
        target: { chatId: "C9", chatType: "group" },
        sender: { externalId: "U1", tenantId: "T1", displayName: "Ally" },
        text: "/fix-issue 12",
        mentionsBot: true,
      },
    ]);
  });

  it("channel the bot is not in → invite hint, no event", async () => {
    const events = await connect(createSlackChannel({ apiUrl: slack.apiUrl, log }));
    slack.failNext("chat.postMessage", { error: "not_in_channel" });
    const ack = await slack.waitForAck(pushCommand(command("/new", "", { channel: "C8" })));
    expect(ack.payload).toEqual({ response_type: "ephemeral", text: SLASH_REPLIES.notInChannel });
    expect(events).toEqual([]);
  });
});

/** A signed slash command webhook request (form body, as Slack posts it). */
function commandRequest(payload: Record<string, string>) {
  const body = new URLSearchParams(payload).toString();
  const now = Date.now();
  return {
    method: "POST" as const,
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      ...signSlackWebhook(body, SIGNING_SECRET, Math.floor(now / 1000)),
    } as Record<string, string>,
    body: new TextEncoder().encode(body),
    receivedAt: now,
  };
}

async function handle(
  ch: ReturnType<typeof createSlackChannel>,
  req: ReturnType<typeof commandRequest>,
): Promise<ChannelWebhookResult> {
  if (!ch.webhook) throw new Error("no webhook");
  return ch.webhook.handle({
    connectionId: "conn-1",
    config: SlackConnection.parse(config()),
    request: req,
    signal: new AbortController().signal,
  });
}

describe("slash commands over webhook", () => {
  it("DM command → the same event as Socket Mode, acked with the ephemeral echo", async () => {
    const ch = createSlackChannel({ apiUrl: slack.apiUrl, log });
    botDmIs("DU1");
    const p = command("/env", "staging");
    const r = await handle(ch, commandRequest(p));
    expect(r).toEqual({
      kind: "events",
      events: [
        {
          type: "message",
          messageId: `DU1:cmd-${p.trigger_id}`,
          target: { chatId: "DU1", chatType: "dm" },
          sender: { externalId: "U1", tenantId: "T1", displayName: "Ally" },
          text: "/env staging",
          mentionsBot: false,
        },
      ],
      ack: {
        status: 200,
        headers: { "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify({ response_type: "ephemeral", text: "/env staging" }),
      },
    });
  });

  it("a channel command redelivered with the same trigger_id reuses its echo", async () => {
    const ch = createSlackChannel({ apiUrl: slack.apiUrl, log, kv: memoryKv() });
    const p = command("/capybara", "summarize", { channel: "C7" });
    const posts = () => slack.messages.filter((m) => m.channel === "C7").length;
    const r1 = await handle(ch, commandRequest(p));
    const r2 = await handle(ch, commandRequest(p));
    expect(posts()).toBe(1);
    expect(r1.kind === "events" && r1.events).toEqual(r2.kind === "events" && r2.events);
  });

  it("usage reply without an event; a bad signature is rejected before anything", async () => {
    const ch = createSlackChannel({ apiUrl: slack.apiUrl, log });
    const r = await handle(ch, commandRequest(command("/capybara", "")));
    expect(r).toEqual({
      kind: "respond",
      response: {
        status: 200,
        headers: { "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify({ response_type: "ephemeral", text: SLASH_REPLIES.usage }),
      },
    });
    const req = commandRequest(command("/new", ""));
    req.headers["x-slack-signature"] = "v0=00";
    expect(await handle(ch, req)).toEqual({ kind: "reject", status: 401 });
  });
});
