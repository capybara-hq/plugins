import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { InboundEvent } from "@capybara-hq/plugin-sdk";
import {
  type FakeSlackServer,
  slackBlockAction,
  slackDmEvent,
  slackMentionEvent,
  startFakeSlack,
} from "@capybara-hq/testing";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { encodeActionValue } from "../src/actions.js";
import { createSlackChannel, PROFILE_CACHE_TTL_SECONDS } from "../src/channel.js";

/**
 * Sender time zone and language (channel@1 `InboundSender.timeZone` / `locale`) from `users.info`
 * with `include_locale=true`, cached in kv per team and user.
 *
 * The fake Slack of @capybara-hq/testing answers `users.info` without `tz` / `locale`, so the Web
 * API goes through a small proxy that adds them from {@link PLATFORM_USERS} (`locale` only when the
 * request asks for it, as Slack does) and forwards everything else unchanged.
 */
const PLATFORM_USERS: Record<string, { tz?: string; locale?: string }> = {
  U1: { tz: "Asia/Shanghai", locale: "zh-CN" },
  U2: { tz: "America/New_York", locale: "en-US" },
};

let slack: FakeSlackServer;
let proxy: Server;
let apiUrl: string;
const log = { info() {}, warn() {}, error() {} };
const stops: (() => Promise<void>)[] = [];

/** Test kv recording each write's TTL (not enforced). */
function memoryKv() {
  const m = new Map<string, string>();
  const ttls = new Map<string, number>();
  return {
    map: m,
    ttls,
    down: false,
    async get(k: string) {
      if (this.down) throw new Error("kv down");
      return m.get(k) ?? null;
    },
    async set(k: string, v: string, o: { ttlSeconds: number }) {
      if (this.down) throw new Error("kv down");
      m.set(k, v);
      ttls.set(k, o.ttlSeconds);
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
  slack.users.set("U1", {
    id: "U1",
    teamId: "T1",
    name: "alice",
    displayName: "Ally",
    image72: "https://avatars.example/u1.png",
  });
  slack.users.set("U2", { id: "U2", teamId: "T1", name: "bob" });
  slack.users.set("U3", { id: "U3", teamId: "T1", name: "carol" });
  proxy = createServer((req, res) => {
    forward(req, res).catch(() => res.destroy());
  });
  const forward = async (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks);
    const method = (req.url ?? "/").replace(/^\//, "");
    const upstream = await fetch(new URL(method, slack.apiUrl), {
      method: req.method ?? "POST",
      headers: Object.fromEntries(
        Object.entries(req.headers).filter(
          (e): e is [string, string] =>
            typeof e[1] === "string" && ["authorization", "content-type"].includes(e[0]),
        ),
      ),
      ...(body.length > 0 && { body }),
    });
    let text = await upstream.text();
    if (method === "users.info" && upstream.ok) {
      const params = new URLSearchParams(body.toString());
      const json = JSON.parse(text) as { ok: boolean; user?: { id: string } };
      const extra = json.user ? PLATFORM_USERS[json.user.id] : undefined;
      if (json.ok && json.user && extra) {
        Object.assign(json.user, {
          ...(extra.tz !== undefined && { tz: extra.tz }),
          ...(extra.locale !== undefined &&
            params.get("include_locale") === "true" && { locale: extra.locale }),
        });
      }
      text = JSON.stringify(json);
    }
    res.writeHead(upstream.status, {
      "content-type": upstream.headers.get("content-type") ?? "application/json",
      ...(upstream.headers.get("retry-after") !== null && {
        "retry-after": upstream.headers.get("retry-after") as string,
      }),
    });
    res.end(text);
  };
  await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", r));
  apiUrl = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}/`;
});
afterEach(async () => {
  for (const s of stops.splice(0)) await s();
  slack.delay("users.info", 0);
  await waitFor(() => slack.openSockets() === 0 || undefined, 5000, "sockets closed");
});
afterAll(async () => {
  await new Promise<void>((r) => proxy?.close(() => r()));
  await slack?.stop();
});

const config = () => ({ appToken: slack.appToken, botToken: slack.botToken });
const waitFor = async <T>(fn: () => T | undefined, ms = 5000, what = "condition"): Promise<T> => {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v !== undefined && v !== false) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
};
const userInfoCalls = (user: string) =>
  slack.calls.filter((c) => c.method === "users.info" && c.body.user === user);

async function connect(kv: ReturnType<typeof memoryKv>) {
  const events: InboundEvent[] = [];
  const ac = new AbortController();
  const before = slack.connectionsOpened();
  const done = createSlackChannel({ apiUrl, log, reconnectBaseMs: 20, kv }).connect({
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
  });
  return events;
}

const senderOf = (e: InboundEvent | undefined) =>
  e && e.type !== "directory_changed" ? e.sender : undefined;

describe("sender time zone and language", () => {
  it("a DM carries users.info tz and locale (asked with include_locale), cached in kv per team + user", async () => {
    const kv = memoryKv();
    const events = await connect(kv);
    const before = userInfoCalls("U1").length;
    await slack.waitForAck(slack.pushEvent(slackDmEvent("U1", "hi", { ts: "1.1" })));
    expect(senderOf(events[0])).toEqual({
      externalId: "U1",
      tenantId: "T1",
      displayName: "Ally",
      avatarUrl: "https://avatars.example/u1.png",
      timeZone: "Asia/Shanghai",
      locale: "zh-CN",
    });
    const calls = userInfoCalls("U1").slice(before);
    expect(calls).toHaveLength(1);
    expect(String(calls[0]?.body.include_locale)).toBe("true");
    expect(JSON.parse(kv.map.get("profile/T1/U1") ?? "{}")).toMatchObject({
      timeZone: "Asia/Shanghai",
      locale: "zh-CN",
    });
    expect(kv.ttls.get("profile/T1/U1")).toBe(PROFILE_CACHE_TTL_SECONDS);

    await slack.waitForAck(slack.pushEvent(slackDmEvent("U1", "again", { ts: "1.2" })));
    expect(userInfoCalls("U1").slice(before)).toHaveLength(1);
    expect(senderOf(events[1])).toMatchObject({ timeZone: "Asia/Shanghai", locale: "zh-CN" });
  });

  it("the kv cache is shared: another replica's channel instance does not call users.info again", async () => {
    const kv = memoryKv();
    const a = await connect(kv);
    const before = userInfoCalls("U2").length;
    await slack.waitForAck(slack.pushEvent(slackDmEvent("U2", "hi", { ts: "2.1" })));
    expect(senderOf(a[0])).toMatchObject({ timeZone: "America/New_York", locale: "en-US" });
    for (const s of stops.splice(0)) await s();
    await waitFor(() => slack.openSockets() === 0 || undefined, 5000, "sockets closed");

    const b = await connect(kv);
    await slack.waitForAck(slack.pushEvent(slackDmEvent("U2", "hi", { ts: "2.2" })));
    expect(senderOf(b[0])).toMatchObject({
      displayName: "bob",
      timeZone: "America/New_York",
      locale: "en-US",
    });
    expect(userInfoCalls("U2").slice(before)).toHaveLength(1);
  });

  it("an app_mention keeps its user_profile name and avatar and adds tz / locale from users.info", async () => {
    const events = await connect(memoryKv());
    const ev = {
      ...slackMentionEvent("U1", "UBOT", "hello", { ts: "3.1", channel: "C1" }),
      user_profile: { display_name: "Ally (event)", image_72: "https://avatars.example/event.png" },
    };
    await slack.waitForAck(slack.pushEvent(ev));
    expect(senderOf(events[0])).toEqual({
      externalId: "U1",
      tenantId: "T1",
      displayName: "Ally (event)",
      avatarUrl: "https://avatars.example/event.png",
      timeZone: "Asia/Shanghai",
      locale: "zh-CN",
    });
  });

  it("a card click carries tz / locale too", async () => {
    const events = await connect(memoryKv());
    const msg = { channel: "C1", ts: "4.1", text: "card", threadTs: "4.0", at: Date.now() };
    const btn = {
      actionId: "cap_a_once",
      value: encodeActionValue({ k: "a", id: "ap-1", action: "approve", scope: "once" }),
    };
    await slack.waitForAck(
      slack.pushInteractive(slackBlockAction({ id: "U1", teamId: "T1" }, msg, btn)),
    );
    expect(senderOf(events[0])).toMatchObject({ timeZone: "Asia/Shanghai", locale: "zh-CN" });
  });

  it("users.info failing (ratelimited) leaves the fields out, caches nothing and still acks", async () => {
    const kv = memoryKv();
    const events = await connect(kv);
    slack.failNext("users.info", { status: 429, retryAfter: 1 });
    await slack.waitForAck(slack.pushEvent(slackDmEvent("U3", "hi", { ts: "5.1" })));
    expect(senderOf(events[0])).toEqual({ externalId: "U3", tenantId: "T1" });
    expect(kv.map.has("profile/T1/U3")).toBe(false);
  });

  it("a slow users.info is dropped after the short timeout: the event is acked without the fields", async () => {
    const kv = memoryKv();
    const events = await connect(kv);
    slack.delay("users.info", 4000);
    const t0 = Date.now();
    await slack.waitForAck(slack.pushEvent(slackDmEvent("U2", "slow", { ts: "6.1" })), 4000);
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(senderOf(events[0])).toEqual({ externalId: "U2", tenantId: "T1" });
    expect(kv.map.has("profile/T1/U2")).toBe(false);
  });

  it("kv down: still looks up users.info and delivers the fields", async () => {
    const kv = memoryKv();
    kv.down = true;
    const events = await connect(kv);
    await slack.waitForAck(slack.pushEvent(slackDmEvent("U1", "hi", { ts: "7.1" })));
    expect(senderOf(events[0])).toMatchObject({ timeZone: "Asia/Shanghai", locale: "zh-CN" });
  });

  it("an unknown user (user_not_found) is cached as empty and gets no fields", async () => {
    const kv = memoryKv();
    const events = await connect(kv);
    await slack.waitForAck(slack.pushEvent(slackDmEvent("U404", "hi", { ts: "8.1" })));
    expect(senderOf(events[0])).toEqual({ externalId: "U404", tenantId: "T1" });
    expect(kv.map.get("profile/T1/U404")).toBe("{}");
    await slack.waitForAck(slack.pushEvent(slackDmEvent("U404", "hi", { ts: "8.2" })));
    expect(userInfoCalls("U404")).toHaveLength(1);
  });
});
