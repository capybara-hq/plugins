import { fileURLToPath } from "node:url";
import {
  createDualReplicaHarness,
  type FakeSlackServer,
  type Harness,
  signSlackWebhook,
  slackDmEvent,
  slackEventCallback,
  startFakeSlack,
} from "@capybara-hq/testing";
import { Redis } from "ioredis";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { gatewayReplicasKey } from "../../src/channels/supervisor.js";
import { kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { AccountsService } from "../../src/identity/accounts.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import { pidOwningLocalPort } from "../helpers/port-owner.js";
import { eventsOf, PW, waitFor } from "../helpers/runs.js";

/**
 * M7 segment 1 acceptance, end to end over HTTP with the real Slack plugin (loaded by path):
 * replica 0 runs `api` + `worker`, replica 1 and one extra replica run only `gateway`.
 *
 * 1. Two Slack connections in Socket Mode (one Slack app each, on one fake Slack) settle at one
 *    long connection per gateway (`shareSlack: 0`); the api / worker replica holds none.
 * 2. One connection switches to webhook inbound: its socket closes, a signed `event_callback` on a
 *    gateway gets one reply, and Slack's redelivery of the same event starts no second run.
 * 3. SIGKILL the gateway holding the other connection: the surviving gateway takes it over within
 *    `TTL + 2 * scan + 1.5s`, and the DMs pushed meanwhile (queued by the fake, which retries
 *    unacked envelopes on the next socket like Slack) each get exactly one run and one reply.
 *
 * Lease and scan intervals are shortened (defaults 30s / 10s) to TTL 3s and a 300ms scan.
 */

const SLACK = fileURLToPath(new URL("../../../../plugins/slack/src/index.ts", import.meta.url));
const SIGNING_SECRET = "m7-seg1-signing-secret-4c2d";
const LEASE_TTL_MS = 3000;
const SCAN_MS = 300;
const APP_B = {
  appToken: "xapp-m7-second-app",
  botToken: "xoxb-m7-second-bot",
  botUserId: "UBOTB",
};
/** Connection A's DM chat (both connections serve the same Slack user). */
const CHAT_A = "DCHATA";
/** Connection B's DMs during failover, one chat per message. */
const chatB = (i: number) => `DCHATB${i}`;
const KILL_MESSAGES = 3;

let slack: FakeSlackServer;
let h: Harness;
let raw: ReturnType<typeof createDb>;
let redis: Redis;

beforeAll(async () => {
  slack = await startFakeSlack({
    teamId: "T1",
    botUserId: "UBOTA",
    apps: [APP_B],
    redeliverUnacked: true,
  });
  h = await createDualReplicaHarness({
    plugins: [MODEL_FAKE, SLACK],
    roles: [["api", "worker"], ["gateway"]],
    pluginConfig: { slack: { apiUrl: slack.apiUrl } },
    config: {
      auth: { cookieSecure: false },
      http: { publicUrl: "https://cap.example" },
      channels: {
        leaseTtlMs: LEASE_TTL_MS,
        scanIntervalMs: SCAN_MS,
        shareSlack: 0,
        webhookBaseUrl: "https://hooks.example.com",
      },
    },
  });
  raw = createDb(h.dbUrl, 3);
  redis = new Redis(h.redisUrl, { maxRetriesPerRequest: 1 });
}, 120_000);

afterAll(async () => {
  redis?.disconnect();
  await raw?.destroy();
  await h?.stop();
  await slack?.stop();
});

type Json = Record<string, unknown>;

describe("M7 segment 1: gateway roles, fair share, webhook mode, failover (dual replica)", () => {
  it("one long connection per gateway, webhook switch runs once, a killed gateway is taken over", async () => {
    const extra = await h.startExtraReplica(["gateway"]);
    const [apiWorker, gateway] = h.replicas;
    const allPids = [apiWorker.pid, gateway.pid, extra.pid];
    const db = kernelDb(raw);

    let cookie = "";
    const call = async (method: string, path: string, body?: unknown) => {
      const res = await h.request(path, {
        method,
        headers: {
          "x-capybara-csrf": "1",
          ...(cookie !== "" && { cookie }),
          ...(body !== undefined && { "content-type": "application/json" }),
        },
        ...(body !== undefined && { body: JSON.stringify(body) }),
      });
      const text = await res.text();
      if (path === "/api/v1/auth/login") {
        cookie = res.headers
          .getSetCookie()
          .map((c) => c.split(";")[0])
          .join("; ");
      }
      return { status: res.status, json: (text === "" ? {} : JSON.parse(text)) as Json };
    };

    /** pid of the replica holding `appToken`'s Socket Mode connection (exactly one socket open). */
    const holderOf = async (appToken: string) => {
      const ports = slack.socketPeerPorts(appToken);
      if (ports.length !== 1) return undefined;
      return pidOwningLocalPort(ports[0] as number, allPids);
    };

    // ---------- setup: owner, org, agent, the Slack user bound to the owner ----------
    const ownerId = (
      await new AccountsService(db).createLocal({ login: "owner", password: PW, displayName: "O" })
    ).id;
    expect(
      (await call("POST", "/api/v1/auth/login", { login: "owner", password: PW })).status,
    ).toBe(200);
    const org = await call("POST", "/api/v1/orgs", { name: "Acme" });
    expect(org.status).toBe(201);
    const base = `/api/v1/orgs/${(org.json.org as { id: string }).id}`;
    const ag = await call("POST", `${base}/agents`, {
      definition: {
        name: "Helper",
        instructions: "Be helpful.",
        model: { provider: "model-fake", model: "fake-1" },
        tools: [],
      },
      visibility: "org",
    });
    expect(ag.status, JSON.stringify(ag.json)).toBe(201);
    const agentId = (ag.json.agent as { id: string }).id;
    await sql`INSERT INTO capybara.identities (source, external_id, account_id)
      VALUES ('slack:T1', 'UALICE', ${ownerId})`.execute(raw);
    slack.users.set("UALICE", { id: "UALICE", teamId: "T1", name: "alice", displayName: "Alice" });
    const en = await call("PUT", `${base}/plugins/slack`, { enabled: true });
    expect(en.status, JSON.stringify(en.json)).toBe(200);

    const create = async (name: string, config: Json) => {
      const ch = await call("POST", `${base}/channels`, { plugin: "slack", name, agentId, config });
      expect(ch.status, JSON.stringify(ch.json)).toBe(201);
      return (ch.json.channel as { id: string }).id;
    };
    const connA = await create("Slack A", {
      appToken: slack.appToken,
      botToken: slack.botToken,
      signingSecret: SIGNING_SECRET,
    });
    const connB = await create("Slack B", { appToken: APP_B.appToken, botToken: APP_B.botToken });

    const threadConv = async (connectionId: string, chatId: string) =>
      (
        await db
          .selectFrom("channel_threads")
          .select("conversation_id")
          .where("connection_id", "=", connectionId)
          .where("chat_id", "=", chatId)
          .where("archived_at", "is", null)
          .executeTakeFirst()
      )?.conversation_id;
    const countEvents = async (conv: string, type: string) =>
      (await eventsOf(db, conv)).filter((e) => e.type === type).length;
    const repliesIn = (chat: string, text: string) =>
      slack.messages.filter((m) => m.channel === chat && slack.finalText(m) === text);

    // ================= 1. one long connection per gateway, none on the api / worker replica ==========
    const [holderA, holderB] = await waitFor(
      async () => {
        const a = await holderOf(slack.appToken);
        const b = await holderOf(APP_B.appToken);
        if (a === undefined || b === undefined || a === b) return undefined;
        return [a, b] as const;
      },
      30_000,
      "one Socket Mode connection per gateway",
      100,
    );
    expect([holderA, holderB].sort()).toEqual([gateway.pid, extra.pid].sort());
    expect([holderA, holderB]).not.toContain(apiWorker.pid);
    expect(slack.maxConcurrentSockets(slack.appToken)).toBe(1);
    expect(slack.maxConcurrentSockets(APP_B.appToken)).toBe(1);

    // ================= 2. connection A switches to webhook: socket closes, one run per event ==========
    const sw = await call("PATCH", `${base}/channels/${connA}`, { inboundMode: "webhook" });
    expect(sw.status, JSON.stringify(sw.json)).toBe(200);
    expect((sw.json.channel as Json).webhookUrl).toBe(
      `https://hooks.example.com/channels/webhook/${connA}`,
    );
    await waitFor(
      async () => slack.openSockets(slack.appToken) === 0 || undefined,
      10_000,
      "connection A's socket closed",
    );

    const body = JSON.stringify(
      slackEventCallback(
        slackDmEvent("UALICE", "echo:hello over webhook", {
          channel: CHAT_A,
          ts: "1760100000.000100",
        }),
        { teamId: "T1", eventId: "EvM7Webhook1" },
      ),
    );
    const post = (retry: number) =>
      h.requestTo(gateway.index, `/channels/webhook/${connA}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(retry > 0 && {
            "x-slack-retry-num": String(retry),
            "x-slack-retry-reason": "http_timeout",
          }),
          ...signSlackWebhook(body, SIGNING_SECRET, Math.floor(Date.now() / 1000)),
        },
        body,
      });
    const first = await post(0);
    expect(first.status).toBe(200);
    await first.text();
    await waitFor(async () => repliesIn(CHAT_A, "hello over webhook")[0], 20_000, "webhook reply");
    // Slack's redelivery of the same event: acked (the dedupe key or the same job id), no new run
    const again = await post(1);
    expect(again.status).toBe(200);
    await again.text();
    const convA = (await threadConv(connA, CHAT_A)) as string;
    expect(convA).toBeDefined();
    await waitFor(
      async () => (await countEvents(convA, "run_finished")) === 1 || undefined,
      20_000,
      "webhook run finished",
    );
    expect(await countEvents(convA, "run_started")).toBe(1);
    expect(repliesIn(CHAT_A, "hello over webhook")).toHaveLength(1);
    expect(slack.messages.filter((m) => m.channel === CHAT_A)).toHaveLength(1);
    expect(slack.openSockets(slack.appToken)).toBe(0);

    // ================= 3. SIGKILL the gateway holding B: takeover, exactly once per pushed DM =========
    // With one long connection left, the fair share gives it to the lowest-ranked live gateway
    // (rank = position of the replica id, `<host>-<pid>-<hex>`, among the plugin's live members):
    // wait for that, so the replica killed below is the settled holder, not one handing B over.
    const settledHolder = await waitFor(
      async () => {
        // Both gateways are alive here, and the api / worker replica never heartbeats
        const members = await redis.zrange(gatewayReplicasKey("slack"), "0", "-1");
        const livePids = members.sort().map((id) => Number(/-(\d+)-[0-9a-f]+$/.exec(id)?.[1]));
        if (livePids.length !== 2 || !livePids.every((p) => p === gateway.pid || p === extra.pid))
          return undefined;
        const holder = await holderOf(APP_B.appToken);
        return holder !== undefined && holder === livePids[0] ? holder : undefined;
      },
      20_000,
      "connection B held by the rank-0 gateway",
      100,
    );
    const survivor = settledHolder === gateway.pid ? extra : gateway;
    const holderPort = slack.socketPeerPorts(APP_B.appToken)[0];

    const killedAt = Date.now();
    if (settledHolder === gateway.pid) await h.kill(gateway.index);
    else await extra.kill();
    const pushed = Array.from({ length: KILL_MESSAGES }, (_, i) =>
      slack.pushEvent(
        slackDmEvent("UALICE", `echo:during failover ${i}`, {
          channel: chatB(i),
          ts: `1760100100.00010${i}`,
        }),
        { appToken: APP_B.appToken, eventId: `EvM7Failover${i}` },
      ),
    );

    await waitFor(
      async () => {
        const ports = slack.socketPeerPorts(APP_B.appToken);
        if (ports.length !== 1 || ports[0] === holderPort) return undefined;
        return (await holderOf(APP_B.appToken)) === survivor.pid || undefined;
      },
      LEASE_TTL_MS + 15_000,
      "takeover by the surviving gateway",
      50,
    );
    // Lease expiry plus up to two scan rounds; the margin covers the Socket Mode handshake, this
    // test's polling (lsof) and load on a busy runner
    expect(Date.now() - killedAt).toBeLessThanOrEqual(LEASE_TTL_MS + 2 * SCAN_MS + 1_500);
    expect(slack.maxConcurrentSockets(APP_B.appToken)).toBe(1);

    // Every pushed envelope acked by the new holder: nothing is left for the fake to redeliver
    for (const id of pushed) await slack.waitForAck(id, 30_000);
    await waitFor(
      async () => slack.pendingEnvelopes(APP_B.appToken) === 0 || undefined,
      10_000,
      "no unacked envelopes",
    );
    // One DM chat (so one conversation) per pushed message: each event is exactly one user message,
    // one run and one reply. (DMs queued into one chat would be answered by a single run.)
    for (let i = 0; i < KILL_MESSAGES; i++) {
      const chat = chatB(i);
      const conv = await waitFor(async () => threadConv(connB, chat), 20_000, `${chat} thread`);
      await waitFor(
        async () => (await countEvents(conv, "run_finished")) === 1 || undefined,
        30_000,
        `${chat} run finished`,
      );
      expect(await countEvents(conv, "user_message")).toBe(1);
      expect(await countEvents(conv, "run_started")).toBe(1);
      const replies = await waitFor(
        async () => {
          const r = repliesIn(chat, `during failover ${i}`);
          return r.length > 0 ? r : undefined;
        },
        20_000,
        `${chat} reply`,
      );
      expect(replies).toHaveLength(1);
      expect(slack.messages.filter((m) => m.channel === chat)).toHaveLength(1);
    }
    expect(
      await db
        .selectFrom("channel_threads")
        .select("conversation_id")
        .where("connection_id", "=", connB)
        .execute(),
    ).toHaveLength(KILL_MESSAGES);
    // The webhook connection stayed off Socket Mode throughout
    expect(slack.openSockets(slack.appToken)).toBe(0);
  }, 240_000);
});
