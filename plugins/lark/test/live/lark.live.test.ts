import type { ChannelCard, InboundEvent } from "@capybara-hq/plugin-sdk";
import { afterAll, describe, expect, it } from "vitest";
import { createLarkChannel } from "../../src/channel.js";
import { createLarkDirectory } from "../../src/directory.js";
import { createLarkIdentitySource } from "../../src/identity.js";

/**
 * Lark 真实平台验收（不需要人操作的部分）：
 * `CAPYBARA_TEST_LIVE_TOOLS=1 pnpm vitest run plugins/lark/test/live -t live`
 *
 * - 开关：只在 `CAPYBARA_TEST_LIVE_TOOLS=1` 且 `CAPYBARA_TEST_LARK_APP_ID` / `_APP_SECRET` 都填了时运行（值以「替换为」
 *   开头视为未填）；普通 `pnpm test` 不访问外网。凭据由外层环境注入，代码不读任何凭据文件，也不打印。
 *   登录、机器人、通讯录用同一个企业自建应用（`open_id` 按应用区分）。
 * - verify 返回机器人（bot open_id）与租户（tenant_key）；长连接：插件的 `connect`（官方 SDK `WSClient`）连上后
 *   保持 10 秒不出错、不重连，中止后正常返回；通讯录第一页（成员租户与 verify 一致）；网页登录的授权地址。
 * - 另填 `CAPYBARA_TEST_LARK_CHAT_ID`（测试群或与机器人的单聊的 `oc_…`，机器人须已在其中；单聊另设
 *   `CAPYBARA_TEST_LARK_CHAT_TYPE=dm`）时：发一条消息（卡片）、更新它、发一张审批卡片并把它改成「已批准」。
 *
 * 需要人操作的部分（私聊机器人、点卡片、浏览器登录、通讯录变动事件）见
 * `docs/superpowers/plans/m4-live-acceptance-checklist.md`。
 */

const filled = (v: string | undefined): v is string =>
  v !== undefined && v.trim() !== "" && !v.startsWith("替换为");
const env = process.env;
const LIVE = env.CAPYBARA_TEST_LIVE_TOOLS === "1";
const APP_ID = env.CAPYBARA_TEST_LARK_APP_ID;
const APP_SECRET = env.CAPYBARA_TEST_LARK_APP_SECRET;
const CHAT_ID = env.CAPYBARA_TEST_LARK_CHAT_ID;
const CHAT_TYPE = env.CAPYBARA_TEST_LARK_CHAT_TYPE === "dm" ? "dm" : "group";
const READY = LIVE && filled(APP_ID) && filled(APP_SECRET);

if (!LIVE) {
  console.info("[lark-live] skipped (set CAPYBARA_TEST_LIVE_TOOLS=1 to run)");
} else if (!READY) {
  console.info("[lark-live] skipped: CAPYBARA_TEST_LARK_APP_ID / _APP_SECRET not both filled");
}

const API = "https://open.larksuite.com";
const logs: { level: string; msg: string }[] = [];
const log = {
  info: (msg: string) => logs.push({ level: "info", msg }),
  warn: (msg: string) => logs.push({ level: "warn", msg }),
  error: (msg: string) => logs.push({ level: "error", msg }),
};
const creds = () => ({ appId: APP_ID as string, appSecret: APP_SECRET as string });
const timeout = (ms: number) => AbortSignal.timeout(ms);
const stamp = new Date().toISOString();
const stops: (() => Promise<void>)[] = [];

afterAll(async () => {
  for (const s of stops.splice(0)) await s();
});

describe.skipIf(!READY)("Lark live", () => {
  const channel = createLarkChannel({ apiUrl: API, log, loginApp: creds() });
  let tenantId: string | undefined;

  it("live: verify returns the bot and the tenant", async () => {
    const v = await channel.verify({ config: creds(), signal: timeout(20_000) });
    expect(v.botUserId).toMatch(/^ou_/);
    expect(v.botName.length).toBeGreaterThan(0);
    expect(v.tenantId.length).toBeGreaterThan(0);
    tenantId = v.tenantId;
  }, 30_000);

  it("live: the long connection comes up and stays connected until aborted", async () => {
    const before = logs.length;
    const events: InboundEvent[] = [];
    const ac = new AbortController();
    let settled: "resolved" | "rejected" | undefined;
    let failure = "";
    const done = channel
      .connect({
        connectionId: "live-lark",
        config: creds(),
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
  }, 60_000);

  it("live: directory lists the first page of members", async () => {
    const dir = createLarkDirectory({ apiUrl: API, loginApp: creds() });
    const orgConfig = creds();
    expect(dir.configured?.(orgConfig)).toBe(true);
    const page = await dir.listMembers({ orgConfig, signal: timeout(60_000) });
    expect(page.members.length).toBeGreaterThan(0);
    for (const m of page.members) {
      expect(m.externalId).toMatch(/^ou_/);
      if (tenantId !== undefined) expect(m.tenantId).toBe(tenantId);
      expect(m.emailVerified).toBe(false);
    }
  }, 90_000);

  it("live: login builds the Lark authorize URL with PKCE", () => {
    const idp = createLarkIdentitySource();
    const url = new URL(
      idp.authorizeUrl({
        config: creds(),
        redirectUri: "https://cap.example/api/v1/auth/sso/lark/callback",
        state: "live-state",
        nonce: "live-nonce",
        codeChallenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
        codeChallengeMethod: "S256",
      }),
    );
    expect(url.origin + url.pathname).toBe(
      "https://accounts.larksuite.com/open-apis/authen/v1/authorize",
    );
    expect(url.searchParams.get("client_id")).toBe(APP_ID);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  });

  it.skipIf(!filled(CHAT_ID))(
    "live: send, update, and render an approval card in the test chat",
    async () => {
      const target = { chatId: CHAT_ID as string, chatType: CHAT_TYPE } as const;
      const sent = await channel.send({
        config: creds(),
        target,
        message: { text: `Capybara 真实联调 ${stamp}：已发送` },
        signal: timeout(20_000),
        locale: "zh",
        idempotencyKey: `live-${Date.now()}`,
      });
      expect(sent.messageId).toMatch(/^om_/);
      await channel.update({
        config: creds(),
        target,
        messageId: sent.messageId,
        message: { text: `Capybara 真实联调 ${stamp}：**已更新**` },
        signal: timeout(20_000),
        locale: "zh",
      });

      const card: Extract<ChannelCard, { kind: "approval" }> = {
        kind: "approval",
        id: `apr_live_${Date.now()}`,
        title: `Capybara 真实联调 ${stamp}`,
        toolName: "post_announcement",
        agentName: "Live test",
        inputPreview: '{"text":"Office closed on Friday"}',
        scopes: ["once", "session"],
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        state: "pending",
        webUrl: "https://example.com/capybara-live-test",
      };
      const cardMsg = await channel.send({
        config: creds(),
        target,
        message: { text: "", cards: [card] },
        signal: timeout(20_000),
        locale: "zh",
        idempotencyKey: `live-card-${Date.now()}`,
      });
      expect(cardMsg.messageId).toMatch(/^om_/);
      // 改成已批准：按钮移除，测试群里不留可点的卡片
      await channel.update({
        config: creds(),
        target,
        messageId: cardMsg.messageId,
        message: { text: "", cards: [{ ...card, state: "approved", decidedBy: "Live test" }] },
        signal: timeout(20_000),
        locale: "zh",
      });
    },
    90_000,
  );
});
