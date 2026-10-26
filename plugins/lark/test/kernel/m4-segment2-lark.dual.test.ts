import { fileURLToPath } from "node:url";
import {
  cardRecorded,
  createDb,
  createDualReplicaHarness,
  createLocalAccount,
  eventsOf,
  type FakeChannelServer,
  type FakeLarkMessage,
  type FakeLarkServer,
  fakeExtensionEntry,
  findLarkButton,
  type Harness,
  type KernelDb,
  kernelDb,
  larkCardAction,
  larkMessageEvent,
  TEST_PASSWORD as PW,
  pidOwningLocalPort,
  replicaOf,
  sleep,
  startFakeChannelServer,
  startFakeLark,
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
 * M4 第二段验收（双副本，假 Lark）：官方 Lark 插件（`plugins/lark`，按源码路径加载；长连接跑真实 SDK `WSClient`，
 * 假 Lark 按 SDK 的 protobuf 帧收发）的三种能力接内核，按第一段验收（`m4-segment1.dual.test.ts`）的流程走完一遍：
 *
 *  1. 建 Lark 渠道连接（只有一个副本连上长连接）；首轮通讯录同步（按部门遍历）把 bob 加进组织
 *  2. 未绑定的 alice 私聊 → 绑定卡片（链接按钮）
 *  3. alice 登录网页，`POST /api/v1/bind/:token` 绑定（查看与确认落在不同副本；身份 `lark:t1` + open_id）
 *  4. 私聊：发卡片草稿、PATCH 流式更新、以完整文本定稿
 *  5. 群里 @ 机器人调用写工具（fake-im 的 post_announcement，默认策略 ask）→ 话题里的审批卡片
 *  6. 非审批人 bob 点「批准一次」→ 被拒并在话题里收到说明，审批仍 pending、工具未执行、卡片未改
 *  7. 发起人 alice 点批准 → 卡片经 PATCH 变为已批准、按钮移除，续跑后最终回复投到同一话题
 *  8. SIGKILL 持有长连接的副本（按对端端口查出进程）→ 另一副本接管；Lark 重推旧消息不重复处理，
 *     新消息（也重推一次）只回复一次
 *  9. Lark 登录（OAuth + PKCE）：alice 未登录时不能直接登录（Ruling A18），登录状态下完成一次后升级；carol 得到新账号
 * 10. 平台推 `contact.user.created_v3` → 通讯录同步把 carol 加入组织（同一账号）；carol 离职（`is_resigned`）→
 *     手动同步离职处理：成员关系删除、会话吊销、IM 里不再被当作成员
 *
 * 内核把幂等键作为 Lark 的 `uuid` 传给发送 / 回复接口，假 Lark 按它去重；最后断言没有任何一次发送带了用过的 uuid
 * （没有发送需要靠平台去重，内核自己就没有重发），且每个推送的事件都以 code 200 确认。
 */

const LARK = fileURLToPath(new URL("../../src/index.ts", import.meta.url));
const FAKE_IM = fakeExtensionEntry("fake-im");
const PUBLIC = "https://cap.example";
const SOURCE = "lark:t1";
const LEASE_TTL_MS = 3000;
const SECRET = "lark-app-secret-4b5a69";
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
  lark = await startFakeLark({
    tenantKey: "t1",
    botOpenId: "ou_bot",
    botName: "Capybara",
    appSecret: SECRET,
  });
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

describe("M4 第二段验收：Lark（双副本）", () => {
  it("渠道 → 绑定 → 流式对话 → 审批卡片 → 杀副本接管 → Lark 登录 → 通讯录加入与离职", async () => {
    h = await createDualReplicaHarness({
      resolveFrom: PLUGIN_DIR,
      extensions: [MODEL_FAKE, FAKE_IM, LARK],
      pgUrl: pgc.url,
      redisUrl: rdc.url,
      extensionConfig: {
        "fake-im": {
          platformUrl: im.url,
          tenant: "t1",
          clientId: "cli_login",
          clientSecret: "login-secret-5f6e7d",
        },
        lark: { apiUrl: lark.url, accountsUrl: lark.url, appId: lark.appId, appSecret: SECRET },
      },
      config: {
        auth: { cookieSecure: false, loginSources: ["lark"] },
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

    // ================= 1. 启用插件、首轮通讯录同步、建 Lark 渠道连接 =================
    // bob 在根部门（通讯录里）；alice 在 Lark 上有资料、能登录，但不在应用的通讯录范围里
    lark.users.set("ou_bob", { openId: "ou_bob", name: "Bob", departments: ["0"] });
    lark.users.set("ou_alice", { openId: "ou_alice", name: "Alice" });
    const book = im.book("acme-lark-seg2");
    for (const [plugin, body] of [
      ["fake-im", { enabled: true, config: { url: book.url } }],
      ["lark", { enabled: true, config: { appId: lark.appId, appSecret: SECRET } }],
    ] as const) {
      const en = await call(ownerJar, "PUT", `${base}/extensions/${plugin}`, body);
      expect(en.status, JSON.stringify(en.json)).toBe(200);
      expect(JSON.stringify(en.json)).not.toContain(SECRET);
    }
    const sync1 = await call(ownerJar, "POST", `${base}/extensions/lark/directory/sync`);
    expect(sync1.status).toBe(202);
    await waitFor(async () => (await syncAudits()).length === 1, 20_000, "first directory sync");
    expect((await syncAudits())[0]?.detail).toMatchObject({ added: 1, partial: false });
    const bobId = await waitFor(async () => identityOwner("ou_bob"), 15_000, "bob's account");
    expect(await membership(bobId)).toEqual({ role: "member", source: "directory:lark" });

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
      plugin: "lark",
      name: "Acme Lark",
      agentId,
      config: { appId: lark.appId, appSecret: SECRET },
    });
    expect(ch.status, JSON.stringify(ch.json)).toBe(201);
    const channel = ch.json.channel as Json;
    expect(channel).toMatchObject({ plugin: "lark", tenantId: "t1", botUserId: "ou_bot" });
    expect(JSON.stringify(ch.json)).not.toContain(SECRET);
    const connId = channel.id as string;
    await waitFor(async () => lark.openSockets() === 1 || undefined, 15_000, "long connection");
    await sleep(1000);
    expect(lark.openSockets()).toBe(1);
    expect(lark.maxConcurrentSockets()).toBe(1);

    const pushed: string[] = [];
    const push = (id: string) => {
      pushed.push(id);
      return id;
    };
    const postedTo = (chat: string) => lark.messages.filter((m) => m.chatId === chat);
    const dm = (openId: string, chatId: string, text: string, messageId: string) =>
      larkMessageEvent({ openId, chatId, chatType: "p2p", text, messageId });
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
    await lark.waitForAck(push(lark.pushEvent(dm("ou_alice", "oc_dm_alice", "hello", "om_dm_1"))));
    const bindMsg = await waitFor(async () => postedTo("oc_dm_alice")[0], 15_000, "bind card");
    expect(finalText(bindMsg)).toContain(
      "Please link your Capybara account before chatting with me.",
    );
    const bindBtn = findLarkButton(bindMsg.card, (b) => b.url !== undefined);
    expect(bindBtn?.url?.startsWith(`${PUBLIC}/bind/cap_bind_`)).toBe(true);
    const token = (bindBtn?.url ?? "").slice(`${PUBLIC}/bind/`.length);
    expect(await threadConv("oc_dm_alice")).toBeUndefined();

    // ================= 3. 网页上确认绑定（查看与确认落在不同副本） =================
    const peek = await call(aliceJar, "GET", `/api/v1/bind/${token}`);
    expect(peek.status).toBe(200);
    expect(peek.json.binding).toMatchObject({
      connectionId: connId,
      source: SOURCE,
      externalId: "ou_alice",
    });
    const bound = await call(aliceJar, "POST", `/api/v1/bind/${token}`);
    expect(bound.status).toBe(200);
    expect(bound.replica).not.toBe(peek.replica);
    expect(await identityOwner("ou_alice")).toBe(aliceId);
    expect((await call(aliceJar, "POST", `/api/v1/bind/${token}`)).status).toBe(404);

    // ================= 4. 私聊：卡片草稿 → PATCH 流式更新 → 定稿 =================
    const dmBefore = postedTo("oc_dm_alice").length;
    await lark.waitForAck(
      push(lark.pushEvent(dm("ou_alice", "oc_dm_alice", `slow:120:${LONG}`, "om_dm_2"))),
    );
    const draft = await waitFor(
      async () => postedTo("oc_dm_alice").slice(dmBefore)[0],
      20_000,
      "draft message",
    );
    expect(draft.msgType).toBe("interactive");
    expect(lark.cardText(draft.card).length).toBeLessThan(LONG.length);
    // 插件去 @ 时去掉入站文本首尾的空白，所以 model-fake 回显的文本没有末尾空格
    await waitFor(
      async () => finalText(draft) === LONG.trimEnd() || undefined,
      30_000,
      "draft finalized with the full text",
    );
    const updates = lark.updates.filter((u) => u.messageId === draft.messageId);
    expect(updates.length).toBeGreaterThanOrEqual(1);
    for (const u of updates) {
      expect(LONG.startsWith(lark.cardText(u.card).replace(/\s+$/, ""))).toBe(true);
    }
    const dmConv = (await threadConv("oc_dm_alice")) as string;
    expect(
      await db
        .selectFrom("conversations")
        .select(["account_id", "agent_id"])
        .where("id", "=", dmConv)
        .executeTakeFirstOrThrow(),
    ).toEqual({ account_id: aliceId, agent_id: agentId });
    await sleep(500);
    expect(postedTo("oc_dm_alice").slice(dmBefore)).toHaveLength(1);

    // ================= 5. 群里 @ 机器人调用写工具 → 话题里的审批卡片 =================
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
    const approve = findLarkButton(cardMsg.card, (b) => b.text === "Approve once");
    if (!approve) throw new Error("no approve button");
    await cardRecorded(db, { kind: "approval" });

    // ================= 6. 非审批人 bob 点批准 → 被拒并说明 =================
    const beforeBob = postedTo("oc_ops").length;
    const bobClick = await lark.waitForAck(
      push(lark.pushEvent(larkCardAction({ openId: "ou_bob", tenantKey: "t1" }, cardMsg, approve))),
    );
    expect(bobClick.code).toBe(200);
    const refusal = await waitFor(
      async () => postedTo("oc_ops").slice(beforeBob)[0],
      15_000,
      "refusal",
    );
    expect(finalText(refusal)).toContain("You can't handle this request.");
    expect(refusal).toMatchObject({ rootId: "om_mention_1", replyInThread: true });
    await sleep(500);
    expect(await approval()).toEqual({ status: "pending", decided_by: null });
    expect(im.posts).toEqual([]);
    expect(lark.updates.filter((u) => u.messageId === cardMsg.messageId)).toEqual([]);

    // ================= 7. 发起人 alice 批准 → 卡片更新、续跑完成、最终回复投到话题 =================
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
    expect(await approval()).toEqual({ status: "approved", decided_by: aliceId });
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
    expect(im.posts[0]?.body).toMatchObject({ text: "Office closed on Friday" });
    const grpConv = (await threadConv("oc_ops")) as string;
    await waitFor(
      async () => (await eventsOf(db, grpConv)).some((e) => e.type === "run_finished"),
      20_000,
      "run completed",
    );

    // ================= 8. 杀掉持有长连接的副本 → 另一副本接管，消息不重复 =================
    const pids = harness.replicas.map((r) => r.pid);
    const holderPort = lark.socketPeerPorts()[0];
    if (holderPort === undefined) throw new Error("no open long connection");
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
        const port = lark.socketPeerPorts()[0];
        if (port === undefined || port === holderPort) return undefined;
        return (await pidOwningLocalPort(port, pids)) === survivor.pid ? port : undefined;
      },
      LEASE_TTL_MS + 20_000,
      "takeover by the surviving replica",
      100,
    );
    expect(takeoverPort).not.toBe(holderPort);
    expect(Date.now() - killedAt).toBeGreaterThanOrEqual(LEASE_TTL_MS - 1000);
    expect(lark.openSockets()).toBe(1);
    expect(lark.maxConcurrentSockets()).toBe(1);

    // Lark 重推接管前已处理过的消息；再推一条新消息（也重推一次）
    const dmSent = postedTo("oc_dm_alice").length;
    await lark.waitForAck(
      push(lark.pushEvent(dm("ou_alice", "oc_dm_alice", `slow:120:${LONG}`, "om_dm_2"))),
    );
    for (let i = 0; i < 2; i++) {
      await lark.waitForAck(
        push(lark.pushEvent(dm("ou_alice", "oc_dm_alice", "echo:after takeover", "om_dm_3"))),
      );
    }
    await waitFor(
      async () => postedTo("oc_dm_alice").find((m) => finalText(m) === "after takeover"),
      20_000,
      "reply after takeover",
    );
    await sleep(1000);
    expect(postedTo("oc_dm_alice").slice(dmSent)).toHaveLength(1);
    expect(await userMsgIds(dmConv)).toEqual([`${connId}:om_dm_2`, `${connId}:om_dm_3`]);

    // ================= 9. Lark 登录（OAuth 授权码 + PKCE） =================
    lark.users.set("ou_carol", {
      openId: "ou_carol",
      name: "Carol",
      email: "carol@corp.example",
      departments: ["0"],
    });
    /** 走一次 Lark 登录到回调；返回回调的 302 目标。 */
    const ssoTo = async (openId: string, jar: Jar) => {
      const start = await call(jar, "GET", "/api/v1/auth/sso/lark/start?returnTo=%2Fchat");
      expect(start.status).toBe(302);
      const authz = new URL(start.location);
      expect(authz.origin + authz.pathname).toBe(`${lark.url}/open-apis/authen/v1/authorize`);
      expect(authz.searchParams.get("client_id")).toBe(lark.appId);
      expect(authz.searchParams.get("code_challenge_method")).toBe("S256");
      expect(jar.has("cap_sso")).toBe(true);
      const back = await fetch(`${start.location}&as=${openId}`, { redirect: "manual" });
      expect(back.status).toBe(302);
      const cbUrl = new URL(back.headers.get("location") ?? "");
      expect(cbUrl.origin + cbUrl.pathname).toBe(`${PUBLIC}/api/v1/auth/sso/lark/callback`);
      const cb = await call(jar, "GET", cbUrl.pathname + cbUrl.search);
      expect(cb.status).toBe(302);
      expect(jar.has("cap_sso")).toBe(false);
      return cb.location;
    };
    const sso = async (openId: string, jar: Jar = new Map()) => {
      expect(await ssoTo(openId, jar)).toBe(`${PUBLIC}/chat`);
      const me = await call(jar, "GET", "/api/v1/me");
      expect(me.status).toBe(200);
      expect(JSON.stringify(me.json)).not.toContain(SECRET);
      return { jar, accountId: (me.json.account as { id: string }).id };
    };
    const anon: Jar = new Map();
    expect(await ssoTo("ou_alice", anon)).toBe(`${PUBLIC}/login?error=sso.identity_not_verified`);
    expect(anon.has("cap_at")).toBe(false);
    expect((await sso("ou_alice", aliceJar)).accountId).toBe(aliceId);
    expect((await sso("ou_alice")).accountId).toBe(aliceId);
    const carol = await sso("ou_carol");
    expect(carol.accountId).not.toBe(aliceId);
    expect(await identityOwner("ou_carol")).toBe(carol.accountId);
    expect(await membership(carol.accountId)).toBeUndefined();
    // 换 token 带了 PKCE 的 code_verifier
    expect(
      lark.calls.filter((c) => c.api === "oauth_token").every((c) => c.body.code_verifier),
    ).toBe(true);

    // ================= 10. contact.user.created_v3 → 同步加入；carol 离职 → 离职处理 =================
    await lark.waitForAck(
      push(
        lark.pushEvent({
          schema: "2.0",
          header: { event_id: "ev_contact_carol", event_type: "contact.user.created_v3" },
          event: { object: { open_id: "ou_carol", name: "Carol" } },
        }),
      ),
    );
    await waitFor(
      async () => (await syncAudits()).length === 2,
      20_000,
      "sync on contact.user.created_v3",
    );
    expect((await syncAudits())[1]?.detail).toMatchObject({
      trigger: "changed",
      added: 1,
      removed: 0,
      partial: false,
    });
    expect(await membership(carol.accountId)).toEqual({ role: "member", source: "directory:lark" });
    // 同一个身份行（登录、通讯录、渠道三处同键）
    expect(
      await db
        .selectFrom("identities")
        .select(["account_id", "source"])
        .where("external_id", "=", "ou_carol")
        .execute(),
    ).toEqual([{ account_id: carol.accountId, source: SOURCE }]);
    await lark.waitForAck(
      push(lark.pushEvent(dm("ou_carol", "oc_dm_carol", "echo:hello from carol", "om_carol_1"))),
    );
    await waitFor(
      async () => postedTo("oc_dm_carol").find((m) => finalText(m) === "hello from carol"),
      20_000,
      "carol chats as a member",
    );

    const carolUser = lark.users.get("ou_carol");
    if (!carolUser) throw new Error("carol is not a Lark user");
    lark.users.set("ou_carol", { ...carolUser, status: { isResigned: true } });
    const sync3 = await call(ownerJar, "POST", `${base}/extensions/lark/directory/sync`);
    expect(sync3.status).toBe(202);
    await waitFor(async () => (await syncAudits()).length === 3, 20_000, "sync after removal");
    expect((await syncAudits())[2]?.detail).toMatchObject({
      trigger: "manual",
      added: 0,
      removed: 1,
      partial: false,
    });
    expect(await membership(carol.accountId)).toBeUndefined();
    expect(await membership(bobId)).toEqual({ role: "member", source: "directory:lark" });
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
    const carolBefore = postedTo("oc_dm_carol").length;
    await lark.waitForAck(
      push(lark.pushEvent(dm("ou_carol", "oc_dm_carol", "echo:still here?", "om_carol_2"))),
    );
    const notMember = await waitFor(
      async () => postedTo("oc_dm_carol").slice(carolBefore)[0],
      15_000,
      "not-a-member reply",
    );
    expect(finalText(notMember)).toMatch(/not a member/);
    expect(await threadConv("oc_dm_carol")).toBeUndefined();

    // ---- 全程：每个事件都以 200 确认；只有一条长连接；没有发送需要靠 uuid 去重 ----
    for (const id of pushed) {
      expect(lark.acked(id), id).toBe(true);
      expect(lark.acks.find((a) => a.id === id)?.code, id).toBe(200);
    }
    expect(lark.maxConcurrentSockets()).toBe(1);
    const sends = lark.calls.filter((c) => c.api === "create" || c.api === "reply");
    expect(sends.length).toBe(lark.messages.length);
    const uuids = sends.map((c) => c.body.uuid).filter((u) => u !== undefined);
    expect(uuids.length).toBe(sends.length);
    expect(uuids.filter((u, i) => uuids.indexOf(u) !== i)).toEqual([]);
  }, 300_000);
});
