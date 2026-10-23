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
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { AccountsService } from "../../src/identity/accounts.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import { PW, sleep, waitFor } from "../helpers/runs.js";

/**
 * The real Slack plugin (`plugins/slack`, loaded by path) in webhook inbound mode, end to end:
 * replica 0 runs `api` + `worker`, replica 1 only `gateway`. The gateway takes a signed
 * `event_callback`, the worker streams the reply to the fake Slack once, and Slack's redelivery
 * (`x-slack-retry-num: 1`) of the same event starts no second run.
 */

const SLACK = fileURLToPath(new URL("../../../../plugins/slack/src/index.ts", import.meta.url));
const SIGNING_SECRET = "dual-slack-signing-secret-9a1b";

let slack: FakeSlackServer;
let h: Harness;
let raw: ReturnType<typeof createDb>;

beforeAll(async () => {
  slack = await startFakeSlack({ teamId: "T1", botUserId: "UBOT" });
  h = await createDualReplicaHarness({
    plugins: [MODEL_FAKE, SLACK],
    roles: [["api", "worker"], ["gateway"]],
    pluginConfig: { slack: { apiUrl: slack.apiUrl } },
    config: {
      auth: { cookieSecure: false },
      http: { publicUrl: "https://cap.example" },
      channels: {
        leaseTtlMs: 3000,
        scanIntervalMs: 300,
        webhookBaseUrl: "https://hooks.example.com",
      },
    },
  });
  raw = createDb(h.dbUrl, 3);
}, 120_000);

afterAll(async () => {
  await raw?.destroy();
  await h?.stop();
  await slack?.stop();
});

type Json = Record<string, unknown>;

describe("Slack webhook inbound (dual replica, real plugin)", () => {
  it("a signed event_callback on the gateway → one streamed reply; a retry starts no second run", async () => {
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

    const ownerId = (
      await new AccountsService(kernelDb(raw)).createLocal({
        login: "owner",
        password: PW,
        displayName: "O",
      })
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
    await sql`INSERT INTO capybara.identities (source, external_id, account_id)
      VALUES ('slack:T1', 'UALICE', ${ownerId})`.execute(raw);
    slack.users.set("UALICE", { id: "UALICE", teamId: "T1", name: "alice", displayName: "Alice" });
    const en = await call("PUT", `${base}/plugins/slack`, { enabled: true });
    expect(en.status, JSON.stringify(en.json)).toBe(200);
    const ch = await call("POST", `${base}/channels`, {
      plugin: "slack",
      name: "Acme Slack",
      agentId: (ag.json.agent as { id: string }).id,
      config: {
        appToken: slack.appToken,
        botToken: slack.botToken,
        signingSecret: SIGNING_SECRET,
      },
    });
    expect(ch.status, JSON.stringify(ch.json)).toBe(201);
    expect(JSON.stringify(ch.json)).not.toContain(SIGNING_SECRET);
    const connId = (ch.json.channel as { id: string }).id;

    // Socket Mode first (the default), then switch to webhook: the socket closes
    await waitFor(async () => slack.openSockets() === 1 || undefined, 15_000, "socket mode");
    const sw = await call("PATCH", `${base}/channels/${connId}`, { inboundMode: "webhook" });
    expect(sw.status, JSON.stringify(sw.json)).toBe(200);
    expect((sw.json.channel as Json).webhookUrl).toBe(
      `https://hooks.example.com/channels/webhook/${connId}`,
    );
    await waitFor(async () => slack.openSockets() === 0 || undefined, 10_000, "socket closed");

    const body = JSON.stringify(
      slackEventCallback(
        slackDmEvent("UALICE", "echo:hello slack webhook", { ts: "1750000123.000100" }),
        { teamId: "T1", eventId: "EvDual1" },
      ),
    );
    const post = (retry: number) =>
      h.requestTo(1, `/channels/webhook/${connId}`, {
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

    const replies = () =>
      slack.messages.filter(
        (m) => m.channel === "DUALICE" && slack.finalText(m) === "hello slack webhook",
      );
    const reply = await waitFor(async () => replies()[0], 20_000, "reply");
    expect(reply.channel).toBe("DUALICE");

    // Slack's retry of the same event: acked, not run again
    const again = await post(1);
    expect(again.status).toBe(200);
    await again.text();

    // A forged request is refused and enqueues nothing
    const forged = await h.requestTo(1, `/channels/webhook/${connId}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...signSlackWebhook(body, "not-the-secret", Math.floor(Date.now() / 1000)),
      },
      body,
    });
    expect(forged.status).toBe(401);
    await forged.text();

    await sleep(1500);
    expect(replies()).toHaveLength(1);
    expect(slack.messages.filter((m) => m.channel === "DUALICE")).toHaveLength(1);
    expect(slack.openSockets()).toBe(0);
  }, 120_000);
});
