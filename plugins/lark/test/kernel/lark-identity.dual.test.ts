import { fileURLToPath } from "node:url";
import {
  createDualReplicaHarness,
  type FakeLarkServer,
  type Harness,
  larkMessageEvent,
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
import { PW, waitFor } from "../helpers/runs.js";

/**
 * 官方 Lark 插件的网页登录（`identity-source@1`）与通讯录（`directory@1`）接内核的双副本验收（插件按路径加载，
 * 连假 Lark 的 OAuth、用户信息、通讯录与长连接）。登录、通讯录、机器人用**同一个** Lark 应用：
 *  1. Lark 登录：start（授权地址带 PKCE S256）→ 假 Lark 授权页 → 回调（插件换 user_access_token、取用户信息、
 *     核对租户）→ Web 会话；身份行 `lark:t1` + open_id；
 *  2. 通讯录同步（根部门 + 子部门分页）把同一个人加入组织（同一个账号，不另建身份），离职的人与未激活的人不加入；
 *  3. 同一个 Lark 用户私聊机器人：被识别为该账号（不发绑定卡片）——登录、通讯录、渠道三处落到同一行身份。
 */

const LARK = fileURLToPath(new URL("../../../../plugins/lark/src/index.ts", import.meta.url));
const PUBLIC = "https://cap.example";
const SECRET = "lark-app-secret-1f2e3d";

let pgc: TestContainer;
let rdc: TestContainer;
let lark: FakeLarkServer;
let h: Harness | undefined;
const cleanups: (() => Promise<unknown> | unknown)[] = [];

beforeAll(async () => {
  [pgc, rdc] = await Promise.all([startTestPostgres(), startTestRedis()]);
  lark = await startFakeLark({ tenantKey: "t1", botOpenId: "ou_bot", appSecret: SECRET });
}, 120_000);

afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
  await h?.stop();
  h = undefined;
});

afterAll(async () => {
  await lark?.stop();
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

describe("Lark 登录与通讯录接内核（双副本）", () => {
  it("Lark 登录 → 通讯录同步加入同一账号 → 私聊机器人被识别为该账号", async () => {
    h = await createDualReplicaHarness({
      extensions: [MODEL_FAKE, LARK],
      pgUrl: pgc.url,
      redisUrl: rdc.url,
      extensionConfig: {
        lark: { apiUrl: lark.url, accountsUrl: lark.url, appId: lark.appId, appSecret: SECRET },
      },
      config: {
        auth: { cookieSecure: false, loginSources: ["lark"] },
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
      return {
        status: res.status,
        location: res.headers.get("location") ?? "",
        json: (isJson ? JSON.parse(text) : {}) as Json,
      };
    };

    lark.departments.push({ openDepartmentId: "od-eng", name: "Engineering", parent: "0" });
    lark.users.set("ou_carol", {
      openId: "ou_carol",
      name: "Carol",
      email: "carol@corp.example",
      departments: ["od-eng"],
    });
    lark.users.set("ou_dan", { openId: "ou_dan", name: "Dan", departments: ["0"] });
    lark.users.set("ou_old", {
      openId: "ou_old",
      name: "Old",
      departments: ["0"],
      status: { isResigned: true },
    });
    lark.users.set("ou_new", {
      openId: "ou_new",
      name: "Invited",
      departments: ["od-eng"],
      status: { isActivated: false },
    });

    const ownerJar: Jar = new Map();
    await new AccountsService(db).createLocal({ login: "owner", password: PW, displayName: "O" });
    expect(
      (await call(ownerJar, "POST", "/api/v1/auth/login", { login: "owner", password: PW })).status,
    ).toBe(200);
    const org = await call(ownerJar, "POST", "/api/v1/orgs", { name: "Acme" });
    const orgId = (org.json.org as { id: string }).id;
    const base = `/api/v1/orgs/${orgId}`;

    const identitiesOf = (externalId: string) =>
      db
        .selectFrom("identities")
        .select(["account_id", "source"])
        .where("external_id", "=", externalId)
        .execute();
    const membership = (accountId: string) =>
      db
        .selectFrom("memberships")
        .select(["role", "source"])
        .where("org_id", "=", orgId)
        .where("account_id", "=", accountId)
        .executeTakeFirst();

    // ================= 1. Lark 网页登录 =================
    const sources = await call(new Map(), "GET", "/api/v1/auth/sources");
    expect(JSON.stringify(sources.json)).toContain("lark");
    const carolJar: Jar = new Map();
    const start = await call(carolJar, "GET", "/api/v1/auth/sso/lark/start?returnTo=%2Fchat");
    expect(start.status).toBe(302);
    const authz = new URL(start.location);
    expect(authz.origin + authz.pathname).toBe(`${lark.url}/open-apis/authen/v1/authorize`);
    expect(authz.searchParams.get("client_id")).toBe(lark.appId);
    expect(authz.searchParams.get("redirect_uri")).toBe(`${PUBLIC}/api/v1/auth/sso/lark/callback`);
    expect(authz.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authz.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // 在假 Lark 上以 ou_carol 同意授权，Lark 带授权码 302 回内核的回调地址
    const back = await fetch(`${start.location}&as=ou_carol`, { redirect: "manual" });
    expect(back.status).toBe(302);
    const cbUrl = new URL(back.headers.get("location") ?? "");
    expect(cbUrl.origin + cbUrl.pathname).toBe(`${PUBLIC}/api/v1/auth/sso/lark/callback`);
    const cb = await call(carolJar, "GET", cbUrl.pathname + cbUrl.search);
    expect(cb.status).toBe(302);
    expect(cb.location).toBe(`${PUBLIC}/chat`);
    const me = await call(carolJar, "GET", "/api/v1/me");
    expect(me.status).toBe(200);
    const carolId = (me.json.account as { id: string }).id;
    expect(await identitiesOf("ou_carol")).toEqual([{ account_id: carolId, source: "lark:t1" }]);
    expect(JSON.stringify(me.json)).not.toContain(SECRET);
    expect(await membership(carolId)).toBeUndefined();
    // 换 token 带了 PKCE verifier 与同一个 redirect_uri
    const exchange = lark.calls.find((c) => c.api === "oauth_token");
    expect(exchange?.body.redirect_uri).toBe(`${PUBLIC}/api/v1/auth/sso/lark/callback`);
    expect(typeof exchange?.body.code_verifier).toBe("string");
    // 回调地址被重放（授权码与 state 都已用过）→ 不再登录
    const replay = await call(new Map(carolJar), "GET", cbUrl.pathname + cbUrl.search);
    expect(replay.location).toContain("sso.state_invalid");

    // ================= 2. 通讯录同步：同一个人加入组织 =================
    const en = await call(ownerJar, "PUT", `${base}/extensions/lark`, {
      enabled: true,
      config: { appId: lark.appId, appSecret: SECRET },
    });
    expect(en.status, JSON.stringify(en.json)).toBe(200);
    expect(JSON.stringify(en.json)).not.toContain(SECRET);
    const sync = await call(ownerJar, "POST", `${base}/extensions/lark/directory/sync`);
    expect(sync.status).toBe(202);
    const audit = await waitFor(
      async () =>
        (
          await db
            .selectFrom("audit_events")
            .select("detail")
            .where("org_id", "=", orgId)
            .where("action", "=", "org.directory.synced")
            .executeTakeFirst()
        )?.detail as Json | undefined,
      20_000,
      "directory sync",
    );
    expect(audit).toMatchObject({ partial: false });
    expect(await membership(carolId)).toEqual({ role: "member", source: "directory:lark" });
    expect(await identitiesOf("ou_carol")).toEqual([{ account_id: carolId, source: "lark:t1" }]);
    const dan = await identitiesOf("ou_dan");
    expect(dan).toHaveLength(1);
    expect(dan[0]?.source).toBe("lark:t1");
    expect(await membership(dan[0]?.account_id ?? "")).toEqual({
      role: "member",
      source: "directory:lark",
    });
    expect(await identitiesOf("ou_old")).toEqual([]);
    expect(await identitiesOf("ou_new")).toEqual([]);
    expect(await identitiesOf(lark.botOpenId)).toEqual([]);

    // ================= 3. 同一个 Lark 用户私聊机器人：识别为该账号 =================
    const ag = await call(ownerJar, "POST", `${base}/agents`, {
      definition: {
        name: "Helper",
        instructions: "Be helpful.",
        model: { provider: "model-fake", model: "fake-1" },
      },
      visibility: "org",
    });
    expect(ag.status, JSON.stringify(ag.json)).toBe(201);
    const ch = await call(ownerJar, "POST", `${base}/channels`, {
      plugin: "lark",
      name: "Acme Lark",
      agentId: (ag.json.agent as { id: string }).id,
      config: { appId: lark.appId, appSecret: SECRET },
    });
    expect(ch.status, JSON.stringify(ch.json)).toBe(201);
    expect(ch.json.channel).toMatchObject({ plugin: "lark", tenantId: "t1" });
    const connId = (ch.json.channel as { id: string }).id;
    await waitFor(async () => lark.openSockets() === 1 || undefined, 15_000, "long connection");

    await lark.waitForAck(
      lark.pushEvent(
        larkMessageEvent({
          openId: "ou_carol",
          chatId: "oc_dm_carol",
          chatType: "p2p",
          text: "hello from carol",
          messageId: "om_carol_1",
        }),
      ),
    );
    const reply = await waitFor(
      async () => lark.messages.find((m) => m.chatId === "oc_dm_carol"),
      20_000,
      "reply to carol",
    );
    expect(lark.cardText(lark.finalCard(reply))).not.toContain("link your Capybara account");
    const thread = await waitFor(
      async () =>
        db
          .selectFrom("channel_threads")
          .select("account_id")
          .where("connection_id", "=", connId)
          .where("chat_id", "=", "oc_dm_carol")
          .executeTakeFirst(),
      10_000,
      "channel thread",
    );
    expect(thread.account_id).toBe(carolId);
    expect(await identitiesOf("ou_carol")).toEqual([{ account_id: carolId, source: "lark:t1" }]);
  }, 180_000);
});
