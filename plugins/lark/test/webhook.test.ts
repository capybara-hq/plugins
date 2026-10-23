import type { ChannelWebhookResult, InboundEvent } from "@capybara-hq/plugin-sdk";
import {
  encryptLarkWebhook,
  type FakeLarkMessage,
  type FakeLarkServer,
  larkCardAction,
  larkMessageEvent,
  signLarkWebhook,
  startFakeLark,
} from "@capybara-hq/testing";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { encodeActionValue, VALUE_KEY } from "../src/actions.js";
import { createLarkChannel, LarkConnection } from "../src/channel.js";
import { decryptLarkEvent, verifyLarkSignature } from "../src/webhook.js";

const ENCRYPT_KEY = "kudryavtsev-encrypt-key-7d1e";
const TOKEN = "verification-token";
const log = { info() {}, warn() {}, error() {} };

let lark: FakeLarkServer;
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
  lark = await startFakeLark({ tenantKey: "t1", botOpenId: "ou_bot", botName: "Capybara" });
  lark.users.set("ou_alice", {
    openId: "ou_alice",
    name: "Alice Liddell",
    avatar72: "https://avatars.example/alice.png",
  });
});
afterEach(async () => {
  for (const s of stops.splice(0)) await s();
});
afterAll(async () => {
  await lark?.stop();
});

type Secrets = { encryptKey?: string; verificationToken?: string };
const config = (o: Secrets = { encryptKey: ENCRYPT_KEY, verificationToken: TOKEN }) => ({
  appId: lark.appId,
  appSecret: lark.appSecret,
  ...o,
});
const channel = (kv?: ReturnType<typeof memoryKv>) =>
  createLarkChannel({
    apiUrl: lark.url,
    log,
    reconnectBaseMs: 20,
    statusPollMs: 50,
    ...(kv && { kv }),
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
  o: { sign?: boolean; timestamp?: number; tamper?: boolean; key?: string } = {},
) {
  const now = Date.now();
  const headers: Record<string, string> = {
    "content-type": "application/json; charset=utf-8",
    ...(o.sign !== false &&
      signLarkWebhook(body, o.key ?? ENCRYPT_KEY, {
        timestamp: o.timestamp ?? Math.floor(now / 1000),
      })),
  };
  const bytes = new TextEncoder().encode(body);
  if (o.tamper) bytes[bytes.length - 3] = (bytes[bytes.length - 3] ?? 0) ^ 1;
  return { method: "POST" as const, headers, body: bytes, receivedAt: now };
}

async function handle(
  ch: ReturnType<typeof createLarkChannel>,
  req: ReturnType<typeof request>,
  cfg: unknown = config(),
): Promise<ChannelWebhookResult> {
  if (!ch.webhook) throw new Error("no webhook");
  return ch.webhook.handle({
    connectionId: "conn-1",
    config: LarkConnection.parse(cfg),
    request: req,
    signal: new AbortController().signal,
  });
}

/** Opens a long connection and collects its events. */
async function connect(ch: ReturnType<typeof createLarkChannel>) {
  const events: InboundEvent[] = [];
  const ac = new AbortController();
  const before = lark.connectionsOpened();
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
    () => (lark.connectionsOpened() > before && lark.openSockets() > 0) || undefined,
    5000,
    "socket",
  );
  stops.push(async () => {
    ac.abort();
    await done.catch(() => {});
    await waitFor(() => lark.openSockets() === 0 || undefined, 5000, "sockets closed");
  });
  return events;
}

const botInfoCalls = () => lark.calls.filter((c) => c.api === "bot").length;
const dmEvent = (text: string) => {
  const p = larkMessageEvent({
    openId: "ou_alice",
    chatId: "oc_dm",
    chatType: "p2p",
    text,
    tenantKey: "t1",
  });
  // The fake fills app_id on push; set it here so both modes see the very same payload
  (p.header as Record<string, unknown>).app_id = lark.appId;
  return p;
};

describe("Lark webhook inbound", () => {
  it("connection schema: encryptKey and verificationToken are optional secrets", () => {
    expect(LarkConnection.parse(config({}))).toEqual({
      appId: lark.appId,
      appSecret: lark.appSecret,
    });
    for (const k of ["encryptKey", "verificationToken"] as const) {
      const meta = LarkConnection.shape[k].meta() as { secret?: boolean } | undefined;
      expect(meta?.secret).toBe(true);
    }
  });

  it("an encrypted, signed message event → the same InboundEvent as the long connection", async () => {
    const payload = dmEvent("hello webhook");
    const kv = memoryKv();
    const events = await connect(channel(kv));
    await lark.waitForAck(lark.pushEvent(payload));
    const viaSocket = await waitFor(() => events[0], 5000, "socket event");

    const fresh = channel(memoryKv());
    const before = botInfoCalls();
    const req = request(encryptLarkWebhook(payload, ENCRYPT_KEY));
    const r = await handle(fresh, req);
    expect(r.kind).toBe("events");
    if (r.kind !== "events") return;
    expect(r.ack).toMatchObject({ status: 200, body: "{}" });
    expect(r.events).toEqual([viaSocket]);
    expect(r.events[0]).toMatchObject({
      type: "message",
      messageId: (payload.event as { message: { message_id: string } }).message.message_id,
      sender: { externalId: "ou_alice", tenantId: "t1", displayName: "Alice Liddell" },
      text: "hello webhook",
    });
    // Bot open_id fetched once on the miss, then served from kv (1 h TTL)
    expect(await handle(fresh, req)).toEqual(r);
    expect(botInfoCalls() - before).toBe(1);
    expect([...kv.map.values()]).toEqual(["ou_bot"]);
    expect(kv.ttls).toEqual([3600]);
  });

  it("card.action.trigger → card_action with the same eventId as the long connection", async () => {
    const message = { messageId: "om_card1", chatId: "oc_dm" } as FakeLarkMessage;
    const payload = larkCardAction({ openId: "ou_alice", tenantKey: "t1" }, message, {
      text: "Deny",
      value: {
        [VALUE_KEY]: encodeActionValue({ k: "a", chat: "d", id: "card-1", action: "deny" }),
      },
    });
    (payload.header as Record<string, unknown>).app_id = lark.appId;
    const events = await connect(channel());
    await lark.waitForAck(lark.pushEvent(payload));
    const viaSocket = await waitFor(() => events[0], 5000, "socket event");

    const before = botInfoCalls();
    const r = await handle(channel(), request(encryptLarkWebhook(payload, ENCRYPT_KEY)));
    expect(r.kind).toBe("events");
    if (r.kind !== "events") return;
    expect(r.events).toEqual([viaSocket]);
    expect(r.events[0]).toMatchObject({
      type: "card_action",
      messageId: "om_card1",
      eventId: (payload.header as { event_id: string }).event_id,
      action: { cardKind: "approval", cardId: "card-1", action: "deny" },
    });
    expect(botInfoCalls()).toBe(before);
  });

  it("challenge → responds with the original value (encrypted, and plaintext with the token)", async () => {
    const challenge = "ajls384kdjx98XX";
    const msg = { challenge, token: TOKEN, type: "url_verification" };
    // Lark sends no signature headers on URL verification
    const enc = await handle(
      channel(),
      request(encryptLarkWebhook(msg, ENCRYPT_KEY), { sign: false }),
    );
    expect(enc).toMatchObject({ kind: "respond", response: { status: 200 } });
    if (enc.kind === "respond") expect(JSON.parse(enc.response.body ?? "")).toEqual({ challenge });

    const plain = await handle(channel(), request(JSON.stringify(msg), { sign: false }), {
      ...config({ verificationToken: TOKEN }),
    });
    expect(plain).toEqual(enc);

    const wrong = { ...msg, token: "not-the-token" };
    expect(
      await handle(channel(), request(encryptLarkWebhook(wrong, ENCRYPT_KEY), { sign: false })),
    ).toEqual({ kind: "reject", status: 401 });
  });

  it("rejects 401: timestamp 301 s off, one byte changed, unsigned, wrong token", async () => {
    const body = encryptLarkWebhook(dmEvent("x"), ENCRYPT_KEY);
    const now = Math.floor(Date.now() / 1000);
    for (const req of [
      request(body, { timestamp: now - 301 }),
      request(body, { timestamp: now + 301 }),
      request(body, { tamper: true }),
      request(body, { sign: false }),
      request(body, { key: "another-key" }),
    ]) {
      expect(await handle(channel(), req)).toEqual({ kind: "reject", status: 401 });
    }
    // Signature covers the raw body: change one byte of the JSON wrapper (not the ciphertext)
    const wrapped = body.replace('{"encrypt"', '{ "encrypt"');
    const r = await handle(channel(), {
      ...request(wrapped, { sign: false }),
      headers: { ...request(body).headers },
    });
    expect(r).toEqual({ kind: "reject", status: 401 });

    const wrongToken = dmEvent("x");
    (wrongToken.header as Record<string, unknown>).token = "nope";
    expect(await handle(channel(), request(encryptLarkWebhook(wrongToken, ENCRYPT_KEY)))).toEqual({
      kind: "reject",
      status: 401,
    });
    // Within the window still passes
    expect((await handle(channel(), request(body, { timestamp: now - 290 }))).kind).toBe("events");
  });

  it("decryption failure → 400", async () => {
    for (const body of [
      JSON.stringify({ encrypt: "bm90IGEgY2lwaGVydGV4dA==" }),
      encryptLarkWebhook(dmEvent("x"), "a-different-key"),
    ]) {
      expect(await handle(channel(), request(body))).toEqual({ kind: "reject", status: 400 });
    }
    expect(() => decryptLarkEvent("AAAA", ENCRYPT_KEY)).toThrow();
  });

  it("without encryptKey: plaintext with a matching token only; with neither: 401", async () => {
    const tokenOnly = config({ verificationToken: TOKEN });
    const payload = dmEvent("plain hello");
    const ok = await handle(
      channel(),
      request(JSON.stringify(payload), { sign: false }),
      tokenOnly,
    );
    expect(ok).toMatchObject({
      kind: "events",
      events: [{ type: "message", text: "plain hello" }],
    });

    const bad = dmEvent("plain hello");
    (bad.header as Record<string, unknown>).token = "nope";
    expect(
      await handle(channel(), request(JSON.stringify(bad), { sign: false }), tokenOnly),
    ).toEqual({ kind: "reject", status: 401 });
    // An encrypted body without a key to decrypt it, or plaintext when a key is set
    expect(
      await handle(channel(), request(encryptLarkWebhook(payload, ENCRYPT_KEY)), tokenOnly),
    ).toEqual({ kind: "reject", status: 401 });
    expect(await handle(channel(), request(JSON.stringify(payload)))).toEqual({
      kind: "reject",
      status: 401,
    });
    expect(
      await handle(channel(), request(JSON.stringify(payload), { sign: false }), config({})),
    ).toEqual({ kind: "reject", status: 401 });
  });

  it("verifyLarkSignature: sha256(timestamp + nonce + key + body), constant window", () => {
    const body = new TextEncoder().encode('{"encrypt":"abc"}');
    const h = signLarkWebhook(body, ENCRYPT_KEY, { timestamp: 1_700_000_000, nonce: "n1" });
    expect(verifyLarkSignature(h, body, ENCRYPT_KEY, 1_700_000_000_000)).toBe(true);
    expect(verifyLarkSignature(h, body, ENCRYPT_KEY, 1_700_000_301_000)).toBe(false);
    expect(
      verifyLarkSignature(
        { ...h, "x-lark-request-nonce": "n2" },
        body,
        ENCRYPT_KEY,
        1_700_000_000_000,
      ),
    ).toBe(false);
  });
});
