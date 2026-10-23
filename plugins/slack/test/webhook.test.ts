import type { ChannelWebhookResult, InboundEvent } from "@capybara-hq/plugin-sdk";
import {
  type FakeSlackServer,
  signSlackWebhook,
  slackBlockAction,
  slackDmEvent,
  slackEventCallback,
  slackInteractiveForm,
  startFakeSlack,
} from "@capybara-hq/testing";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { encodeActionValue } from "../src/actions.js";
import { createSlackChannel, SlackConnection } from "../src/channel.js";
import { verifySlackSignature } from "../src/webhook.js";

const SIGNING_SECRET = "8f742231b10e8888abcd99yyyzzz85a5";
const log = { info() {}, warn() {}, error() {} };

let slack: FakeSlackServer;
const stops: (() => Promise<void>)[] = [];

/** Test kv (TTLs recorded, not enforced). */
function memoryKv() {
  const m = new Map<string, string>();
  const ttls: number[] = [];
  return {
    ttls,
    map: m,
    async get(k: string) {
      return m.get(k) ?? null;
    },
    async set(k: string, v: string, o: { ttlSeconds: number }) {
      ttls.push(o.ttlSeconds);
      m.set(k, v);
    },
    async del(k: string) {
      m.delete(k);
    },
    async incr(k: string, o: { ttlSeconds: number }) {
      ttls.push(o.ttlSeconds);
      const n = Number(m.get(k) ?? 0) + 1;
      m.set(k, String(n));
      return n;
    },
  };
}

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
});
afterAll(async () => {
  await slack?.stop();
});

const config = (o: { signingSecret?: string } = { signingSecret: SIGNING_SECRET }) => ({
  appToken: slack.appToken,
  botToken: slack.botToken,
  ...o,
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

/** A webhook request as the kernel hands it over (lowercase headers, raw bytes). */
function request(
  body: string,
  o: { contentType?: string; ts?: number; secret?: string; tamper?: boolean } = {},
) {
  const now = Date.now();
  const ts = o.ts ?? Math.floor(now / 1000);
  const headers = {
    "content-type": o.contentType ?? "application/json",
    "x-slack-retry-num": "0",
    ...signSlackWebhook(body, o.secret ?? SIGNING_SECRET, ts),
  };
  const bytes = new TextEncoder().encode(body);
  if (o.tamper) bytes[bytes.length - 2] = (bytes[bytes.length - 2] ?? 0) ^ 1;
  return { method: "POST" as const, headers, body: bytes, receivedAt: now };
}

async function handle(
  ch: ReturnType<typeof createSlackChannel>,
  req: ReturnType<typeof request>,
  cfg: unknown = config(),
): Promise<ChannelWebhookResult> {
  if (!ch.webhook) throw new Error("no webhook");
  return ch.webhook.handle({
    connectionId: "conn-1",
    config: SlackConnection.parse(cfg),
    request: req,
    signal: new AbortController().signal,
  });
}

/** Opens a Socket Mode connection and collects its events. */
async function connect(ch: ReturnType<typeof createSlackChannel>) {
  const events: InboundEvent[] = [];
  const ac = new AbortController();
  const before = slack.connectionsOpened();
  const done = ch.connect({
    connectionId: "conn-1",
    config: config(),
    signal: ac.signal,
    onEvent: async (e) => {
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

const authTests = () => slack.calls.filter((c) => c.method === "auth.test").length;

describe("Slack webhook inbound", () => {
  it("connection schema: signingSecret is an optional secret", () => {
    expect(SlackConnection.parse(config({}))).not.toHaveProperty("signingSecret");
    expect(SlackConnection.parse(config()).signingSecret).toBe(SIGNING_SECRET);
    expect(() => SlackConnection.parse(config({ signingSecret: "" }))).toThrow();
    const meta = SlackConnection.shape.signingSecret.meta() as { secret?: boolean } | undefined;
    expect(meta?.secret).toBe(true);
  });

  it("a signed message event → the same InboundEvent as Socket Mode; bot id cached in kv", async () => {
    const body = slackEventCallback(
      slackDmEvent("U1", "hello webhook", { ts: "1750000001.000100" }),
      {
        teamId: "T1",
        eventId: "EvParity1",
      },
    );
    const kv = memoryKv();
    const ch = createSlackChannel({ apiUrl: slack.apiUrl, log, kv });
    const events = await connect(ch);
    await slack.waitForAck(slack.push({ type: "events_api", payload: body }));
    const viaSocket = await waitFor(() => events[0], 5000, "socket event");

    const fresh = createSlackChannel({ apiUrl: slack.apiUrl, log, kv: memoryKv() });
    const before = authTests();
    const r = await handle(fresh, request(JSON.stringify(body)));
    expect(r.kind).toBe("events");
    if (r.kind !== "events") return;
    expect(r.ack.status).toBe(200);
    expect(r.events).toHaveLength(1);
    expect(r.events[0]).toEqual(viaSocket);
    expect(r.events[0]).toMatchObject({
      type: "message",
      messageId: "DU1:1750000001.000100",
      sender: { externalId: "U1", tenantId: "T1", displayName: "Ally" },
    });
    // One auth.test on the cache miss, none on the redelivery (cached per connection, 1 h TTL)
    const again = await handle(fresh, request(JSON.stringify(body)));
    expect(again).toEqual(r);
    expect(authTests() - before).toBe(1);
    // Socket Mode's credentials check fills the same cache
    expect([...kv.map.values()]).toEqual(["UBOT"]);
    expect(kv.ttls).toEqual([3600]);
  });

  it("block_actions form → card_action with the same eventId as Socket Mode", async () => {
    const message = { channel: "DU1", ts: "1750000002.000200", text: "card", at: 0 };
    const payload = slackBlockAction({ id: "U1", teamId: "T1", name: "alice" }, message, {
      actionId: "cap_a_deny",
      value: encodeActionValue({ k: "a", id: "card-1", action: "deny" }),
    });
    const ch = createSlackChannel({ apiUrl: slack.apiUrl, log, kv: memoryKv() });
    const events = await connect(ch);
    await slack.waitForAck(slack.pushInteractive(payload));
    const viaSocket = await waitFor(() => events[0], 5000, "socket event");

    const before = authTests();
    const r = await handle(
      ch,
      request(slackInteractiveForm(payload), {
        contentType: "application/x-www-form-urlencoded",
      }),
    );
    expect(r.kind).toBe("events");
    if (r.kind !== "events") return;
    expect(r.events).toEqual([viaSocket]);
    expect(r.events[0]).toMatchObject({
      type: "card_action",
      action: { cardKind: "approval", cardId: "card-1", action: "deny" },
    });
    expect((r.events[0] as { eventId: string }).eventId).toBe(
      (viaSocket as { eventId: string }).eventId,
    );
    // Interactive payloads need no bot id
    expect(authTests()).toBe(before);
  });

  it("url_verification → responds with the original challenge", async () => {
    const ch = createSlackChannel({ apiUrl: slack.apiUrl, log });
    const challenge = "3eZbrw1aBm2rZgRNFdxV2595E9CY3gmdALWMmHkvFXO7tYXAYM8P";
    const r = await handle(
      ch,
      request(JSON.stringify({ token: "t", challenge, type: "url_verification" })),
    );
    expect(r).toMatchObject({ kind: "respond", response: { status: 200 } });
    if (r.kind !== "respond") return;
    expect(JSON.parse(r.response.body ?? "")).toEqual({ challenge });
  });

  it("rejects 401: timestamp 301 s off, one byte changed, wrong secret, no signingSecret", async () => {
    const ch = createSlackChannel({ apiUrl: slack.apiUrl, log });
    const body = JSON.stringify(slackEventCallback(slackDmEvent("U1", "x"), { teamId: "T1" }));
    const now = Math.floor(Date.now() / 1000);
    for (const req of [
      request(body, { ts: now - 301 }),
      request(body, { ts: now + 301 }),
      request(body, { tamper: true }),
      request(body, { secret: "another-secret" }),
    ]) {
      expect(await handle(ch, req)).toEqual({ kind: "reject", status: 401 });
    }
    expect(await handle(ch, request(body), config({}))).toEqual({ kind: "reject", status: 401 });
    // Within the window still passes
    expect((await handle(ch, request(body, { ts: now - 290 }))).kind).toBe("events");
  });

  it("malformed signed body → 400; other callback types and foreign buttons are acked", async () => {
    const ch = createSlackChannel({ apiUrl: slack.apiUrl, log });
    expect(await handle(ch, request("{not json"))).toEqual({ kind: "reject", status: 400 });
    const rate = await handle(ch, request(JSON.stringify({ type: "app_rate_limited" })));
    expect(rate).toMatchObject({ kind: "events", events: [], ack: { status: 200 } });
    const foreign = await handle(
      ch,
      request(slackInteractiveForm({ type: "view_submission" }), {
        contentType: "application/x-www-form-urlencoded",
      }),
    );
    expect(foreign).toMatchObject({ kind: "events", events: [] });
  });

  it("verifySlackSignature matches Slack's documented example", () => {
    // https://docs.slack.dev/authentication/verifying-requests-from-slack/ (sample request)
    const body =
      "token=xyzz0WbapA4vBCDEFasx0q6G&team_id=T1DC2JH3J&team_domain=testteamnow&channel_id=G8PSS9T3V&channel_name=foobar&user_id=U2CERLKJA&user_name=roadrunner&command=%2Fwebhook-collect&text=&response_url=https%3A%2F%2Fhooks.slack.com%2Fcommands%2FT1DC2JH3J%2F397700885554%2F96rGlfmibIGlgcZRskXaIFfN&trigger_id=398738663015.47445629121.803a0bc887a14d10d2c447fce8b6703c";
    const h = {
      "x-slack-request-timestamp": "1531420618",
      "x-slack-signature": "v0=a2114d57b48eac39b9ad189dd8316235a7b4a8d21a10bd27519666489c69b503",
    };
    const bytes = new TextEncoder().encode(body);
    expect(verifySlackSignature(h, bytes, SIGNING_SECRET, 1531420618_000)).toBe(true);
    expect(verifySlackSignature(h, bytes, SIGNING_SECRET, 1531420618_000 + 301_000)).toBe(false);
  });
});
