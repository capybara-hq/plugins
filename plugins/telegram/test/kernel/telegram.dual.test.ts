import { fileURLToPath } from "node:url";
import {
  cardRecorded,
  createDb,
  createDualReplicaHarness,
  createLocalAccount,
  eventsOf,
  type FakeChannelServer,
  type FakeTelegramMessage,
  type FakeTelegramServer,
  fakeExtensionEntry,
  findTelegramButton,
  type Harness,
  type KernelSchemaDb,
  kernelDb,
  TEST_PASSWORD as PW,
  pidOwningLocalPort,
  sleep,
  startFakeChannelServer,
  startFakeTelegram,
  startTestPostgres,
  startTestRedis,
  type TestContainer,
  type TgChat,
  type TgUser,
  telegramCallback,
  telegramGroupMessage,
  telegramPrivateMessage,
  waitFor,
} from "@capybara-hq/testing";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

/** The plugin's directory: extensions named by package resolve from here. */
const PLUGIN_DIR = fileURLToPath(new URL("../../", import.meta.url));
/** The scripted model provider (a devDependency) that drives the agent runs. */
const MODEL_FAKE = "@capybara-hq/plugin-model-fake";

/**
 * The real Telegram plugin (`plugins/telegram`, loaded by path) in two kernel replicas against the
 * fake Bot API, long polling:
 *  (a) exactly one `getUpdates` poller across both replicas;
 *  (b) an unbound user's private message gets the bind card (URL button), bound on the web;
 *  (c) the next private message streams: one `sendMessage`, then edits, final text exact;
 *  (d) a group mention is answered as a reply to it; a reply to the bot's reply continues the same
 *      conversation;
 *  (e) a write tool (fake-im's `post_announcement`, policy ask) → approval card in the group thread →
 *      the button click → the card is edited to approved, the final reply arrives once, the
 *      callback query is answered;
 *  (h) a single-select question (the fixture tool `fake-ask.pick`) → the kernel's fixed text and the
 *      card arrive as one message with option buttons → the click → that message is edited once to
 *      answered, and the run's final reply arrives once;
 *  (g) `unboundPolicy: "anonymous"` still gives every Telegram sender the bind card (senders are
 *      external: tenant `global` ≠ the connection's `bot<id>`), and no agent run;
 *  (f) SIGKILL of the replica holding the poll: the other replica polls, never overlapping, and a
 *      message pushed meanwhile is answered once.
 */

const TELEGRAM = fileURLToPath(new URL("../../src/index.ts", import.meta.url));
const FAKE_IM = fakeExtensionEntry("fake-im");
const FAKE_ASK = fileURLToPath(new URL("./fixtures/fake-ask.ts", import.meta.url));
const PUBLIC = "https://cap.example";
const LONG =
  "Streaming replies reach Telegram as a draft that keeps growing until it is final. ".repeat(2);
const LEASE_TTL_MS = 3000;

const ALICE: TgUser = { id: 7001, first_name: "Alice" };
const BOB: TgUser = { id: 7002, first_name: "Bob" };
const OPS: TgChat = { id: -100200300, type: "supergroup", title: "Ops" };

let pgc: TestContainer;
let rdc: TestContainer;
let tg: FakeTelegramServer;
let im: FakeChannelServer;
let h: Harness | undefined;
const cleanups: (() => Promise<unknown> | unknown)[] = [];

beforeAll(async () => {
  [pgc, rdc] = await Promise.all([startTestPostgres(), startTestRedis()]);
  tg = await startFakeTelegram();
  im = await startFakeChannelServer();
}, 120_000);

afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
  await h?.stop();
  h = undefined;
});

afterAll(async () => {
  await Promise.all([tg?.close(), im?.stop()]);
  await Promise.all([pgc?.stop(), rdc?.stop()]);
});

type Json = Record<string, unknown>;
type Jar = Map<string, string>;

function absorb(jar: Jar, res: Response): void {
  for (const c of res.headers.getSetCookie()) {
    const pair = c.split(";")[0] ?? "";
    const i = pair.indexOf("=");
    const name = pair.slice(0, i).trim();
    const value = pair.slice(i + 1).trim();
    if (value === "" || /max-age=0/i.test(c)) jar.delete(name);
    else jar.set(name, value);
  }
}
const cookieHeader = (jar: Jar) => [...jar].map(([k, v]) => `${k}=${v}`).join("; ");

/** The latest version of a sent message: its last edit, else the message itself. */
const latest = (m: FakeTelegramMessage) =>
  tg.edits.findLast((e) => e.chatId === m.chatId && e.messageId === m.messageId) ?? m;
const finalText = (m: FakeTelegramMessage) => latest(m).text;
const sentTo = (chatId: number) => tg.messages.filter((m) => m.chatId === chatId);
const editsOf = (m: FakeTelegramMessage) =>
  tg.edits.filter((e) => e.chatId === m.chatId && e.messageId === m.messageId);
const repliesWith = (chatId: number, text: string) =>
  sentTo(chatId).filter((m) => finalText(m) === text);

describe("Telegram plugin in the kernel (dual replica, long polling)", () => {
  it("one poller → bind card → streamed reply → group threads → approval click → question click → anonymous policy → failover", async () => {
    h = await createDualReplicaHarness({
      resolveFrom: PLUGIN_DIR,
      extensions: [MODEL_FAKE, FAKE_IM, FAKE_ASK, TELEGRAM],
      pgUrl: pgc.url,
      redisUrl: rdc.url,
      extensionConfig: {
        "fake-im": {
          platformUrl: im.url,
          tenant: "t1",
          clientId: "cli_login",
          clientSecret: "login-secret-5f6e7d",
        },
        telegram: { apiUrl: tg.apiUrl },
      },
      config: {
        auth: { cookieSecure: false },
        http: { publicUrl: PUBLIC },
        channels: { leaseTtlMs: LEASE_TTL_MS, scanIntervalMs: 300 },
        runtime: { jobLockMs: 2000, stalledIntervalMs: 1000 },
      },
    });
    const harness = h;
    const raw = createDb(harness.dbUrl, 3);
    cleanups.push(() => raw.destroy());
    const db: KernelSchemaDb = kernelDb(raw);

    const call = async (jar: Jar, method: string, path: string, body?: unknown) => {
      const res = await harness.request(path, {
        method,
        redirect: "manual",
        headers: {
          "x-capybara-csrf": "1",
          ...(jar.size > 0 && { cookie: cookieHeader(jar) }),
          ...(body !== undefined && { "content-type": "application/json" }),
        },
        ...(body !== undefined && { body: JSON.stringify(body) }),
      });
      absorb(jar, res);
      const text = await res.text();
      const isJson = res.headers.get("content-type")?.includes("json") === true && text !== "";
      return { status: res.status, json: (isJson ? JSON.parse(text) : {}) as Json };
    };

    const ownerJar: Jar = new Map();
    const aliceJar: Jar = new Map();
    await createLocalAccount(db, "owner", "O");
    expect(
      (await call(ownerJar, "POST", "/api/v1/auth/login", { login: "owner", password: PW })).status,
    ).toBe(200);
    const org = await call(ownerJar, "POST", "/api/v1/orgs", { name: "Acme" });
    const orgId = (org.json.org as { id: string }).id;
    const base = `/api/v1/orgs/${orgId}`;
    const inv = await call(ownerJar, "POST", `${base}/invitations`, { role: "member" });
    const accepted = await call(aliceJar, "POST", `/api/v1/invitations/${inv.json.token}/accept`, {
      login: "alice",
      password: PW,
      displayName: "Alice",
    });
    expect(accepted.status, JSON.stringify(accepted.json)).toBe(200);
    const aliceId = (accepted.json.account as { id: string }).id;

    // ================= setup: plugins, agent, Telegram connection =================
    const book = im.book("acme-telegram");
    for (const [plugin, body] of [
      ["fake-im", { enabled: true, config: { url: book.url } }],
      ["fake-ask", { enabled: true }],
      ["telegram", { enabled: true }],
    ] as const) {
      const en = await call(ownerJar, "PUT", `${base}/extensions/${plugin}`, body);
      expect(en.status, JSON.stringify(en.json)).toBe(200);
    }
    const ag = await call(ownerJar, "POST", `${base}/agents`, {
      definition: {
        name: "Helper",
        instructions: "Be helpful.",
        model: { provider: "model-fake", model: "fake-1" },
        disabledTools: [],
      },
      visibility: "org",
    });
    expect(ag.status, JSON.stringify(ag.json)).toBe(201);
    const ch = await call(ownerJar, "POST", `${base}/channels`, {
      plugin: "telegram",
      name: "Acme Telegram",
      agentId: (ag.json.agent as { id: string }).id,
      config: { botToken: tg.bot.token },
    });
    expect(ch.status, JSON.stringify(ch.json)).toBe(201);
    expect(ch.json.channel).toMatchObject({
      plugin: "telegram",
      tenantId: `bot${tg.bot.id}`,
      botUserId: String(tg.bot.id),
    });
    expect(JSON.stringify(ch.json)).not.toContain(tg.bot.token);
    const connId = (ch.json.channel as { id: string }).id;

    const threadsIn = async (chatId: number) =>
      db
        .selectFrom("channel_threads")
        .select("conversation_id")
        .where("connection_id", "=", connId)
        .where("chat_id", "=", String(chatId))
        .execute();
    const countEvents = async (conv: string, type: string) =>
      (await eventsOf(db, conv)).filter((e) => e.type === type).length;

    // ================= (a) exactly one poller across both replicas =================
    await waitFor(async () => tg.activePollers() === 1 || undefined, 15_000, "one poller");
    await sleep(1000);
    expect(tg.activePollers()).toBe(1);
    expect(tg.maxConcurrentPollers()).toBe(1);

    // ================= (b) unbound → bind card (URL button) → bound on the web =================
    tg.push(telegramPrivateMessage(ALICE, "hello"));
    const bindMsg = await waitFor(async () => sentTo(ALICE.id)[0], 15_000, "bind card");
    expect(bindMsg.text).toBe("Please link your Capybara account before chatting with me.");
    const bindBtn = findTelegramButton(bindMsg.replyMarkup, (b) => b.url !== undefined);
    expect(bindBtn?.url?.startsWith(`${PUBLIC}/bind/cap_bind_`)).toBe(true);
    const token = (bindBtn?.url ?? "").slice(`${PUBLIC}/bind/`.length);
    expect((await call(aliceJar, "POST", `/api/v1/bind/${token}`)).status).toBe(200);
    const identity = await db
      .selectFrom("identities")
      .select(["account_id", "source"])
      .where("external_id", "=", String(ALICE.id))
      .executeTakeFirstOrThrow();
    expect(identity).toEqual({ account_id: aliceId, source: "telegram:global" });

    // ================= (c) streamed private reply: one sendMessage, then edits =================
    const before = sentTo(ALICE.id).length;
    tg.push(telegramPrivateMessage(ALICE, `slow:120:${LONG}`));
    const draft = await waitFor(
      async () => sentTo(ALICE.id).slice(before)[0],
      20_000,
      "draft message",
    );
    expect(draft.text.length).toBeLessThan(LONG.length);
    // The plugin trims the inbound text, so model-fake echoes it without the trailing space
    await waitFor(
      async () => finalText(draft) === LONG.trimEnd() || undefined,
      30_000,
      "final text",
    );
    expect(editsOf(draft).length).toBeGreaterThanOrEqual(1);
    expect(latest(draft).parseMode).toBe("HTML");
    // Barrier: the run is over, so no further message for it can come
    const [dmThread] = await threadsIn(ALICE.id);
    expect(dmThread).toBeDefined();
    const dmConv = dmThread?.conversation_id as string;
    await waitFor(
      async () => (await countEvents(dmConv, "run_finished")) === 1 || undefined,
      20_000,
      "dm run finished",
    );
    expect(sentTo(ALICE.id).slice(before)).toHaveLength(1);

    // ================= (d) group mention → reply to it; a reply to the bot continues =================
    tg.push(
      telegramGroupMessage(OPS, ALICE, "echo:hello group", {
        messageId: 3001,
        mention: tg.bot.username,
      }),
    );
    const groupReply = await waitFor(
      async () => repliesWith(OPS.id, "hello group")[0],
      20_000,
      "group reply",
    );
    expect(groupReply.replyToMessageId).toBe(3001);
    const [groupThread] = await threadsIn(OPS.id);
    expect(groupThread).toBeDefined();
    const groupConv = groupThread?.conversation_id as string;
    await waitFor(
      async () => (await countEvents(groupConv, "run_finished")) === 1 || undefined,
      20_000,
      "group run finished",
    );

    // A reply to the bot's reply, without a mention: same thread, same conversation
    tg.push(
      telegramGroupMessage(OPS, ALICE, "echo:follow up", {
        messageId: 3002,
        replyTo: { messageId: groupReply.messageId, fromBot: tg.bot, text: "hello group" },
      }),
    );
    const followUp = await waitFor(
      async () => repliesWith(OPS.id, "follow up")[0],
      20_000,
      "follow-up reply",
    );
    // Replies in a thread point at the thread's root message
    expect(followUp.replyToMessageId).toBe(3001);
    await waitFor(
      async () => (await countEvents(groupConv, "run_finished")) === 2 || undefined,
      20_000,
      "follow-up run finished",
    );
    expect(await threadsIn(OPS.id)).toHaveLength(1);
    expect(await countEvents(groupConv, "user_message")).toBe(2);

    // ================= (e) approval card in the group thread → click → approved, final reply ====
    const tool = 'tool:plugin__fake-im__post_announcement:{"text":"Office closed on Friday"}';
    tg.push(telegramGroupMessage(OPS, ALICE, tool, { messageId: 3003, mention: tg.bot.username }));
    const cardMsg = await waitFor(
      async () =>
        sentTo(OPS.id).find(
          (m) =>
            findTelegramButton(
              m.replyMarkup,
              (b) => b.callback_data?.startsWith("cb:") === true,
            ) !== undefined,
        ),
      20_000,
      "approval card",
    );
    expect(cardMsg.replyToMessageId).toBe(3003);
    expect(cardMsg.text).toContain("post_announcement");
    expect(cardMsg.text).toContain("Office closed on Friday");
    expect(im.posts).toEqual([]);

    const approve = findTelegramButton(cardMsg.replyMarkup, (b) => b.text === "Approve once");
    if (!approve?.callback_data) throw new Error("no approve button");
    await cardRecorded(db, { kind: "approval" });
    const queryId = "cbq-approve-1";
    tg.push(
      telegramCallback(
        ALICE,
        { chatId: OPS.id, messageId: cardMsg.messageId },
        approve.callback_data,
        { id: queryId },
      ),
    );
    await waitFor(
      async () => finalText(cardMsg).includes("Approved") || undefined,
      20_000,
      "card edited to approved",
    );
    expect(
      findTelegramButton(latest(cardMsg).replyMarkup, (b) => b.callback_data !== undefined),
    ).toBe(undefined);
    const finalReply = await waitFor(
      async () => repliesWith(OPS.id, "Tool result: Announcement posted (post_1).")[0],
      20_000,
      "final reply in the thread",
    );
    expect(finalReply.replyToMessageId).toBe(3003);
    await waitFor(
      async () => tg.callbackAnswers.includes(queryId) || undefined,
      10_000,
      "callback answered",
    );
    // Barrier: the approval thread's run (it waits for the approval and continues after it) is
    // over, so no further reply for it can come
    const approvalThread = await db
      .selectFrom("channel_threads")
      .select("conversation_id")
      .where("connection_id", "=", connId)
      .where("thread_key", "=", `${OPS.id}:3003`)
      .executeTakeFirstOrThrow();
    await waitFor(
      async () =>
        (await countEvents(approvalThread.conversation_id, "run_finished")) === 1 || undefined,
      20_000,
      "approval runs finished",
    );
    expect(repliesWith(OPS.id, "Tool result: Announcement posted (post_1).")).toHaveLength(1);
    expect(im.posts).toHaveLength(1);

    // ================= (h) question card: one message, option click → edited once, reply once ====
    const beforeAsk = sentTo(ALICE.id).length;
    tg.push(telegramPrivateMessage(ALICE, "tool:plugin__fake-ask__pick:{}"));
    const askMsg = await waitFor(
      async () =>
        sentTo(ALICE.id)
          .slice(beforeAsk)
          .find(
            (m) => findTelegramButton(m.replyMarkup, (b) => b.text === "staging") !== undefined,
          ),
      20_000,
      "question card",
    );
    // The kernel's fixed text and the card are one message (a second one would break the update)
    expect(askMsg.text).toContain("Your input is needed");
    expect(askMsg.text).toContain("Deploy target");
    expect(sentTo(ALICE.id).slice(beforeAsk)).toHaveLength(1);
    const staging = findTelegramButton(askMsg.replyMarkup, (b) => b.text === "staging");
    if (!staging?.callback_data) throw new Error("no option button");
    expect(
      findTelegramButton(askMsg.replyMarkup, (b) => b.text === "production")?.callback_data,
    ).toMatch(/^cb:/);
    await cardRecorded(db, { kind: "question" });
    const askQueryId = "cbq-question-1";
    tg.push(
      telegramCallback(
        ALICE,
        { chatId: ALICE.id, messageId: askMsg.messageId },
        staging.callback_data,
        { id: askQueryId },
      ),
    );
    await waitFor(
      async () => finalText(askMsg).includes("Answered") || undefined,
      20_000,
      "question card edited to answered",
    );
    expect(finalText(askMsg)).toContain("Your input is needed");
    expect(
      findTelegramButton(latest(askMsg).replyMarkup, (b) => b.callback_data !== undefined),
    ).toBe(undefined);
    await waitFor(
      async () => repliesWith(ALICE.id, "Tool result: Picked staging")[0],
      20_000,
      "reply after the answer",
    );
    await waitFor(
      async () => tg.callbackAnswers.includes(askQueryId) || undefined,
      10_000,
      "question callback answered",
    );
    // Barrier: a later message in the same conversation is answered after the question's run
    tg.push(telegramPrivateMessage(ALICE, "echo:barrier after question"));
    await waitFor(
      async () => repliesWith(ALICE.id, "barrier after question")[0],
      20_000,
      "barrier reply after question",
    );
    expect(editsOf(askMsg)).toHaveLength(1);
    expect(repliesWith(ALICE.id, "Tool result: Picked staging")).toHaveLength(1);

    // ================= (g) anonymous policy: Telegram senders are external → bind card, no run ====
    const conversationsBefore = (await db.selectFrom("conversations").select("id").execute())
      .length;
    const patched = await call(ownerJar, "PATCH", `${base}/channels/${connId}`, {
      unboundPolicy: "anonymous",
    });
    expect(patched.status, JSON.stringify(patched.json)).toBe(200);
    tg.push(telegramPrivateMessage(BOB, "hello from bob"));
    const bobCard = await waitFor(async () => sentTo(BOB.id)[0], 20_000, "bind card for bob");
    expect(bobCard.text).toBe("Please link your Capybara account before chatting with me.");
    expect(
      findTelegramButton(bobCard.replyMarkup, (b) => b.url?.startsWith(`${PUBLIC}/bind/`) === true),
    ).toBeDefined();
    // In a group the kernel asks for a private message instead (a bind link there is anyone's)
    tg.push(
      telegramGroupMessage(OPS, BOB, "echo:let me in", {
        messageId: 3004,
        mention: tg.bot.username,
      }),
    );
    await waitFor(
      async () =>
        sentTo(OPS.id).find(
          (m) => m.text === "Please send me a direct message to link your Capybara account first.",
        ),
      20_000,
      "bind-in-DM prompt",
    );
    // Barrier: a bound user's later message is answered, so Bob's updates (earlier in the queue)
    // have been handled
    tg.push(telegramPrivateMessage(ALICE, "echo:barrier after bob"));
    await waitFor(
      async () => repliesWith(ALICE.id, "barrier after bob")[0],
      20_000,
      "barrier reply",
    );
    expect(sentTo(BOB.id)).toHaveLength(1);
    expect(await threadsIn(BOB.id)).toHaveLength(0);
    expect(repliesWith(OPS.id, "let me in")).toHaveLength(0);
    expect((await db.selectFrom("conversations").select("id").execute()).length).toBe(
      conversationsBefore,
    );

    // ================= (f) SIGKILL the replica holding the poll → the other one polls ===========
    const pids = harness.replicas.map((r) => r.pid);
    const holderPid = await waitFor(
      async () => {
        const ports = tg.pollerPeerPorts();
        if (ports.length !== 1) return undefined;
        return pidOwningLocalPort(ports[0] as number, pids);
      },
      15_000,
      "the replica holding the poll",
      100,
    );
    const holder = harness.replicas.find((r) => r.pid === holderPid);
    const survivor = harness.replicas.find((r) => r.pid !== holderPid);
    if (!holder || !survivor) throw new Error("holder not found");
    expect(tg.maxConcurrentPollers()).toBe(1);

    await harness.kill(holder.index);
    // Pushed while no replica polls: Telegram keeps it until the next getUpdates
    tg.push(telegramPrivateMessage(ALICE, "echo:after failover"));
    await waitFor(
      async () => {
        const ports = tg.pollerPeerPorts();
        if (ports.length !== 1) return undefined;
        return (await pidOwningLocalPort(ports[0] as number, pids)) === survivor.pid || undefined;
      },
      LEASE_TTL_MS + 15_000,
      "the surviving replica polls",
      100,
    );
    const failoverReply = await waitFor(
      async () => repliesWith(ALICE.id, "after failover")[0],
      30_000,
      "reply after failover",
    );
    expect(failoverReply.chatId).toBe(ALICE.id);
    // Barrier: a later message in the same chat (same conversation) is answered after it
    tg.push(telegramPrivateMessage(ALICE, "echo:barrier after failover"));
    await waitFor(
      async () => repliesWith(ALICE.id, "barrier after failover")[0],
      30_000,
      "barrier reply after failover",
    );
    expect(repliesWith(ALICE.id, "after failover")).toHaveLength(1);
    // The takeover never overlapped the old poll, so no replica saw a 409 conflict
    expect(tg.maxConcurrentPollers()).toBe(1);
    const conn = await db
      .selectFrom("channel_connections")
      .select("last_error")
      .where("id", "=", connId)
      .executeTakeFirstOrThrow();
    expect(conn.last_error).toBe(null);
  }, 240_000);
});
