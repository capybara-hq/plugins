import type { ChannelCard, ChannelTarget, ExtensionContext } from "@capybara-hq/plugin-sdk";
import { describe, expect, it } from "vitest";
import { createTelegramChannel } from "../../src/channel.js";

/**
 * Telegram live acceptance (the parts that need no human):
 * `CAPYBARA_TEST_LIVE_TOOLS=1 pnpm exec vitest run plugins/telegram/test/live -t live`
 *
 * - Runs only when `CAPYBARA_TEST_LIVE_TOOLS=1` and `CAPYBARA_TEST_TELEGRAM_BOT_TOKEN` and
 *   `CAPYBARA_TEST_TELEGRAM_CHAT_ID` are set (a value starting with "replace" counts as unset), so
 *   a plain `pnpm test` never reaches the network. The credentials come from the outer
 *   environment; this file reads no credential file and never prints the token.
 * - `CAPYBARA_TEST_TELEGRAM_CHAT_ID` is a private chat with the bot (the person pressed Start once).
 * - `CAPYBARA_TEST_TELEGRAM_GROUP_ID` (optional, the bot is a member): the same send / edit / card
 *   checks in a group.
 * - Checks: `verify`; send, then edit; a 5000-character send that splits; a card with buttons
 *   (nobody clicks it; it is edited to its decided state so no live button stays).
 *
 * The test messages and cards stay in the chat (there is no cleanup); use a throwaway chat or group.
 *
 * The parts that need a person (press Start, click a card, a mention in a group) are not here.
 */

const filled = (v: string | undefined): v is string =>
  v !== undefined && v.trim() !== "" && !v.toLowerCase().startsWith("replace");
const env = process.env;
const LIVE = env.CAPYBARA_TEST_LIVE_TOOLS === "1";
const TOKEN = env.CAPYBARA_TEST_TELEGRAM_BOT_TOKEN;
const CHAT_ID = env.CAPYBARA_TEST_TELEGRAM_CHAT_ID;
const GROUP_ID = env.CAPYBARA_TEST_TELEGRAM_GROUP_ID;
const READY = LIVE && filled(TOKEN) && filled(CHAT_ID);

if (!LIVE) {
  console.info("[telegram-live] skipped (set CAPYBARA_TEST_LIVE_TOOLS=1 to run)");
} else if (!READY) {
  console.info(
    "[telegram-live] skipped: CAPYBARA_TEST_TELEGRAM_BOT_TOKEN / _CHAT_ID not both filled",
  );
}

const API = "https://api.telegram.org";
const log = { info: () => {}, warn: () => {}, error: () => {} };
const config = () => ({ botToken: TOKEN as string });
const timeout = (ms: number) => AbortSignal.timeout(ms);
/** Test-only in-memory kv (the real one is the kernel's): get / set honoring the TTL. */
function memoryKv() {
  const store = new Map<string, { value: string; expires: number }>();
  const sets: { key: string; ttlSeconds: number }[] = [];
  const kv = {
    async get(key: string) {
      const e = store.get(key);
      return e && e.expires > Date.now() ? e.value : null;
    },
    async set(key: string, value: string, opts: { ttlSeconds: number }) {
      sets.push({ key, ttlSeconds: opts.ttlSeconds });
      store.set(key, { value, expires: Date.now() + opts.ttlSeconds * 1000 });
    },
    async del(key: string) {
      store.delete(key);
    },
    async incr() {
      throw new Error("not used by the plugin");
    },
  };
  return { kv, sets };
}
const stamp = new Date().toISOString();

describe.skipIf(!READY)("Telegram live", () => {
  const { kv, sets } = memoryKv();
  const channel = createTelegramChannel({ apiUrl: API, log, kv });

  it("live: verify returns the bot and a tenant that is never the sender tenant", async () => {
    const v = await channel.verify({ config: config(), signal: timeout(20_000) });
    expect(v.botUserId).toMatch(/^\d+$/);
    expect(v.botName).toMatch(/^@\w+$/);
    expect(v.tenantId).toBe(`bot${v.botUserId}`);
    expect(v.tenantId).not.toBe("global");
  }, 30_000);

  const targets: [string, ChannelTarget | undefined][] = [
    ["private chat", { chatId: CHAT_ID as string, chatType: "dm" }],
    ["group", filled(GROUP_ID) ? { chatId: GROUP_ID as string, chatType: "group" } : undefined],
  ];

  for (const [name, target] of targets) {
    it.skipIf(target === undefined)(
      `live: send, edit, split and a card with buttons in the ${name}`,
      async () => {
        const t = target as ChannelTarget;
        const base = { config: config(), target: t, locale: "en" as const };
        const sent = await channel.send({
          ...base,
          message: { text: `Capybara live test ${stamp}: message sent` },
          signal: timeout(20_000),
        });
        expect(sent.messageId).toMatch(new RegExp(`^${t.chatId}:\\d+$`));
        await channel.update({
          ...base,
          messageId: sent.messageId,
          message: { text: `Capybara live test ${stamp}: message **edited**` },
          signal: timeout(20_000),
        });

        // 5000 characters do not fit one message (limit 4096): the send splits and returns the last id.
        const long = await channel.send({
          ...base,
          message: { text: `Capybara live test ${stamp}: split\n\n${"x".repeat(5000)}` },
          signal: timeout(30_000),
        });
        expect(long.messageId).not.toBe(sent.messageId);

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
          ...base,
          message: { text: "", cards: [card] },
          signal: timeout(20_000),
        });
        expect(cardMsg.messageId.length).toBeGreaterThan(0);
        // The keyboard carried callback buttons: each one stored its payload behind a 30-day token.
        const botId = (TOKEN as string).slice(0, (TOKEN as string).indexOf(":"));
        const stored = sets.filter((x) => x.key.startsWith(`card/${botId}/`));
        expect(stored.length).toBeGreaterThanOrEqual(2); // approve (once, session) and deny
        for (const x of stored) expect(x.ttlSeconds).toBe(2_592_000);
        // Decide it: the keyboard goes away, so no live button stays in the test chat.
        await channel.update({
          ...base,
          messageId: cardMsg.messageId,
          message: { text: "", cards: [{ ...card, state: "approved", decidedBy: "Live test" }] },
          signal: timeout(20_000),
        });
      },
      120_000,
    );
  }
});
