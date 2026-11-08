import { fileURLToPath } from "node:url";
import {
  createDb,
  createDualReplicaHarness,
  createLocalAccount,
  eventsOf,
  type FakeTelegramMessage,
  type FakeTelegramServer,
  type Harness,
  kernelDb,
  TEST_PASSWORD as PW,
  sleep,
  startFakeTelegram,
  type TgUser,
  telegramPrivateMessage,
  telegramWebhookHeaders,
  waitFor,
} from "@capybara-hq/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/** The plugin's directory: extensions named by package resolve from here. */
const PLUGIN_DIR = fileURLToPath(new URL("../../", import.meta.url));
/** The scripted model provider (a devDependency) that drives the agent runs. */
const MODEL_FAKE = "@capybara-hq/plugin-model-fake";

/**
 * The real Telegram plugin (`plugins/telegram`, loaded by path) in webhook inbound mode, end to end:
 * replica 0 runs `api` + `worker`, replica 1 only `gateway`. The connection starts with long
 * polling, switches to webhook (the poll stops; the admin's `setWebhook` is played by the fake),
 * and an update POSTed to the gateway with the secret header gets one reply. Telegram's redelivery
 * of the same update starts no second run; a wrong secret is refused.
 */

const TELEGRAM = fileURLToPath(new URL("../../src/index.ts", import.meta.url));
const WEBHOOK_SECRET = "dual-telegram-webhook-secret-7c3e";
const ALICE: TgUser = { id: 7101, first_name: "Alice" };

let tg: FakeTelegramServer;
let h: Harness;
let raw: ReturnType<typeof createDb>;

beforeAll(async () => {
  tg = await startFakeTelegram();
  h = await createDualReplicaHarness({
    resolveFrom: PLUGIN_DIR,
    extensions: [MODEL_FAKE, TELEGRAM],
    roles: [["api", "worker"], ["gateway"]],
    extensionConfig: { telegram: { apiUrl: tg.apiUrl } },
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
  await tg?.close();
});

type Json = Record<string, unknown>;

const finalText = (m: FakeTelegramMessage) =>
  tg.edits.findLast((e) => e.chatId === m.chatId && e.messageId === m.messageId)?.text ?? m.text;

describe("Telegram webhook inbound (dual replica, real plugin)", () => {
  it("an update on the gateway → one reply; the same update again starts no second run", async () => {
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

    const ownerId = await createLocalAccount(db, "owner", "O");
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
        disabledTools: [],
      },
      visibility: "org",
    });
    expect(ag.status, JSON.stringify(ag.json)).toBe(201);
    // Alice's Telegram user is already bound to the owner (Telegram user ids are global)
    await db
      .insertInto("identities")
      .values({ source: "telegram:global", external_id: String(ALICE.id), account_id: ownerId })
      .execute();
    const en = await call("PUT", `${base}/extensions/telegram`, { enabled: true });
    expect(en.status, JSON.stringify(en.json)).toBe(200);
    const ch = await call("POST", `${base}/channels`, {
      plugin: "telegram",
      name: "Acme Telegram",
      agentId: (ag.json.agent as { id: string }).id,
      config: { botToken: tg.bot.token, webhookSecret: WEBHOOK_SECRET },
    });
    expect(ch.status, JSON.stringify(ch.json)).toBe(201);
    expect(JSON.stringify(ch.json)).not.toContain(WEBHOOK_SECRET);
    expect(JSON.stringify(ch.json)).not.toContain(tg.bot.token);
    const connId = (ch.json.channel as { id: string }).id;

    // Long polling first (the default), then webhook: the poll stops
    await waitFor(async () => tg.activePollers() === 1 || undefined, 15_000, "long polling");
    const sw = await call("PATCH", `${base}/channels/${connId}`, { inboundMode: "webhook" });
    expect(sw.status, JSON.stringify(sw.json)).toBe(200);
    const webhookUrl = `https://hooks.example.com/channels/webhook/${connId}`;
    expect((sw.json.channel as Json).webhookUrl).toBe(webhookUrl);
    await waitFor(async () => tg.activePollers() === 0 || undefined, 10_000, "poll stopped");
    // The admin registers the URL with Telegram (setWebhook with secret_token)
    tg.setWebhook(webhookUrl);
    const pollsAfterSwitch = tg.calls.filter((c) => c.method.toLowerCase() === "getupdates").length;

    const body = JSON.stringify({
      update_id: 555_000_001,
      ...telegramPrivateMessage(ALICE, "echo:hello telegram webhook", { messageId: 41 }),
    });
    const post = (secret: string) =>
      h.requestTo(1, `/channels/webhook/${connId}`, {
        method: "POST",
        headers: telegramWebhookHeaders(secret),
        body,
      });

    const first = await post(WEBHOOK_SECRET);
    expect(first.status).toBe(200);
    await first.text();
    const replies = () =>
      tg.messages.filter((m) => m.chatId === ALICE.id && finalText(m) === "hello telegram webhook");
    await waitFor(async () => replies()[0], 20_000, "reply");
    const thread = await db
      .selectFrom("channel_threads")
      .select("conversation_id")
      .where("connection_id", "=", connId)
      .where("chat_id", "=", String(ALICE.id))
      .executeTakeFirstOrThrow();
    const countEvents = async (type: string) =>
      (await eventsOf(db, thread.conversation_id)).filter((e) => e.type === type).length;
    await waitFor(
      async () => (await countEvents("run_finished")) === 1 || undefined,
      20_000,
      "run finished",
    );

    // Telegram redelivers the same update (e.g. our answer timed out): acked, not run again
    const again = await post(WEBHOOK_SECRET);
    expect(again.status).toBe(200);
    await again.text();

    // A request without the right secret is refused and enqueues nothing
    const forged = await post("not-the-secret");
    expect(forged.status).toBe(401);
    await forged.text();

    // Barrier: a later update in the same chat; once it is answered, a duplicate of the first would
    // show as an extra user message or run
    const barrier = await h.requestTo(1, `/channels/webhook/${connId}`, {
      method: "POST",
      headers: telegramWebhookHeaders(WEBHOOK_SECRET),
      body: JSON.stringify({
        update_id: 555_000_002,
        ...telegramPrivateMessage(ALICE, "echo:barrier", { messageId: 42 }),
      }),
    });
    expect(barrier.status).toBe(200);
    await barrier.text();
    await waitFor(
      async () => (await countEvents("run_finished")) === 2 || undefined,
      20_000,
      "barrier run finished",
    );
    await sleep(500);
    expect(await countEvents("user_message")).toBe(2);
    expect(await countEvents("run_started")).toBe(2);
    expect(replies()).toHaveLength(1);
    expect(tg.messages.filter((m) => m.chatId === ALICE.id)).toHaveLength(2);
    // Webhook mode never polls again
    expect(tg.calls.filter((c) => c.method.toLowerCase() === "getupdates")).toHaveLength(
      pollsAfterSwitch,
    );
    expect(tg.activePollers()).toBe(0);
  }, 120_000);
});
