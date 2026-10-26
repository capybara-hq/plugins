import { fileURLToPath } from "node:url";
import {
  cardRecorded,
  createDb,
  createDualReplicaHarness,
  createLocalAccount,
  type FakeChannelServer,
  type FakeSlackMessage,
  type FakeSlackServer,
  fakeExtensionEntry,
  findSlackButton,
  type Harness,
  type KernelDb,
  kernelDb,
  TEST_PASSWORD as PW,
  slackBlockAction,
  slackDmEvent,
  slackMentionEvent,
  sleep,
  startFakeChannelServer,
  startFakeSlack,
  startTestPostgres,
  startTestRedis,
  type TestContainer,
  waitFor,
} from "@capybara-hq/testing";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

/** The plugin's directory: extensions named by package resolve from here. */
const PLUGIN_DIR = fileURLToPath(new URL("../../", import.meta.url));
/** The scripted model provider (a devDependency) that drives the agent runs. */
const MODEL_FAKE = "@capybara-hq/plugin-model-fake";

/**
 * 官方 Slack 插件（`plugins/slack`，按路径加载，内核不依赖插件包）接内核的双副本验收：插件连假 Slack
 * （Web API + Socket Mode WebSocket），走一遍：
 *  1. 建 Slack 渠道连接（verify = auth.test：租户 = team id）；只有一个副本连上 Socket Mode；
 *  2. 未绑定的人私聊 → Block Kit 绑定卡片（链接按钮）→ 网页上确认绑定；
 *  3. 私聊流式回复：chat.postMessage 发草稿、chat.update 更新、以完整文本定稿；
 *  4. 频道里 @ 机器人调用写工具 → 话题里的审批卡片（按钮）→ 点「批准一次」→ 卡片经 chat.update 变为已批准、
 *     按钮移除，续跑后最终回复投到同一话题；
 *  5. 每个推送的信封都被确认（内核收下后才 ack）。
 * 写工具来自 fake-im 测试插件（默认策略 ask）。
 */

const SLACK = fileURLToPath(new URL("../../src/index.ts", import.meta.url));
const FAKE_IM = fakeExtensionEntry("fake-im");
const PUBLIC = "https://cap.example";
const LONG =
  "Streaming replies reach Slack as a draft that keeps growing until it is final. ".repeat(2);

let pgc: TestContainer;
let rdc: TestContainer;
let slack: FakeSlackServer;
let im: FakeChannelServer;
let h: Harness | undefined;
const cleanups: (() => Promise<unknown> | unknown)[] = [];

beforeAll(async () => {
  [pgc, rdc] = await Promise.all([startTestPostgres(), startTestRedis()]);
  slack = await startFakeSlack({ teamId: "T1", botUserId: "UBOT" });
  im = await startFakeChannelServer();
}, 120_000);

afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
  await h?.stop();
  h = undefined;
});

afterAll(async () => {
  await Promise.all([slack?.stop(), im?.stop()]);
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
const blocksText = (m: FakeSlackMessage) => JSON.stringify(slack.finalBlocks(m) ?? []);

describe("Slack 插件接内核（双副本）", () => {
  it("建连接 → 绑定卡片 → 流式回复 → 话题里的审批卡片 → 点击批准 → 卡片更新与最终回复", async () => {
    h = await createDualReplicaHarness({
      resolveFrom: PLUGIN_DIR,
      extensions: [MODEL_FAKE, FAKE_IM, SLACK],
      pgUrl: pgc.url,
      redisUrl: rdc.url,
      extensionConfig: {
        "fake-im": {
          platformUrl: im.url,
          tenant: "t1",
          clientId: "cli_login",
          clientSecret: "login-secret-5f6e7d",
        },
        slack: { apiUrl: slack.apiUrl },
      },
      config: {
        auth: { cookieSecure: false },
        http: { publicUrl: PUBLIC },
        channels: { leaseTtlMs: 3000, scanIntervalMs: 300 },
        runtime: { jobLockMs: 2000, stalledIntervalMs: 1000 },
      },
    });
    const harness = h;
    const raw = createDb(harness.dbUrl, 3);
    cleanups.push(() => raw.destroy());
    const db: KernelDb = kernelDb(raw);

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

    // ================= 1. 启用插件、建 agent 与 Slack 渠道连接 =================
    const book = im.book("acme-slack");
    for (const [plugin, body] of [
      ["fake-im", { enabled: true, config: { url: book.url } }],
      ["slack", { enabled: true }],
    ] as const) {
      const en = await call(ownerJar, "PUT", `${base}/extensions/${plugin}`, body);
      expect(en.status, JSON.stringify(en.json)).toBe(200);
    }
    const ag = await call(ownerJar, "POST", `${base}/agents`, {
      definition: {
        name: "Helper",
        instructions: "Be helpful.",
        model: { provider: "model-fake", model: "fake-1" },
        tools: [{ kind: "plugin", plugin: "fake-im", name: "post_announcement" }],
      },
      visibility: "org",
    });
    expect(ag.status, JSON.stringify(ag.json)).toBe(201);
    const ch = await call(ownerJar, "POST", `${base}/channels`, {
      plugin: "slack",
      name: "Acme Slack",
      agentId: (ag.json.agent as { id: string }).id,
      config: { appToken: slack.appToken, botToken: slack.botToken },
    });
    expect(ch.status, JSON.stringify(ch.json)).toBe(201);
    expect(ch.json.channel).toMatchObject({ plugin: "slack", tenantId: "T1", botUserId: "UBOT" });
    expect(JSON.stringify(ch.json)).not.toContain(slack.botToken);
    await waitFor(async () => slack.openSockets() === 1 || undefined, 15_000, "socket mode");
    await sleep(1000);
    expect(slack.maxConcurrentSockets()).toBe(1);

    slack.users.set("UALICE", {
      id: "UALICE",
      teamId: "T1",
      name: "alice",
      realName: "Alice",
      displayName: "Alice",
    });
    const pushed: string[] = [];
    const push = (env: string) => {
      pushed.push(env);
      return env;
    };
    const postedTo = (channel: string) => slack.messages.filter((m) => m.channel === channel);

    // ================= 2. 未绑定 → 绑定卡片（Block Kit 链接按钮）→ 网页确认 =================
    await slack.waitForAck(push(slack.pushEvent(slackDmEvent("UALICE", "hello", { ts: "100.1" }))));
    const bindMsg = await waitFor(async () => postedTo("DUALICE")[0], 15_000, "bind card");
    expect(bindMsg.text).toBe("Please link your Capybara account before chatting with me.");
    const bindBtn = findSlackButton(bindMsg.blocks, (b) => b.url !== undefined);
    expect(bindBtn?.url?.startsWith(`${PUBLIC}/bind/cap_bind_`)).toBe(true);
    const token = (bindBtn?.url ?? "").slice(`${PUBLIC}/bind/`.length);
    expect((await call(aliceJar, "POST", `/api/v1/bind/${token}`)).status).toBe(200);
    const identity = await db
      .selectFrom("identities")
      .select(["account_id", "source"])
      .where("external_id", "=", "UALICE")
      .executeTakeFirstOrThrow();
    expect(identity).toEqual({ account_id: aliceId, source: "slack:T1" });

    // ================= 3. 私聊流式回复：postMessage 草稿 → chat.update → 定稿 =================
    const before = postedTo("DUALICE").length;
    await slack.waitForAck(
      push(slack.pushEvent(slackDmEvent("UALICE", `slow:120:${LONG}`, { ts: "100.2" }))),
    );
    const draft = await waitFor(
      async () => postedTo("DUALICE").slice(before)[0],
      20_000,
      "draft message",
    );
    expect(draft.text.length).toBeLessThan(LONG.length);
    // 模型回复原样转换为 mrkdwn（这段文本没有需要转换的格式）；插件去 @ 时会去掉入站文本首尾的空白，
    // 所以 model-fake 回显的文本没有末尾空格
    await waitFor(
      async () => slack.finalText(draft) === LONG.trimEnd() || undefined,
      30_000,
      "final text",
    );
    expect(slack.updates.filter((u) => u.ts === draft.ts).length).toBeGreaterThanOrEqual(1);
    await sleep(500);
    expect(postedTo("DUALICE").slice(before)).toHaveLength(1);

    // ================= 4. 频道里 @ 机器人 → 话题里的审批卡片 → 点击批准 =================
    const tool = 'tool:fake-im__post_announcement:{"text":"Office closed on Friday"}';
    await slack.waitForAck(
      push(
        slack.pushEvent(
          slackMentionEvent("UALICE", "UBOT", tool, { channel: "COPS", ts: "200.1" }),
        ),
      ),
    );
    const cardMsg = await waitFor(
      async () =>
        postedTo("COPS").find((m) =>
          findSlackButton(m.blocks, (b) => b.action_id === "cap_a_once"),
        ),
      20_000,
      "approval card",
    );
    expect(cardMsg.threadTs).toBe("200.1");
    expect(blocksText(cardMsg)).toContain("post_announcement");
    expect(blocksText(cardMsg)).toContain("Office closed on Friday");
    expect(im.posts).toEqual([]);

    const approve = findSlackButton(cardMsg.blocks, (b) => b.action_id === "cap_a_once");
    if (!approve) throw new Error("no approve button");
    await cardRecorded(db, { kind: "approval" });
    await slack.waitForAck(
      push(
        slack.pushInteractive(
          slackBlockAction({ id: "UALICE", teamId: "T1", name: "alice" }, cardMsg, approve),
        ),
      ),
    );
    await waitFor(
      async () => blocksText(cardMsg).includes("Approved") || undefined,
      20_000,
      "card updated to approved",
    );
    expect(
      findSlackButton(slack.finalBlocks(cardMsg), (b) => b.action_id.startsWith("cap_a_")),
    ).toBe(undefined);
    const finalReply = await waitFor(
      async () =>
        postedTo("COPS").find(
          (m) => slack.finalText(m) === "Tool result: Announcement posted (post_1).",
        ),
      20_000,
      "final reply in the thread",
    );
    expect(finalReply.threadTs).toBe("200.1");
    expect(im.posts).toHaveLength(1);

    // ================= 5. 每个信封都已确认 =================
    for (const env of pushed) expect(slack.acked(env), env).toBe(true);
    expect(slack.maxConcurrentSockets()).toBe(1);
  }, 180_000);
});
