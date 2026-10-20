import type { ChannelCard, InboundEvent } from "@capybara-hq/plugin-sdk";
import { afterAll, describe, expect, it } from "vitest";
import { createSlackChannel } from "../../src/channel.js";
import { createSlackDirectory } from "../../src/directory.js";
import { createSlackIdentitySource } from "../../src/identity.js";

/**
 * Slack 真实平台验收（不需要人操作的部分）：
 * `CAPYBARA_TEST_LIVE_TOOLS=1 pnpm vitest run plugins/slack/test/live -t live`
 *
 * - 开关：只在 `CAPYBARA_TEST_LIVE_TOOLS=1` 且 `CAPYBARA_TEST_SLACK_APP_TOKEN` / `_BOT_TOKEN` / `_TEAM_ID` 都填了时
 *   运行（值以「替换为」开头视为未填）；普通 `pnpm test` 不访问外网。凭据由外层环境注入，代码不读任何凭据文件，
 *   也不打印。
 * - verify（auth.test）返回机器人与租户（= TEAM_ID）；Socket Mode：`apps.connections.open` 可用，插件的
 *   `connect` 连上后保持 10 秒不出错、不重连，中止后正常返回；通讯录 `users.list` 第一页。
 * - 另填 `CAPYBARA_TEST_SLACK_CHANNEL`（测试频道或私聊的 id，机器人须已在其中）时：发一条消息、编辑它、
 *   发一张审批卡片并把它改成「已批准」（不留下可点的按钮）。
 * - 另填 `CAPYBARA_TEST_SLACK_CLIENT_ID` / `_CLIENT_SECRET` 时：Sign in with Slack 的授权地址，以及用一个无效的
 *   授权码换 token——Slack 回 `invalid_code`（而不是 `invalid_client_id` / `bad_client_secret`）即说明客户端凭据正确。
 *
 * 需要人操作的部分（私聊机器人、点卡片、浏览器登录、通讯录变动事件）见
 * `docs/superpowers/plans/m4-live-acceptance-checklist.md`。
 */

const filled = (v: string | undefined): v is string =>
  v !== undefined && v.trim() !== "" && !v.startsWith("替换为");
const env = process.env;
const LIVE = env.CAPYBARA_TEST_LIVE_TOOLS === "1";
const APP_TOKEN = env.CAPYBARA_TEST_SLACK_APP_TOKEN;
const BOT_TOKEN = env.CAPYBARA_TEST_SLACK_BOT_TOKEN;
const TEAM_ID = env.CAPYBARA_TEST_SLACK_TEAM_ID;
const CHANNEL = env.CAPYBARA_TEST_SLACK_CHANNEL;
const CLIENT_ID = env.CAPYBARA_TEST_SLACK_CLIENT_ID;
const CLIENT_SECRET = env.CAPYBARA_TEST_SLACK_CLIENT_SECRET;
const READY = LIVE && filled(APP_TOKEN) && filled(BOT_TOKEN) && filled(TEAM_ID);
const LOGIN = READY && filled(CLIENT_ID) && filled(CLIENT_SECRET);

if (!LIVE) {
  console.info("[slack-live] skipped (set CAPYBARA_TEST_LIVE_TOOLS=1 to run)");
} else if (!READY) {
  console.info(
    "[slack-live] skipped: CAPYBARA_TEST_SLACK_APP_TOKEN / _BOT_TOKEN / _TEAM_ID not all filled",
  );
}

const API = "https://slack.com/api/";
const logs: { level: string; msg: string }[] = [];
const log = {
  info: (msg: string) => logs.push({ level: "info", msg }),
  warn: (msg: string) => logs.push({ level: "warn", msg }),
  error: (msg: string) => logs.push({ level: "error", msg }),
};
const config = () => ({ appToken: APP_TOKEN as string, botToken: BOT_TOKEN as string });
const timeout = (ms: number) => AbortSignal.timeout(ms);
const stamp = new Date().toISOString();
const stops: (() => Promise<void>)[] = [];

afterAll(async () => {
  for (const s of stops.splice(0)) await s();
});

describe.skipIf(!READY)("Slack live", () => {
  const channel = createSlackChannel({ apiUrl: API, log });

  it("live: verify returns the bot and the workspace team", async () => {
    const v = await channel.verify({ config: config(), signal: timeout(20_000) });
    expect(v.tenantId).toBe(TEAM_ID);
    expect(v.botUserId).toMatch(/^[UW][A-Z0-9]+$/);
    expect(v.botName.length).toBeGreaterThan(0);
  }, 30_000);

  it("live: Socket Mode comes up and stays connected until aborted", async () => {
    // 应用级令牌能开 Socket Mode（应用已开启 Socket Mode、令牌有 connections:write）
    const open = await fetch(`${API}apps.connections.open`, {
      method: "POST",
      headers: { authorization: `Bearer ${APP_TOKEN}` },
      signal: timeout(20_000),
    });
    const body = (await open.json()) as { ok?: boolean; error?: string; url?: string };
    expect(body.error).toBeUndefined();
    expect(body.ok).toBe(true);
    expect(body.url?.startsWith("wss://")).toBe(true);

    const before = logs.length;
    const events: InboundEvent[] = [];
    const ac = new AbortController();
    let settled: "resolved" | "rejected" | undefined;
    let failure = "";
    const done = channel
      .connect({
        connectionId: "live-slack",
        config: config(),
        signal: ac.signal,
        onEvent: async (e) => {
          events.push(e);
        },
      })
      .then(
        () => {
          settled = "resolved";
        },
        (e: unknown) => {
          settled = "rejected";
          failure = e instanceof Error ? e.message : String(e);
        },
      );
    stops.push(async () => {
      ac.abort();
      await done;
    });
    await new Promise((r) => setTimeout(r, 10_000));
    expect(failure).toBe("");
    expect(settled).toBeUndefined();
    const since = logs.slice(before);
    expect(since.filter((l) => l.level !== "info")).toEqual([]);
    expect(since.filter((l) => l.msg.includes("reconnecting"))).toEqual([]);
    ac.abort();
    await done;
    expect(settled).toBe("resolved");
  }, 40_000);

  it("live: directory lists the first page of workspace members", async () => {
    const dir = createSlackDirectory({ apiUrl: API });
    const orgConfig = { teamId: TEAM_ID, botToken: BOT_TOKEN };
    expect(dir.configured?.(orgConfig)).toBe(true);
    const page = await dir.listMembers({ orgConfig, signal: timeout(60_000) });
    expect(page.members.length).toBeGreaterThan(0);
    for (const m of page.members) {
      expect(m.tenantId).toBe(TEAM_ID);
      expect(m.externalId).toMatch(/^[UW][A-Z0-9]+$/);
      expect(m.emailVerified).toBe(false);
    }
  }, 90_000);

  it.skipIf(!filled(CHANNEL))(
    "live: send, edit, and render an approval card in the test channel",
    async () => {
      const chatId = CHANNEL as string;
      const target = { chatId, chatType: chatId.startsWith("D") ? "dm" : "group" } as const;
      const sent = await channel.send({
        config: config(),
        target,
        message: { text: `Capybara live test ${stamp}: message sent` },
        signal: timeout(20_000),
        locale: "en",
      });
      expect(sent.messageId.length).toBeGreaterThan(0);
      await channel.update({
        config: config(),
        target,
        messageId: sent.messageId,
        message: { text: `Capybara live test ${stamp}: message **edited**` },
        signal: timeout(20_000),
        locale: "en",
      });

      const card: Extract<ChannelCard, { kind: "approval" }> = {
        kind: "approval",
        id: `apr_live_${Date.now()}`,
        title: `Capybara live test ${stamp}`,
        toolName: "post_announcement",
        agentName: "Live test",
        inputPreview: '{"text":"Office closed on Friday"}',
        scopes: ["once", "session"],
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        state: "pending",
        webUrl: "https://example.com/capybara-live-test",
      };
      const cardMsg = await channel.send({
        config: config(),
        target,
        message: { text: "", cards: [card] },
        signal: timeout(20_000),
        locale: "en",
      });
      expect(cardMsg.messageId.length).toBeGreaterThan(0);
      // 改成已批准：按钮移除，测试频道里不留可点的卡片
      await channel.update({
        config: config(),
        target,
        messageId: cardMsg.messageId,
        message: { text: "", cards: [{ ...card, state: "approved", decidedBy: "Live test" }] },
        signal: timeout(20_000),
        locale: "en",
      });
    },
    90_000,
  );

  it.skipIf(!LOGIN)(
    "live: Sign in with Slack builds the authorize URL and accepts the client credentials",
    async () => {
      const idp = createSlackIdentitySource();
      const deployment = {
        apiUrl: API,
        openidUrl: "https://slack.com/",
        clientId: CLIENT_ID,
        clientSecret: CLIENT_SECRET,
      };
      const url = new URL(
        idp.authorizeUrl({
          config: deployment,
          redirectUri: "https://cap.example/api/v1/auth/sso/slack/callback",
          state: "live-state",
          nonce: "live-nonce",
        }),
      );
      expect(url.origin + url.pathname).toBe("https://slack.com/openid/connect/authorize");
      expect(url.searchParams.get("client_id")).toBe(CLIENT_ID);
      expect(url.searchParams.get("scope")).toBe("openid email profile");
      // 无效授权码：客户端凭据正确时 Slack 回 invalid_code
      let message = "";
      await idp
        .callback({
          config: deployment,
          redirectUri: "https://cap.example/api/v1/auth/sso/slack/callback",
          query: { code: "capybara-live-invalid-code", state: "live-state" },
          nonce: "live-nonce",
          signal: timeout(20_000),
        })
        .catch((e: unknown) => {
          message = e instanceof Error ? e.message : String(e);
        });
      expect(message).toMatch(/openid\.connect\.token failed: invalid_code/);
    },
    30_000,
  );
});
