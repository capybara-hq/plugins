import { fileURLToPath } from "node:url";
import {
  createDualReplicaHarness,
  type FakeSlackServer,
  type Harness,
  slackDmEvent,
  startFakeSlack,
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
 * 官方 Slack 插件的登录（`identity-source@1`）与通讯录（`directory@1`）接内核的双副本验收（插件按路径加载，
 * 连假 Slack 的 OpenID Connect 与 Web API）：
 *  1. Sign in with Slack：start → 假 Slack 授权页 → 回调（插件换 token、校验 ID token）→ Web 会话；
 *     身份行 `slack:T1` + Slack user id；
 *  2. 通讯录同步（users.list 分页）把同一个人加入组织（同一个账号，不另建身份），机器人与已删除的人不加入；
 *  3. 同一个 Slack 用户私聊机器人：被识别为该账号（不发绑定卡片）——渠道、登录、通讯录三处的身份键一致。
 */

const SLACK = fileURLToPath(new URL("../../../../plugins/slack/src/index.ts", import.meta.url));
const PUBLIC = "https://cap.example";

let pgc: TestContainer;
let rdc: TestContainer;
let slack: FakeSlackServer;
let h: Harness | undefined;
const cleanups: (() => Promise<unknown> | unknown)[] = [];

beforeAll(async () => {
  [pgc, rdc] = await Promise.all([startTestPostgres(), startTestRedis()]);
  slack = await startFakeSlack({
    teamId: "T1",
    botUserId: "UBOT",
    clientId: "cli-slack-login",
    clientSecret: "slack-login-secret-7c1d",
  });
}, 120_000);

afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
  await h?.stop();
  h = undefined;
});

afterAll(async () => {
  await slack?.stop();
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

describe("Slack 登录与通讯录接内核（双副本）", () => {
  it("Sign in with Slack → 通讯录同步加入同一账号 → 私聊机器人被识别为该账号", async () => {
    h = await createDualReplicaHarness({
      extensions: [MODEL_FAKE, SLACK],
      pgUrl: pgc.url,
      redisUrl: rdc.url,
      extensionConfig: {
        slack: {
          apiUrl: slack.apiUrl,
          openidUrl: `${slack.url}/`,
          clientId: "cli-slack-login",
          clientSecret: "slack-login-secret-7c1d",
        },
      },
      config: {
        auth: { cookieSecure: false, loginSources: ["slack"] },
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

    slack.users.set("UCAROL", {
      id: "UCAROL",
      teamId: "T1",
      name: "carol",
      realName: "Carol",
      email: "carol@corp.example",
      emailVerified: true,
    });
    slack.users.set("UDAN", { id: "UDAN", teamId: "T1", name: "dan", realName: "Dan" });
    slack.users.set("UOLD", { id: "UOLD", teamId: "T1", name: "old", deleted: true });
    slack.users.set("UHELPER", { id: "UHELPER", teamId: "T1", name: "helper", isBot: true });

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

    // ================= 1. Sign in with Slack =================
    const sources = await call(new Map(), "GET", "/api/v1/auth/sources");
    expect(JSON.stringify(sources.json)).toContain("slack");
    const carolJar: Jar = new Map();
    const start = await call(carolJar, "GET", "/api/v1/auth/sso/slack/start?returnTo=%2Fchat");
    expect(start.status).toBe(302);
    const authz = new URL(start.location);
    expect(authz.origin + authz.pathname).toBe(`${slack.url}/openid/connect/authorize`);
    expect(authz.searchParams.get("client_id")).toBe("cli-slack-login");
    expect(authz.searchParams.get("scope")).toBe("openid email profile");
    expect(authz.searchParams.get("redirect_uri")).toBe(`${PUBLIC}/api/v1/auth/sso/slack/callback`);
    // 在假 Slack 上以 UCAROL 登录，Slack 带授权码 302 回内核的回调地址
    const back = await fetch(`${start.location}&as=UCAROL`, { redirect: "manual" });
    expect(back.status).toBe(302);
    const cbUrl = new URL(back.headers.get("location") ?? "");
    expect(cbUrl.origin + cbUrl.pathname).toBe(`${PUBLIC}/api/v1/auth/sso/slack/callback`);
    const cb = await call(carolJar, "GET", cbUrl.pathname + cbUrl.search);
    expect(cb.status).toBe(302);
    expect(cb.location).toBe(`${PUBLIC}/chat`);
    const me = await call(carolJar, "GET", "/api/v1/me");
    expect(me.status).toBe(200);
    const carolId = (me.json.account as { id: string }).id;
    expect(await identitiesOf("UCAROL")).toEqual([{ account_id: carolId, source: "slack:T1" }]);
    expect(JSON.stringify(me.json)).not.toContain("slack-login-secret-7c1d");
    expect(await membership(carolId)).toBeUndefined();

    // ================= 2. 通讯录同步：同一个人加入组织 =================
    const en = await call(ownerJar, "PUT", `${base}/extensions/slack`, {
      enabled: true,
      config: { teamId: "T1", botToken: slack.botToken },
    });
    expect(en.status, JSON.stringify(en.json)).toBe(200);
    expect(JSON.stringify(en.json)).not.toContain(slack.botToken);
    const sync = await call(ownerJar, "POST", `${base}/extensions/slack/directory/sync`);
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
    expect(await membership(carolId)).toEqual({ role: "member", source: "directory:slack" });
    expect(await identitiesOf("UCAROL")).toEqual([{ account_id: carolId, source: "slack:T1" }]);
    const dan = await identitiesOf("UDAN");
    expect(dan).toHaveLength(1);
    expect(dan[0]?.source).toBe("slack:T1");
    expect(await membership(dan[0]?.account_id ?? "")).toEqual({
      role: "member",
      source: "directory:slack",
    });
    expect(await identitiesOf("UOLD")).toEqual([]);
    expect(await identitiesOf("UHELPER")).toEqual([]);
    expect(await identitiesOf("USLACKBOT")).toEqual([]);

    // ================= 3. 同一个 Slack 用户私聊机器人：识别为该账号 =================
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
      plugin: "slack",
      name: "Acme Slack",
      agentId: (ag.json.agent as { id: string }).id,
      config: { appToken: slack.appToken, botToken: slack.botToken },
    });
    expect(ch.status, JSON.stringify(ch.json)).toBe(201);
    const connId = (ch.json.channel as { id: string }).id;
    await waitFor(async () => slack.openSockets() === 1 || undefined, 15_000, "socket mode");

    await slack.waitForAck(
      slack.pushEvent(slackDmEvent("UCAROL", "hello from carol", { ts: "300.1" })),
    );
    const reply = await waitFor(
      async () => slack.messages.find((m) => m.channel === "DUCAROL"),
      20_000,
      "reply to carol",
    );
    expect(reply.text).not.toContain("link your Capybara account");
    const thread = await waitFor(
      async () =>
        db
          .selectFrom("channel_threads")
          .select("account_id")
          .where("connection_id", "=", connId)
          .where("chat_id", "=", "DUCAROL")
          .executeTakeFirst(),
      10_000,
      "channel thread",
    );
    expect(thread.account_id).toBe(carolId);
    expect(await identitiesOf("UCAROL")).toEqual([{ account_id: carolId, source: "slack:T1" }]);
  }, 180_000);
});
