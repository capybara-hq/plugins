import { fileURLToPath } from "node:url";
import {
  cardRecorded,
  createDb,
  createDualReplicaHarness,
  createLocalAccount,
  eventsOf,
  type FakeChannelServer,
  type FakeSlackMessage,
  type FakeSlackServer,
  fakeExtensionEntry,
  findSlackButton,
  type Harness,
  type KernelDb,
  kernelDb,
  TEST_PASSWORD as PW,
  pidOwningLocalPort,
  replicaOf,
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
 * M4 第二段验收（双副本，假 Slack）：官方 Slack 插件（`plugins/slack`，按源码路径加载）的三种能力接内核，
 * 按第一段验收（`m4-segment1.dual.test.ts`）的流程走完一遍：
 *
 *  1. 建 Slack 渠道连接（只有一个副本连上 Socket Mode）；首轮通讯录同步（`users.list`）把 bob 加进组织
 *  2. 未绑定的 alice 私聊 → Block Kit 绑定卡片
 *  3. alice 登录网页，`POST /api/v1/bind/:token` 绑定（查看与确认落在不同副本）
 *  4. 私聊：chat.postMessage 发草稿、chat.update 流式更新、以完整文本定稿
 *  5. 频道里 @ 机器人调用写工具（fake-im 的 post_announcement，默认策略 ask）→ 话题里的审批卡片
 *  6. 非审批人 bob 点「批准一次」→ 被拒并在话题里收到说明，审批仍 pending、工具未执行、卡片未改
 *  7. 发起人 alice 点批准 → 卡片经 chat.update 变为已批准、按钮移除，续跑后最终回复投到同一话题
 *  8. SIGKILL 持有 Socket Mode 连接的副本（按对端端口查出进程）→ 另一副本接管；Slack 重投旧消息不重复处理，
 *     新消息（也重投一次）只回复一次
 *  9. Sign in with Slack：alice 的身份经绑定链接建立，未登录时不能直接登录（Ruling A18），登录状态下完成一次后升级；
 *     carol 得到新账号（身份 `slack:T1` + UCAROL）
 * 10. 平台推 `team_join` → 通讯录同步把 carol 加入组织（同一账号）；carol 在 Slack 被停用（`deleted`）→ 手动同步
 *     离职处理：成员关系删除、会话吊销、IM 里不再被当作成员
 *
 * Slack 的 chat.postMessage 没有幂等参数，假 Slack 也不去重：最后断言没有任何两次内容相同的发送（内核自己没有重发），
 * 且每个推送的信封都被确认。
 */

const SLACK = fileURLToPath(new URL("../../src/index.ts", import.meta.url));
const FAKE_IM = fakeExtensionEntry("fake-im");
const PUBLIC = "https://cap.example";
const SOURCE = "slack:T1";
const LEASE_TTL_MS = 3000;
const LOGIN_SECRET = "slack-login-secret-7c1d";
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
  slack = await startFakeSlack({
    teamId: "T1",
    botUserId: "UBOT",
    clientId: "cli-slack-login",
    clientSecret: LOGIN_SECRET,
  });
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

describe("M4 第二段验收：Slack（双副本）", () => {
  it("渠道 → 绑定 → 流式对话 → 审批卡片 → 杀副本接管 → Sign in with Slack → 通讯录加入与离职", async () => {
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
        slack: {
          apiUrl: slack.apiUrl,
          openidUrl: `${slack.url}/`,
          clientId: "cli-slack-login",
          clientSecret: LOGIN_SECRET,
        },
      },
      config: {
        auth: { cookieSecure: false, loginSources: ["slack"] },
        http: { publicUrl: PUBLIC },
        channels: { leaseTtlMs: LEASE_TTL_MS, scanIntervalMs: 300 },
        runtime: { jobLockMs: 2000, stalledIntervalMs: 1000 },
      },
    });
    const harness = h;
    const raw = createDb(harness.dbUrl, 3);
    cleanups.push(() => raw.destroy());
    const db: KernelDb = kernelDb(raw);

    // ---- HTTP：杀副本前严格交替发往两个副本；之后只发往幸存的副本 ----
    let dead: number | undefined;
    const send = async (path: string, init: RequestInit) => {
      if (dead === undefined) return harness.request(path, init);
      const r = harness.replicas[dead === 0 ? 1 : 0];
      const res = await fetch(`http://127.0.0.1:${r.port}${path}`, init);
      expect(replicaOf(res)).toBe(r.index);
      return Object.assign(res, { replica: r.index });
    };
    const call = async (jar: Jar, method: string, path: string, body?: unknown) => {
      const res = await send(path, {
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
      return {
        status: res.status,
        replica: res.replica,
        location: res.headers.get("location") ?? "",
        json: (isJson ? JSON.parse(text) : {}) as Json,
      };
    };

    const ownerJar: Jar = new Map();
    const aliceJar: Jar = new Map();
    await createLocalAccount(db, "owner", "O");
    expect(
      (await call(ownerJar, "POST", "/api/v1/auth/login", { login: "owner", password: PW })).status,
    ).toBe(200);
    const org = await call(ownerJar, "POST", "/api/v1/orgs", { name: "Acme" });
    expect(org.status).toBe(201);
    const orgId = (org.json.org as { id: string }).id;
    const base = `/api/v1/orgs/${orgId}`;
    const inv = await call(ownerJar, "POST", `${base}/invitations`, { role: "member" });
    expect(inv.status).toBe(201);
    const accepted = await call(aliceJar, "POST", `/api/v1/invitations/${inv.json.token}/accept`, {
      login: "alice",
      password: PW,
      displayName: "Alice",
    });
    expect(accepted.status, JSON.stringify(accepted.json)).toBe(200);
    const aliceId = (accepted.json.account as { id: string }).id;

    const membership = (accountId: string) =>
      db
        .selectFrom("memberships")
        .select(["role", "source"])
        .where("org_id", "=", orgId)
        .where("account_id", "=", accountId)
        .executeTakeFirst();
    const identityOwner = async (externalId: string) =>
      (
        await db
          .selectFrom("identities")
          .select("account_id")
          .where("source", "=", SOURCE)
          .where("external_id", "=", externalId)
          .executeTakeFirst()
      )?.account_id;
    const syncAudits = () =>
      db
        .selectFrom("audit_events")
        .select("detail")
        .where("org_id", "=", orgId)
        .where("action", "=", "org.directory.synced")
        .orderBy("id")
        .execute();

    // ================= 1. 启用插件、首轮通讯录同步、建 Slack 渠道连接 =================
    slack.users.set("UBOB", { id: "UBOB", teamId: "T1", name: "bob", realName: "Bob" });
    const book = im.book("acme-slack-seg2");
    for (const [plugin, body] of [
      ["fake-im", { enabled: true, config: { url: book.url } }],
      ["slack", { enabled: true, config: { teamId: "T1", botToken: slack.botToken } }],
    ] as const) {
      const en = await call(ownerJar, "PUT", `${base}/extensions/${plugin}`, body);
      expect(en.status, JSON.stringify(en.json)).toBe(200);
    }
    const sync1 = await call(ownerJar, "POST", `${base}/extensions/slack/directory/sync`);
    expect(sync1.status).toBe(202);
    await waitFor(async () => (await syncAudits()).length === 1, 20_000, "first directory sync");
    expect((await syncAudits())[0]?.detail).toMatchObject({ added: 1, partial: false });
    const bobId = await waitFor(async () => identityOwner("UBOB"), 15_000, "bob's account");
    expect(await membership(bobId)).toEqual({ role: "member", source: "directory:slack" });
    // alice 在 Slack 上（资料可查、可登录），首轮同步之后才出现在工作区里
    slack.users.set("UALICE", {
      id: "UALICE",
      teamId: "T1",
      name: "alice",
      realName: "Alice",
      displayName: "Alice",
    });

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
    const agentId = (ag.json.agent as { id: string }).id;
    const ch = await call(ownerJar, "POST", `${base}/channels`, {
      plugin: "slack",
      name: "Acme Slack",
      agentId,
      config: { appToken: slack.appToken, botToken: slack.botToken },
    });
    expect(ch.status, JSON.stringify(ch.json)).toBe(201);
    const channel = ch.json.channel as Json;
    expect(channel).toMatchObject({ plugin: "slack", tenantId: "T1", botUserId: "UBOT" });
    expect(JSON.stringify(ch.json)).not.toContain(slack.botToken);
    expect(JSON.stringify(ch.json)).not.toContain(slack.appToken);
    const connId = channel.id as string;
    await waitFor(async () => slack.openSockets() === 1 || undefined, 15_000, "socket mode");
    await sleep(1000);
    expect(slack.openSockets()).toBe(1);
    expect(slack.maxConcurrentSockets()).toBe(1);

    const pushed: string[] = [];
    const push = (env: string) => {
      pushed.push(env);
      return env;
    };
    const postedTo = (chan: string) => slack.messages.filter((m) => m.channel === chan);
    const threadConv = async (chatId: string) =>
      (
        await db
          .selectFrom("channel_threads")
          .select("conversation_id")
          .where("connection_id", "=", connId)
          .where("chat_id", "=", chatId)
          .where("archived_at", "is", null)
          .executeTakeFirst()
      )?.conversation_id;
    const userMsgIds = async (conv: string) =>
      (await eventsOf(db, conv))
        .filter((e) => e.type === "user_message")
        .map((e) => (e.payload as { clientMessageId?: string }).clientMessageId);

    // ================= 2. 未绑定的 alice 私聊 → 绑定卡片 =================
    await slack.waitForAck(push(slack.pushEvent(slackDmEvent("UALICE", "hello", { ts: "100.1" }))));
    const bindMsg = await waitFor(async () => postedTo("DUALICE")[0], 15_000, "bind card");
    expect(bindMsg.text).toBe("Please link your Capybara account before chatting with me.");
    const bindBtn = findSlackButton(bindMsg.blocks, (b) => b.url !== undefined);
    expect(bindBtn?.url?.startsWith(`${PUBLIC}/bind/cap_bind_`)).toBe(true);
    const token = (bindBtn?.url ?? "").slice(`${PUBLIC}/bind/`.length);
    expect(await threadConv("DUALICE")).toBeUndefined();

    // ================= 3. 网页上确认绑定（查看与确认落在不同副本） =================
    const peek = await call(aliceJar, "GET", `/api/v1/bind/${token}`);
    expect(peek.status).toBe(200);
    expect(peek.json.binding).toMatchObject({
      connectionId: connId,
      source: SOURCE,
      externalId: "UALICE",
    });
    const bound = await call(aliceJar, "POST", `/api/v1/bind/${token}`);
    expect(bound.status).toBe(200);
    expect(bound.replica).not.toBe(peek.replica);
    expect(await identityOwner("UALICE")).toBe(aliceId);
    expect((await call(aliceJar, "POST", `/api/v1/bind/${token}`)).status).toBe(404);

    // ================= 4. 私聊：草稿 → chat.update 流式更新 → 定稿 =================
    const dmBefore = postedTo("DUALICE").length;
    await slack.waitForAck(
      push(slack.pushEvent(slackDmEvent("UALICE", `slow:120:${LONG}`, { ts: "100.2" }))),
    );
    const draft = await waitFor(
      async () => postedTo("DUALICE").slice(dmBefore)[0],
      20_000,
      "draft message",
    );
    expect(draft.text.length).toBeLessThan(LONG.length);
    // 插件去 @ 时去掉入站文本首尾的空白，所以 model-fake 回显的文本没有末尾空格
    await waitFor(
      async () => slack.finalText(draft) === LONG.trimEnd() || undefined,
      30_000,
      "draft finalized with the full text",
    );
    const updates = slack.updates.filter((u) => u.channel === "DUALICE" && u.ts === draft.ts);
    expect(updates.length).toBeGreaterThanOrEqual(1);
    for (const u of updates) expect(LONG.startsWith(u.text.replace(/\s+$/, ""))).toBe(true);
    const dmConv = (await threadConv("DUALICE")) as string;
    expect(
      await db
        .selectFrom("conversations")
        .select(["account_id", "agent_id"])
        .where("id", "=", dmConv)
        .executeTakeFirstOrThrow(),
    ).toEqual({ account_id: aliceId, agent_id: agentId });
    await sleep(500);
    expect(postedTo("DUALICE").slice(dmBefore)).toHaveLength(1);

    // ================= 5. 频道里 @ 机器人调用写工具 → 话题里的审批卡片 =================
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
    const approvalRow = await waitFor(
      async () =>
        db
          .selectFrom("approvals")
          .select(["id", "status", "requested_for", "decided_by"])
          .where("org_id", "=", orgId)
          .executeTakeFirst(),
      20_000,
      "approval row",
    );
    expect(approvalRow).toMatchObject({ status: "pending", requested_for: aliceId });
    const approval = () =>
      db
        .selectFrom("approvals")
        .select(["status", "decided_by"])
        .where("id", "=", approvalRow.id)
        .executeTakeFirstOrThrow();
    expect(im.posts).toEqual([]);
    const approve = findSlackButton(cardMsg.blocks, (b) => b.action_id === "cap_a_once");
    if (!approve) throw new Error("no approve button");
    await cardRecorded(db, { kind: "approval" });

    // ================= 6. 非审批人 bob 点批准 → 被拒并说明 =================
    const beforeBob = postedTo("COPS").length;
    await slack.waitForAck(
      push(
        slack.pushInteractive(
          slackBlockAction({ id: "UBOB", teamId: "T1", name: "bob" }, cardMsg, approve),
        ),
      ),
    );
    const refusal = await waitFor(
      async () => postedTo("COPS").slice(beforeBob)[0],
      15_000,
      "refusal",
    );
    expect(refusal.text).toBe("You can't handle this request.");
    expect(refusal.threadTs).toBe("200.1");
    await sleep(500);
    expect(await approval()).toEqual({ status: "pending", decided_by: null });
    expect(im.posts).toEqual([]);
    expect(slack.updates.filter((u) => u.channel === "COPS" && u.ts === cardMsg.ts)).toEqual([]);

    // ================= 7. 发起人 alice 批准 → 卡片更新、续跑完成、最终回复投到话题 =================
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
    expect(await approval()).toEqual({ status: "approved", decided_by: aliceId });
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
    expect(im.posts[0]?.body).toMatchObject({ text: "Office closed on Friday" });
    const grpConv = (await threadConv("COPS")) as string;
    await waitFor(
      async () => (await eventsOf(db, grpConv)).some((e) => e.type === "run_finished"),
      20_000,
      "run completed",
    );

    // ================= 8. 杀掉持有 Socket Mode 连接的副本 → 另一副本接管，消息不重复 =================
    const pids = harness.replicas.map((r) => r.pid);
    const holderPort = slack.socketPeerPorts()[0];
    if (holderPort === undefined) throw new Error("no open Socket Mode connection");
    const holderPid = await pidOwningLocalPort(holderPort, pids);
    const holder = harness.replicas.find((r) => r.pid === holderPid);
    const survivor = harness.replicas.find((r) => r.pid !== holderPid);
    if (!holder || !survivor) {
      throw new Error(
        `cannot identify the replica holding the connection (platform ${process.platform}, ` +
          `client port ${holderPort}, replica pids ${pids.join(",")})`,
      );
    }
    const killedAt = Date.now();
    await harness.kill(holder.index);
    dead = holder.index;
    const takeoverPort = await waitFor(
      async () => {
        const port = slack.socketPeerPorts()[0];
        if (port === undefined || port === holderPort) return undefined;
        return (await pidOwningLocalPort(port, pids)) === survivor.pid ? port : undefined;
      },
      LEASE_TTL_MS + 15_000,
      "takeover by the surviving replica",
      100,
    );
    expect(takeoverPort).not.toBe(holderPort);
    expect(Date.now() - killedAt).toBeGreaterThanOrEqual(LEASE_TTL_MS - 1000);
    expect(slack.openSockets()).toBe(1);
    expect(slack.maxConcurrentSockets()).toBe(1);

    // Slack 重投接管前已处理过的消息；再投一条新消息（也重投一次）
    const dmSent = postedTo("DUALICE").length;
    await slack.waitForAck(
      push(slack.pushEvent(slackDmEvent("UALICE", `slow:120:${LONG}`, { ts: "100.2" }))),
    );
    for (let i = 0; i < 2; i++) {
      await slack.waitForAck(
        push(slack.pushEvent(slackDmEvent("UALICE", "echo:after takeover", { ts: "100.3" }))),
      );
    }
    await waitFor(
      async () => postedTo("DUALICE").find((m) => slack.finalText(m) === "after takeover"),
      20_000,
      "reply after takeover",
    );
    await sleep(1000);
    expect(postedTo("DUALICE").slice(dmSent)).toHaveLength(1);
    expect(await userMsgIds(dmConv)).toEqual([
      `${connId}:DUALICE:100.2`,
      `${connId}:DUALICE:100.3`,
    ]);

    // ================= 9. Sign in with Slack =================
    slack.users.set("UCAROL", {
      id: "UCAROL",
      teamId: "T1",
      name: "carol",
      realName: "Carol",
      email: "carol@corp.example",
      emailVerified: true,
    });
    /** 走一次 Sign in with Slack 到回调；返回回调的 302 目标。 */
    const ssoTo = async (userId: string, jar: Jar) => {
      const start = await call(jar, "GET", "/api/v1/auth/sso/slack/start?returnTo=%2Fchat");
      expect(start.status).toBe(302);
      const authz = new URL(start.location);
      expect(authz.origin + authz.pathname).toBe(`${slack.url}/openid/connect/authorize`);
      expect(authz.searchParams.get("client_id")).toBe("cli-slack-login");
      expect(authz.searchParams.get("scope")).toBe("openid email profile");
      expect(jar.has("cap_sso")).toBe(true);
      const back = await fetch(`${start.location}&as=${userId}`, { redirect: "manual" });
      expect(back.status).toBe(302);
      const cbUrl = new URL(back.headers.get("location") ?? "");
      expect(cbUrl.origin + cbUrl.pathname).toBe(`${PUBLIC}/api/v1/auth/sso/slack/callback`);
      const cb = await call(jar, "GET", cbUrl.pathname + cbUrl.search);
      expect(cb.status).toBe(302);
      expect(jar.has("cap_sso")).toBe(false);
      return cb.location;
    };
    const sso = async (userId: string, jar: Jar = new Map()) => {
      expect(await ssoTo(userId, jar)).toBe(`${PUBLIC}/chat`);
      const me = await call(jar, "GET", "/api/v1/me");
      expect(me.status).toBe(200);
      expect(JSON.stringify(me.json)).not.toContain(LOGIN_SECRET);
      return { jar, accountId: (me.json.account as { id: string }).id };
    };
    const anon: Jar = new Map();
    expect(await ssoTo("UALICE", anon)).toBe(`${PUBLIC}/login?error=sso.identity_not_verified`);
    expect(anon.has("cap_at")).toBe(false);
    expect((await sso("UALICE", aliceJar)).accountId).toBe(aliceId);
    expect((await sso("UALICE")).accountId).toBe(aliceId);
    const carol = await sso("UCAROL");
    expect(carol.accountId).not.toBe(aliceId);
    expect(await identityOwner("UCAROL")).toBe(carol.accountId);
    expect(await membership(carol.accountId)).toBeUndefined();

    // ================= 10. team_join → 同步加入；Slack 停用 carol → 离职处理 =================
    await slack.waitForAck(
      push(slack.pushEvent({ type: "team_join", user: { id: "UCAROL", team_id: "T1" } })),
    );
    await waitFor(async () => (await syncAudits()).length === 2, 20_000, "sync on team_join");
    expect((await syncAudits())[1]?.detail).toMatchObject({
      trigger: "changed",
      added: 1,
      removed: 0,
      partial: false,
    });
    expect(await membership(carol.accountId)).toEqual({
      role: "member",
      source: "directory:slack",
    });
    // 同一个身份行（登录、通讯录、渠道三处同键）
    expect(
      await db
        .selectFrom("identities")
        .select(["account_id", "source"])
        .where("external_id", "=", "UCAROL")
        .execute(),
    ).toEqual([{ account_id: carol.accountId, source: SOURCE }]);
    await slack.waitForAck(
      push(slack.pushEvent(slackDmEvent("UCAROL", "echo:hello from carol", { ts: "300.1" }))),
    );
    await waitFor(
      async () => postedTo("DUCAROL").find((m) => slack.finalText(m) === "hello from carol"),
      20_000,
      "carol chats as a member",
    );

    const carolUser = slack.users.get("UCAROL");
    if (!carolUser) throw new Error("carol is not a Slack user");
    slack.users.set("UCAROL", { ...carolUser, deleted: true });
    const sync3 = await call(ownerJar, "POST", `${base}/extensions/slack/directory/sync`);
    expect(sync3.status).toBe(202);
    await waitFor(async () => (await syncAudits()).length === 3, 20_000, "sync after removal");
    expect((await syncAudits())[2]?.detail).toMatchObject({
      trigger: "manual",
      added: 0,
      removed: 1,
      partial: false,
    });
    expect(await membership(carol.accountId)).toBeUndefined();
    expect(await membership(bobId)).toEqual({ role: "member", source: "directory:slack" });
    expect(await membership(aliceId)).toMatchObject({ role: "member" });
    expect((await call(carol.jar, "GET", "/api/v1/me")).status).toBe(401);
    const offboarded = await db
      .selectFrom("audit_events")
      .select(["target", "detail"])
      .where("org_id", "=", orgId)
      .where("action", "=", "org.member.offboarded")
      .execute();
    expect(offboarded).toHaveLength(1);
    expect(offboarded[0]?.target).toBe(carol.accountId);
    expect(offboarded[0]?.detail).toMatchObject({ reason: "directory" });
    const carolBefore = postedTo("DUCAROL").length;
    await slack.waitForAck(
      push(slack.pushEvent(slackDmEvent("UCAROL", "echo:still here?", { ts: "300.2" }))),
    );
    const notMember = await waitFor(
      async () => postedTo("DUCAROL").slice(carolBefore)[0],
      15_000,
      "not-a-member reply",
    );
    expect(notMember.text).toMatch(/not a member/);
    expect(await threadConv("DUCAROL")).toBeUndefined();

    // ---- 全程：每个信封都已确认；只有一条长连接；没有任何内容相同的重复发送 ----
    for (const env of pushed) expect(slack.acked(env), env).toBe(true);
    expect(slack.maxConcurrentSockets()).toBe(1);
    const sends = slack.calls
      .filter((c) => c.method === "chat.postMessage")
      .map((c) =>
        JSON.stringify([c.body.channel, c.body.thread_ts, c.body.text, c.body.blocks ?? null]),
      );
    expect(sends.length).toBe(slack.messages.length);
    expect(sends.filter((s, i) => sends.indexOf(s) !== i)).toEqual([]);
  }, 300_000);
});
