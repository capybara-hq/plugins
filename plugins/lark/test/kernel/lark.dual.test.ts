import { fileURLToPath } from "node:url";
import {
  createDualReplicaHarness,
  type FakeChannelServer,
  type FakeLarkMessage,
  type FakeLarkServer,
  findLarkButton,
  type Harness,
  larkCardAction,
  larkMessageEvent,
  startFakeChannelServer,
  startFakeLark,
  startTestPostgres,
  startTestRedis,
  type TestContainer,
} from "@capybara-hq/testing";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { type KernelDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { AccountsService } from "../../src/identity/accounts.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import { cardRecorded, PW, sleep, waitFor } from "../helpers/runs.js";

/**
 * 官方 Lark 插件（`plugins/lark`，按路径加载，内核不依赖插件包）接内核的双副本验收：插件连假 Lark
 * （OpenAPI + 按 SDK protobuf 帧格式实现的长连接，插件用的是真实的 SDK `WSClient`），走一遍：
 *  1. 建 Lark 渠道连接（verify：租户 = tenant_key，机器人 = bot open_id）；只有一个副本连上长连接；
 *  2. 未绑定的人私聊 → 绑定卡片（链接按钮）→ 网页上确认绑定（身份源键 `lark:<tenant_key>`）；
 *  3. 私聊流式回复：发卡片草稿、PATCH 更新、以完整文本定稿；
 *  4. 群里 @ 机器人调用写工具 → 话题里的审批卡片（回复以 @ 消息为根、reply_in_thread）→ 点「批准一次」→
 *     卡片经 PATCH 变为已批准、按钮移除，续跑后最终回复投到同一话题；
 *  5. 每个推送的事件都被确认（code 200，内核收下后才确认）。
 * 写工具来自 fake-im 测试插件（默认策略 ask）。
 */

const LARK = fileURLToPath(new URL("../../../../plugins/lark/src/index.ts", import.meta.url));
const FAKE_IM = fileURLToPath(new URL("../fixtures/plugins/fake-im/index.ts", import.meta.url));
const PUBLIC = "https://cap.example";
const LONG = "Streaming replies reach Lark as a card that keeps growing until it is final. ".repeat(
  2,
);

let pgc: TestContainer;
let rdc: TestContainer;
let lark: FakeLarkServer;
let im: FakeChannelServer;
let h: Harness | undefined;
const cleanups: (() => Promise<unknown> | unknown)[] = [];

beforeAll(async () => {
  [pgc, rdc] = await Promise.all([startTestPostgres(), startTestRedis()]);
  lark = await startFakeLark({ tenantKey: "t1", botOpenId: "ou_bot", botName: "Capybara" });
  im = await startFakeChannelServer();
}, 120_000);

afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
  await h?.stop();
  h = undefined;
});

afterAll(async () => {
  await Promise.all([lark?.stop(), im?.stop()]);
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
const finalText = (m: FakeLarkMessage) => lark.cardText(lark.finalCard(m));

describe("Lark 插件接内核（双副本）", () => {
  it("建连接 → 绑定卡片 → 流式回复 → 话题里的审批卡片 → 点击批准 → 卡片更新与最终回复", async () => {
    h = await createDualReplicaHarness({
      plugins: [MODEL_FAKE, FAKE_IM, LARK],
      pgUrl: pgc.url,
      redisUrl: rdc.url,
      pluginConfig: {
        "fake-im": {
          platformUrl: im.url,
          tenant: "t1",
          clientId: "cli_login",
          clientSecret: "login-secret-5f6e7d",
        },
        lark: { apiUrl: lark.url },
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
    await new AccountsService(db).createLocal({ login: "owner", password: PW, displayName: "O" });
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

    // ================= 1. 启用插件、建 agent 与 Lark 渠道连接 =================
    const book = im.book("acme-lark");
    for (const [plugin, body] of [
      ["fake-im", { enabled: true, config: { url: book.url } }],
      ["lark", { enabled: true }],
    ] as const) {
      const en = await call(ownerJar, "PUT", `${base}/plugins/${plugin}`, body);
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
      plugin: "lark",
      name: "Acme Lark",
      agentId: (ag.json.agent as { id: string }).id,
      config: { appId: lark.appId, appSecret: lark.appSecret },
    });
    expect(ch.status, JSON.stringify(ch.json)).toBe(201);
    expect(ch.json.channel).toMatchObject({ plugin: "lark", tenantId: "t1", botUserId: "ou_bot" });
    expect(JSON.stringify(ch.json)).not.toContain(lark.appSecret);
    await waitFor(async () => lark.openSockets() === 1 || undefined, 15_000, "long connection");
    await sleep(1000);
    expect(lark.maxConcurrentSockets()).toBe(1);

    lark.users.set("ou_alice", { openId: "ou_alice", name: "Alice" });
    const pushed: string[] = [];
    const push = (id: string) => {
      pushed.push(id);
      return id;
    };
    const postedTo = (chat: string) => lark.messages.filter((m) => m.chatId === chat);
    const dm = (text: string, messageId: string) =>
      larkMessageEvent({
        openId: "ou_alice",
        chatId: "oc_dm_alice",
        chatType: "p2p",
        text,
        messageId,
      });

    // ================= 2. 未绑定 → 绑定卡片（链接按钮）→ 网页确认 =================
    await lark.waitForAck(push(lark.pushEvent(dm("hello", "om_dm_1"))));
    const bindMsg = await waitFor(async () => postedTo("oc_dm_alice")[0], 15_000, "bind card");
    expect(finalText(bindMsg)).toContain(
      "Please link your Capybara account before chatting with me.",
    );
    const bindBtn = findLarkButton(bindMsg.card, (b) => b.url !== undefined);
    expect(bindBtn?.url?.startsWith(`${PUBLIC}/bind/cap_bind_`)).toBe(true);
    const token = (bindBtn?.url ?? "").slice(`${PUBLIC}/bind/`.length);
    expect((await call(aliceJar, "POST", `/api/v1/bind/${token}`)).status).toBe(200);
    const identity = await db
      .selectFrom("identities")
      .select(["account_id", "source"])
      .where("external_id", "=", "ou_alice")
      .executeTakeFirstOrThrow();
    expect(identity).toEqual({ account_id: aliceId, source: "lark:t1" });

    // ================= 3. 私聊流式回复：卡片草稿 → PATCH → 定稿 =================
    const before = postedTo("oc_dm_alice").length;
    await lark.waitForAck(push(lark.pushEvent(dm(`slow:120:${LONG}`, "om_dm_2"))));
    const draft = await waitFor(
      async () => postedTo("oc_dm_alice").slice(before)[0],
      20_000,
      "draft message",
    );
    expect(draft.msgType).toBe("interactive");
    expect(lark.cardText(draft.card).length).toBeLessThan(LONG.length);
    // 插件去 @ 时去掉入站文本首尾的空白，所以 model-fake 回显的文本没有末尾空格
    await waitFor(
      async () => finalText(draft) === LONG.trimEnd() || undefined,
      30_000,
      "final text",
    );
    expect(
      lark.updates.filter((u) => u.messageId === draft.messageId).length,
    ).toBeGreaterThanOrEqual(1);
    await sleep(500);
    expect(postedTo("oc_dm_alice").slice(before)).toHaveLength(1);

    // ================= 4. 群里 @ 机器人 → 话题里的审批卡片 → 点击批准 =================
    const tool = 'tool:fake-im__post_announcement:{"text":"Office closed on Friday"}';
    await lark.waitForAck(
      push(
        lark.pushEvent(
          larkMessageEvent({
            openId: "ou_alice",
            chatId: "oc_ops",
            chatType: "group",
            text: `@_user_1 ${tool}`,
            messageId: "om_mention_1",
            mentions: [{ key: "@_user_1", openId: "ou_bot", name: "Capybara" }],
          }),
        ),
      ),
    );
    const cardMsg = await waitFor(
      async () =>
        postedTo("oc_ops").find((m) => findLarkButton(m.card, (b) => b.text === "Approve once")),
      20_000,
      "approval card",
    );
    expect(cardMsg).toMatchObject({ rootId: "om_mention_1", replyInThread: true });
    expect(lark.cardText(cardMsg.card)).toContain("post\\_announcement");
    expect(lark.cardText(cardMsg.card)).toContain("Office closed on Friday");
    expect(im.posts).toEqual([]);

    const approve = findLarkButton(cardMsg.card, (b) => b.text === "Approve once");
    if (!approve) throw new Error("no approve button");
    await cardRecorded(db, { kind: "approval" });
    const click = await lark.waitForAck(
      push(
        lark.pushEvent(larkCardAction({ openId: "ou_alice", tenantKey: "t1" }, cardMsg, approve)),
      ),
    );
    expect(click.code).toBe(200);
    await waitFor(
      async () => finalText(cardMsg).includes("Approved") || undefined,
      20_000,
      "card updated to approved",
    );
    expect(findLarkButton(lark.finalCard(cardMsg), (b) => b.value !== undefined)).toBe(undefined);
    const finalReply = await waitFor(
      async () =>
        postedTo("oc_ops").find(
          (m) => finalText(m) === "Tool result: Announcement posted (post_1).",
        ),
      20_000,
      "final reply in the thread",
    );
    expect(finalReply).toMatchObject({ rootId: "om_mention_1", replyInThread: true });
    expect(im.posts).toHaveLength(1);

    // ================= 5. 每个事件都已确认 =================
    for (const id of pushed) {
      expect(lark.acked(id), id).toBe(true);
      expect(lark.acks.find((a) => a.id === id)?.code, id).toBe(200);
    }
    expect(lark.maxConcurrentSockets()).toBe(1);
  }, 180_000);
});
