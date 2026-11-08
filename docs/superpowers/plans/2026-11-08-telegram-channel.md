# Telegram channel plugin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `@capybara-hq/plugin-telegram` (`channel@1`: long polling + webhook, inline-keyboard
cards, edit-based streaming), after fixing the stale kernel test fixtures and adding a Telegram fake
server to `@capybara-hq/testing`.

**Architecture:** Three deliverables in order, each its own PR. (1) plugins: test fixtures
`tools` → `disabledTools` on testing rc.8. (2) core: `startFakeTelegram` in `packages/testing`,
released by the maintainer. (3) plugins: the plugin, modelled on `plugins/slack` (one file per
concern, a token-free Bot API client, `ctx.kv` for thread / topic / card-token / offset records).

**Tech Stack:** TypeScript (ESM, Node 24), zod 4, `fetch` (no Telegram SDK), vitest,
`@capybara-hq/plugin-sdk`, `@capybara-hq/testing`.

**Spec:** `docs/superpowers/specs/2026-11-08-telegram-channel-design.md` (read it first; this plan
does not repeat its decisions, only pins names and tests).

## Global Constraints

- Follow `.agents/skills/writing-channels/SKILL.md` and `writing-extensions` (plugins repo) and
  core's `writing-channels` for Part 2.
- English for code comments, docs, identifiers, commit messages; Conventional Commits, body lines
  ≤ 100 chars, end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- No timers, no module-level mutable state (`pnpm check`); waits via `pause` (copy
  `plugins/lark/src/wait.ts`); every `ctx.kv` write has a TTL.
- Token never in an error message, log line, `cause` or `last_error`. The Bot API URL contains the
  token: never stringify the URL or a fetch error that may contain it.
- New plugin version `0.1.0-rc.0`, **no changeset** (jina precedent); marketplace entry via
  `pnpm exec capybara-plugin marketplace --write`. `defineExtension.sdk: "^0.1.0-rc.4"`.
- Plugin tests import only the SDK, `@capybara-hq/testing`, model-fake and the plugin's own files.
- Identity: `sender.tenantId` is always `"global"`; `verify` returns `tenantId: "bot" + botId`.
- Limits: text 4096 chars; `callback_data` ≤ 64 bytes; `minEditIntervalMs: 3000`; kv TTLs: thread,
  topic, card token 30 days (2_592_000 s); offset 7 days (604_800 s).
- Run tests from the repo root: `pnpm exec vitest run <path>`.

## Review Focus

1. A Bot API failure whose underlying error text includes the request URL (undici network error,
   abort) must surface as `Telegram <method> failed: network error` with no token. Pinned in Task 3.
2. A user replying to a *card* message (not a text reply) in a group must continue that thread, not
   start a new one: card messages are recorded in kv like any other sent message. Pinned in Task 7.
3. A group message where the bot is mentioned by a different-case username (`@MyBot` vs `mybot`)
   must still count as a mention (Telegram usernames are case-insensitive). Pinned in Task 5.
4. An `onEvent` rejection in the middle of a `getUpdates` batch must not confirm later updates of
   that batch (offset stays at the failed update). Pinned in Task 8.
5. A webhook request with a correct secret but a non-JSON or non-update body must be rejected 400,
   never crash the route. Pinned in Task 9.

---

## Part 1 — plugins PR: fixture fix (branch `test/disabled-tools`)

### Task 1: Raise testing to rc.8 and replace `tools` with `disabledTools`

Work in a separate worktree: `pnpm wt:new test/disabled-tools --from origin/main` (in
`/Users/grant/Capybara/plugins`).

**Files:**
- Modify: `package.json`, `plugins/*/package.json` that list `@capybara-hq/testing`,
  `@capybara-hq/plugin-sdk`, `@capybara-hq/plugin-model-fake`; `pnpm-lock.yaml`
- Modify: `plugins/slack/test/kernel/{slack,m4-segment2-slack,slack-webhook,m7-segment1}.*.ts`,
  `plugins/lark/test/kernel/{lark,m4-segment2-lark}.dual.test.ts`,
  `plugins/connector-mcp/test/kernel/mcp-e2e.test.ts`,
  `plugins/connector-openapi/test/kernel/openapi-e2e.test.ts`, and any other hit of
  `git grep -n "tools: \[" -- 'plugins/*/test'` that is an agent `definition`.

- [ ] **Step 1:** bump to the latest published: `@capybara-hq/testing@0.1.0-rc.8`,
  `@capybara-hq/plugin-sdk@0.1.0-rc.5`, `@capybara-hq/plugin-model-fake@0.1.0-rc.5`
  (`npm view <pkg> dist-tags.next` to confirm; use newer if published). `pnpm install`.
- [ ] **Step 2:** run `pnpm exec vitest run plugins` — Expected: FAIL in the kernel tests above with
  `tools was replaced by disabledTools`.
- [ ] **Step 3:** in each agent definition replace `tools: [...]` with `disabledTools: []`. If a test
  relied on a tool being *absent*, express it with `disabledTools` instead of dropping it.
- [ ] **Step 4:** `pnpm lint && pnpm typecheck && pnpm check && pnpm exec vitest run plugins` —
  Expected: all pass (live tests skipped).
- [ ] **Step 5: Commit** `test: agent definitions use disabledTools (testing rc.8)`; open the PR via
  the `contributing` skill (issue needed for `issue-linked`). No changeset (tests and dev deps only).

## Part 2 — core PR: `startFakeTelegram` (branch `feat/fake-telegram`)

### Task 2: Fake Telegram Bot API in `@capybara-hq/testing`

Work in core: `pnpm wt:new feat/fake-telegram --from origin/main`.

**Files:**
- Create: `packages/testing/src/fake-telegram.ts`
- Modify: `packages/testing/src/index.ts` (exports)
- Test: `packages/testing/test/fake-telegram.test.ts`
- Modify: `.agents/skills/writing-channels/SKILL.md` (fake table), `.changeset/fake-telegram.md`
  (`"@capybara-hq/testing": minor`)

**Interfaces — Produces** (exact names; Part 3 depends on them):

```ts
export interface FakeTelegramBot { token: string; id: number; username: string;
  firstName?: string; canReadAllGroupMessages?: boolean; hasTopicsEnabled?: boolean }
export interface FakeTelegramCall { method: string; token: string; params: Record<string, unknown>; at: number }
export interface FakeTelegramMessage { chatId: number; messageId: number; text: string;
  parseMode?: string; replyMarkup?: unknown; messageThreadId?: number;
  replyToMessageId?: number; at: number }
export interface FakeTelegramFailure { status: number; errorCode?: number; description: string;
  retryAfter?: number; migrateToChatId?: number }
export interface FakeTelegramOptions { bots?: FakeTelegramBot[] } // default one bot
export interface FakeTelegramServer {
  url: string; apiUrl: string;            // apiUrl = url (plugin appends /bot<token>/<method>)
  bot: FakeTelegramBot; bots: FakeTelegramBot[];
  messages: FakeTelegramMessage[];        // sendMessage results, in order
  edits: FakeTelegramMessage[];           // editMessageText calls that changed text
  calls: FakeTelegramCall[];
  callbackAnswers: string[];              // answerCallbackQuery callback_query_id
  push(update: Record<string, unknown>, token?: string): number;  // assigns update_id, returns it
  confirmedOffset(token?: string): number; // highest offset passed to getUpdates
  pending(token?: string): number;         // pushed, not yet confirmed
  activePollers(token?: string): number;   // in-flight getUpdates
  maxConcurrentPollers(token?: string): number;
  pollerPeerPorts(token?: string): number[]; // remote ports of in-flight getUpdates
  setWebhook(url: string | null, token?: string): void; // what getWebhookInfo reports
  failNext(method: string, failure: FakeTelegramFailure, count?: number): void;
  delay(method: string, ms: number): void;
  close(): Promise<void>;
}
export function startFakeTelegram(opts?: FakeTelegramOptions): Promise<FakeTelegramServer>;
export function telegramPrivateMessage(from: TgUser, text: string, o?: { messageId?: number; date?: number }): Record<string, unknown>;
export function telegramGroupMessage(chat: TgChat, from: TgUser, text: string,
  o?: { messageId?: number; mention?: string; replyTo?: { messageId: number; fromBot?: FakeTelegramBot; text?: string };
        messageThreadId?: number; isTopicMessage?: boolean; caption?: boolean }): Record<string, unknown>;
export function telegramCallback(from: TgUser, message: { chatId: number; messageId: number; chatType?: string;
  messageThreadId?: number }, data: string, o?: { id?: string }): Record<string, unknown>;
export function findTelegramButton(replyMarkup: unknown, pred: (b: { text: string; callback_data?: string; url?: string }) => boolean):
  { text: string; callback_data?: string; url?: string } | undefined;
export function telegramWebhookHeaders(secret: string): Record<string, string>;
export type TgUser = { id: number; first_name: string; last_name?: string; username?: string; is_bot?: boolean };
export type TgChat = { id: number; type: "private" | "group" | "supergroup"; title?: string; is_forum?: boolean };
```

Behavior the fake must have (one test each):
- Routes `POST|GET /bot<token>/<method>`; unknown token → 401 `{ok:false,error_code:401,description:"Unauthorized"}`.
- Methods: `getMe` (incl. `can_read_all_group_messages`, `has_topics_enabled`), `getWebhookInfo`
  (`url` from `setWebhook`), `getUpdates` (offset confirms lower ids, `timeout` long-polls until a push or
  timeout, `allowed_updates` filters; while a webhook is set → 409 "can't use getUpdates method while
  webhook is active"; a second concurrent `getUpdates` for the same token → the **earlier** one gets 409
  "Conflict: terminated by other getUpdates request", like Telegram), `sendMessage` (assigns increasing
  `message_id` per chat, text > 4096 → 400 "Bad Request: message is too long"), `editMessageText`
  (same text → 400 "Bad Request: message is not modified"), `answerCallbackQuery`.
- `failNext` returns the failure envelope with `parameters.retry_after` / `migrate_to_chat_id`.

- [ ] **Step 1:** write `fake-telegram.test.ts` covering each bullet above (e.g.
  `it("a second getUpdates for the same token ends the first with 409")`).
- [ ] **Step 2:** `pnpm exec vitest run packages/testing/test/fake-telegram.test.ts` — Expected: FAIL (module missing).
- [ ] **Step 3:** implement `fake-telegram.ts` (Node `http`, pattern of `fake-slack.ts`; long-poll waiters
  resolved on `push`, no leaked timers after `close`). Export from `index.ts`.
- [ ] **Step 4:** run the test — Expected: PASS. Then `pnpm lint && pnpm typecheck && pnpm check`.
- [ ] **Step 5:** add the fake to the table in core's `writing-channels` skill; changeset (minor,
  testing). **Commit** `feat(testing): fake Telegram Bot API`; PR via `contributing`.
- [ ] **Step 6 (gate):** maintainer merges and releases; note the testing version (≥ rc.9). Part 3
  Tasks 3–9 may be developed before the release against a local link
  (`pnpm add -D link:<core>/packages/testing` in the worktree, never committed); the plugins PR merges
  only after the release.

## Part 3 — plugins PR: the plugin (branch `feat/telegram`, rebased on main after Part 1)

All files under `plugins/telegram/`. Unit tests call factories directly against `startFakeTelegram`.

### Task 3: Package skeleton, config, Bot API client, error mapping

**Files:**
- Create: `package.json` (name `@capybara-hq/plugin-telegram`, version `0.1.0-rc.0`, deps
  `@capybara-hq/plugin-sdk`, `zod`; devDeps testing, model-fake — copy `plugins/slack/package.json`
  shape), `tsconfig.json` (copy slack), `.capybara-plugin/plugin.json` (displayName `{zh:"Telegram",en:"Telegram"}`,
  description `{en, zh}`), `src/index.ts`, `src/config.ts`, `src/api.ts`, `src/errors.ts`, `src/wait.ts`
- Modify: root `tsconfig.json` (reference `plugins/telegram`), `pnpm-lock.yaml`
- Test: `test/api.test.ts`, `test/errors.test.ts`

**Interfaces — Produces:**
```ts
// config.ts
export const TelegramDeployment: z.ZodObject // { apiUrl: url, default "https://api.telegram.org" }
export const TelegramConnection: z.ZodObject // { botToken: secret(/^\d+:[A-Za-z0-9_-]+$/), webhookSecret?: secret(/^[A-Za-z0-9_-]{1,256}$/) }
export type TelegramConnectionConfig = z.infer<typeof TelegramConnection>;
export const botIdOf: (token: string) => string; // digits before ":"
export const SENDER_TENANT = "global";
export const connectionTenant: (botId: string | number) => string; // "bot" + id
// api.ts
export class TelegramApiError extends Error { method: string; status?: number; errorCode?: number;
  description?: string; retryAfterSec?: number; migrateToChatId?: number; network: boolean }
export interface TelegramApi { call<T>(method: string, params?: Record<string, unknown>, signal?: AbortSignal): Promise<T> }
export function telegramApi(o: { apiUrl: string; token: string; timeoutMs?: number /* 15000 */ }): TelegramApi;
// errors.ts
export function toChannelSendError(e: unknown): ChannelSendError; // spec "Errors" table
// wait.ts: export const pause (copy of lark)
```

- [ ] **Step 1: failing tests.** `api.test.ts`: `call("getMe")` returns `result`; a 401 throws
  `TelegramApiError{status:401,errorCode:401}` with message `Telegram getMe failed: 401 Unauthorized`;
  429 carries `retryAfterSec`; a refused connection (fake closed) throws `network: true` and
  `expect(String(err) + JSON.stringify(err) + String(err.cause ?? "")).not.toContain(token)` (Review
  Focus 1). `errors.test.ts`: table-driven over the spec table — 429→retryable with
  `retryAfterMs: 3000` for `retry_after: 3`; 5xx/network→retryable; 401→`auth`; 403 "bot was blocked
  by the user" / "bot was kicked" / "bot can't initiate conversation with a user"→`target_gone`;
  400 "chat not found" or `migrateToChatId`→`target_gone`; 400 "message is too long"→`too_large`;
  other 400→`rejected`; none retryable except the retryable rows.
- [ ] **Step 2:** run `pnpm exec vitest run plugins/telegram` — Expected: FAIL.
- [ ] **Step 3:** implement. `call` POSTs JSON to `${apiUrl}/bot${token}/${method}`, timeout via
  `AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])`; errors are built from `method` and the
  JSON envelope only, `cause` omitted for network errors. `index.ts`: `defineExtension({ name:
  "telegram", version: "0.1.0-rc.0", sdk: "^0.1.0-rc.4", provides: [CHANNEL_EXTENSION_POINT],
  permissions: { network: ["api.telegram.org"] }, config: { deployment: TelegramDeployment }, setup })`
  providing `createTelegramChannel({ apiUrl, log: ctx.log, kv: ctx.kv })` (Task 7).
- [ ] **Step 4:** tests PASS; `pnpm typecheck`.
- [ ] **Step 5: Commit** `feat(telegram): package, config and Bot API client`.

### Task 4: Markdown → Telegram HTML, splitting, mention neutralising

**Files:** Create `src/html.ts`; Test `test/html.test.ts`

**Interfaces — Produces:**
```ts
export const TEXT_LIMIT = 4096;
export function markdownToTelegramHtml(md: string): string;
export function escapeHtml(s: string): string;          // & < >
export function splitHtml(html: string, limit?: number): string[]; // never splits inside a tag/entity; closes and reopens open tags (b,i,s,u,code,pre,a,blockquote)
export function neutraliseMentions(text: string): string; // "@x" → "@⁠x" outside code
```
Supported: bold, italic, strikethrough, inline code, fenced code (`<pre><code class="language-x">`),
links, blockquote, headings → bold line, lists → `•` / kept numbers. Lengths are counted on visible
text (after entity parsing), matching Telegram's limit.

- [ ] **Step 1: failing tests:** `<script>` / `a < b & c` escaped; `[x](https://e.com)` → `<a href="https://e.com">x</a>`;
  `[x](tg://user?id=1)`, `javascript:`, images stay plain escaped text; `"ping @everyone_team"` →
  contains `@⁠everyone_team`; `` `@alice` `` inside code unchanged; a 10 000-char text with bold
  spans splits into parts each ≤ 4096 visible chars, each part well-formed (tags balanced); a code block
  over the limit splits into several `<pre>` parts.
- [ ] **Step 2:** run — FAIL. **Step 3:** implement (pattern of `plugins/slack/src/mrkdwn.ts`).
- [ ] **Step 4:** PASS. **Step 5: Commit** `feat(telegram): markdown to Telegram HTML`.

### Task 5: Inbound parsing and thread records

**Files:** Create `src/inbound.ts`, `src/threads.ts`; Test `test/inbound.test.ts`, `test/threads.test.ts`

**Interfaces — Produces:**
```ts
// threads.ts (kv = ExtensionContext["kv"]; all writes TTL 30 days)
export interface ThreadStore {
  threadOfMessage(chatId: string, messageId: number): Promise<string | undefined>; // thread/<bot>/<chat>:<id>
  recordSent(chatId: string, messageId: number, threadId: string): Promise<void>;
  topicOf(threadId: string): Promise<number | undefined>;                         // topic/<bot>/<threadId>
  recordTopic(threadId: string, messageThreadId: number): Promise<void>;
}
export function threadStore(kv: Kv | undefined, botId: string): ThreadStore; // no kv → lookups miss, writes no-op
// inbound.ts
export interface BotIdentity { id: number; username: string }
export async function updateToInbound(update: unknown, bot: BotIdentity, threads: ThreadStore): Promise<InboundEvent | null>;
```
Rules: spec "Inbound rules" and "Threads". `message` and `callback_query` only (callback parsing is
delegated to Task 6's `parseCallback`; until then return null for callbacks). Mention detection uses
entities (`mention` text compared case-insensitively to `@username`; `text_mention.user.id == bot.id`;
`bot_command` ending in `@username`). Stripping keeps the leading `/` and turns `/cmd@bot` into `/cmd`.
`displayName` = `first_name + " " + last_name` trimmed.

- [ ] **Step 1: failing tests:** private text → `{type:"message", messageId:"<chat>:<id>", target:{chatId, chatType:"dm"}, sender:{externalId:"42", tenantId:"global", displayName:"Ann Lee"}, mentionsBot:true}`;
  group `@MyBot hi` with bot username `mybot` → message, text `hi`, no `threadId` (Review Focus 3);
  group text without mention → null; group reply to a bot message whose id is recorded under thread T
  → `threadId: T`, `mentionsBot: true`; reply to the root message itself → `threadId` = root id;
  `@mybot /fix 12` → text `/fix 12`; `/new@mybot` in private → `/new`; caption-only photo → caption
  text; photo without caption → null; `message_id: 0` → null; `from.is_bot` → null; `edited_message`
  → null; `migrate_to_chat_id` service message → null (logged by caller); forum topic message
  mentioning the bot → no `threadId`, and after `recordTopic` the topic is retrievable; every event's
  `sender.tenantId === "global"`.
- [ ] **Step 2:** run — FAIL. **Step 3:** implement. When an inbound group message roots or continues a
  thread inside a topic, `updateToInbound` calls `recordTopic(threadId ?? messageId, message_thread_id)`.
- [ ] **Step 4:** PASS. **Step 5: Commit** `feat(telegram): inbound messages and thread records`.

### Task 6: Cards and callback tokens

**Files:** Create `src/cards.ts`, `src/actions.ts`; Test `test/cards.test.ts`, `test/actions.test.ts`

**Interfaces — Produces:**
```ts
// actions.ts
export const CALLBACK_PREFIX = "cb:";
export interface CardTokenStore { put(a: CardAction): Promise<string>; take(token: string): Promise<CardAction | null> } // card/<bot>/<token>, TTL 30 days; take = get (not delete: clicks may repeat; kernel dedupes)
export function cardTokenStore(kv: Kv | undefined, botId: string): CardTokenStore;
export function decodeCardAction(json: string): CardAction | null; // strict, per skill
export async function parseCallback(update: unknown, tokens: CardTokenStore, threads: ThreadStore):
  Promise<{ event: InboundEvent; callbackQueryId: string } | null>;
// cards.ts
export interface TelegramPost { html: string; replyMarkup?: { inline_keyboard: unknown[][] } }
export async function renderCards(cards: ChannelCard[], locale: Locale, tokens: CardTokenStore): Promise<TelegramPost[]>;
```
Rendering: approval pending → one button per scope (labels zh/en: 批准一次 / Approve once, 本会话批准 /
Approve for session, 总是批准 / Always approve; 拒绝 / Deny) + URL button 在网页上查看 / Open on web;
other states → state line + URL button. Question: single-select inline (one button per option, max 5);
multi-select or not `questionRenderableInline` → URL button only (my call: no toggle state in
Telegram). Connect / bind → URL button. Card text from `renderCardAsText` minus the link lines,
converted with Task 4. URL buttons only for http(s). No kv (tokens unavailable) → URL button only.

- [ ] **Step 1: failing tests:** `callback_data` is `"cb:"` + 16 base64url chars (≤ 64 bytes); token
  round trip returns the same `CardAction`; unknown token / non-`cb:` data / tampered JSON
  (`scope:"forever"`, wrong kind) → null; callback in a group message whose message id is in the
  thread store → `target.threadId` set; `eventId` = callback query id, `messageId` = `<chat>:<card msg id>`;
  multi-select question renders no callback buttons; `javascript:` webUrl → no URL button (card still
  renders text); all four card kinds produce valid HTML per Task 4 escaping (display names with `<b>`
  escaped).
- [ ] **Step 2:** run — FAIL. **Step 3:** implement; wire `parseCallback` into `updateToInbound`.
- [ ] **Step 4:** PASS. **Step 5: Commit** `feat(telegram): inline keyboard cards`.

### Task 7: The channel: verify, send, update

**Files:** Create `src/channel.ts`; Test `test/channel.test.ts`

**Interfaces — Produces:**
```ts
export const MIN_EDIT_INTERVAL_MS = 3000;
export interface TelegramChannelOptions { apiUrl: string; log: Logger; kv?: ExtensionContext["kv"];
  requestTimeoutMs?: number; pollTimeoutSec?: number /* 25 */; backoffBaseMs?: number /* 1000 */ }
export function createTelegramChannel(o: TelegramChannelOptions): Channel;
```
`features: { cards: true, edit: true, threads: true, minEditIntervalMs: 3000 }`. `connect` and
`webhook` come from Tasks 8–9 (stub `connect` throwing until then).

- [ ] **Step 1: failing tests:** `verify` → `{botUserId:"<id>", botName:"@<username>", tenantId:"bot<id>"}`
  and `tenantId !== "global"`; warns (log spy) when `canReadAllGroupMessages` or `hasTopicsEnabled`;
  `send` dm → `sendMessage` with `parse_mode:"HTML"`, `link_preview_options:{is_disabled:true}`, returns
  `"<chat>:<id>"`; long text → several messages, returns the last id; group with `threadId` →
  `reply_parameters:{message_id:<root>, allow_sending_without_reply:true}` and every sent message
  (text and card) recorded in the thread store (Review Focus 2); with a topic record →
  `message_thread_id`; cards → one message per card after the text with `reply_markup`; `update` →
  `editMessageText`; "message is not modified" → resolves; over limit → `too_large`; 403 blocked →
  `target_gone`; `idempotencyKey` ignored.
- [ ] **Step 2:** run — FAIL. **Step 3:** implement. **Step 4:** PASS.
- [ ] **Step 5: Commit** `feat(telegram): verify, send and update`.

### Task 8: Long polling `connect`

**Files:** Create `src/poll.ts`; Modify `src/channel.ts`; Test `test/poll.test.ts`

**Interfaces — Produces:** `export async function runLongPolling(a: { api: TelegramApi; bot: BotIdentity; connectionId: string; onEvent; signal; log; kv?; threads; tokens; pollTimeoutSec; backoffBaseMs }): Promise<void>`

Behavior: spec "Long polling". `getMe` first (bot identity), then `getWebhookInfo` (url set → throw
`"A webhook is set for this Telegram bot; switch the connection to webhook mode or call deleteWebhook"`).
Offset start: kv `offset/<bot>` else none. Per update: parse → `onEvent` → on resolve
`answerCallbackQuery` (callbacks, best-effort, errors logged) and advance; on reject stop the batch,
`pause(backoff)`, refetch. 409 / 401 → throw (`Telegram getUpdates conflict: another client is polling
this bot` / `Telegram bot token rejected`). Network / 5xx → jittered backoff (cap 30 s), 5 in a row
throw. Return promptly on abort (the pending `getUpdates` is aborted by `signal`).

- [ ] **Step 1: failing tests:** two pushed messages → two `onEvent` calls in order and
  `confirmedOffset` past both; `onEvent` rejecting the 2nd of 3 updates → 3rd not delivered, offset
  confirms only the 1st, after the rejection clears all are delivered once (Review Focus 4); webhook
  set → rejects with the message above; 409 → rejects; abort → resolves within 1 s; offset stored in
  kv and a new `connect` resumes from it; callback → `answerCallbackQuery` recorded after `onEvent`;
  token never in any thrown message.
- [ ] **Step 2:** run — FAIL. **Step 3:** implement. **Step 4:** PASS.
- [ ] **Step 5: Commit** `feat(telegram): long polling`.

### Task 9: Webhook inbound

**Files:** Create `src/webhook.ts`; Modify `src/channel.ts`; Test `test/webhook.test.ts`

**Interfaces — Produces:** `export async function handleTelegramWebhook(a: { config: TelegramConnectionConfig; request: ChannelWebhookRequest; toEvent: (update: unknown) => Promise<InboundEvent | null> }): Promise<ChannelWebhookResult>`

Behavior: spec "Webhook". The bot identity for parsing comes from kv `bot/<bot>` (TTL 1 h) else
`getMe`. The webhook contract gives the plugin no hook after the kernel's `onEvent`, so in webhook
mode `answerCallbackQuery` is called (best-effort) inside `toEvent` before returning; documented
trade-off: the client's spinner stops even if the kernel then answers 503 and Telegram redelivers.

- [ ] **Step 1: failing tests:** missing / wrong secret header → `reject` 401 (constant-time compare);
  no `webhookSecret` configured → 401; correct secret + non-JSON body → 400; correct secret + JSON
  without `update_id` → 400 (Review Focus 5); valid message update → `events` with the same
  `messageId` the long-poll parser yields for the same update; ignored update → `events: []`.
- [ ] **Step 2:** run — FAIL. **Step 3:** implement. **Step 4:** PASS.
- [ ] **Step 5: Commit** `feat(telegram): webhook inbound`.

### Task 10: Dual-replica kernel tests

**Files:** Create `test/kernel/telegram.dual.test.ts`, `test/kernel/telegram-webhook.dual.test.ts`
(harness setup copied from `plugins/slack/test/kernel/slack.dual.test.ts`, agent with
`disabledTools: []`, model-fake scripts `echo:` and `tool:` as Slack does).

- [ ] **Step 1:** write cases: (a) exactly one poller (`maxConcurrentPollers() === 1`) across both
  replicas; (b) private message from an unbound user → bind card with URL button; bind via
  `POST /api/v1/bind/<token>`; (c) next message → streamed reply: one `sendMessage` then edits, final
  text exact; (d) group mention → reply sent with `reply_parameters` to the mention; reply to the bot's
  reply continues the same conversation (one conversation in the DB); (e) `tool:` call needing approval
  → approval card in the group thread; click via `telegramCallback` with the button's `callback_data`
  → card edited to approved, final reply delivered once, `callbackAnswers` contains the query id;
  (f) kill the replica owning `pollerPeerPorts()[0]` (`pidOwningLocalPort`) → the other replica polls,
  a new message is answered once; (g) connection `PATCH { unboundPolicy: "anonymous" }` → a new unbound
  user's private message gets the bind card, no agent run; (h) webhook mode
  (`PATCH { inboundMode: "webhook" }`, fake `setWebhook`), a POST with `telegramWebhookHeaders` → one
  reply; the same update posted twice → one run.
- [ ] **Step 2:** `pnpm exec vitest run plugins/telegram/test/kernel` — fix until PASS (product bugs in
  the plugin, never retries).
- [ ] **Step 3: Commit** `test(telegram): dual-replica kernel acceptance`.

### Task 11: Live tests, README, marketplace, repo docs

**Files:** Create `test/live/telegram.live.test.ts`, `README.md`; Modify
`.capybara-plugin/marketplace.json` (via `marketplace --write`), root `README.md` (plugin table),
`AGENTS.md` (references list, live env names), `.agents/skills/writing-channels/SKILL.md`
(reference implementations, fake table, live env names).

- [ ] **Step 1:** live test gated on `CAPYBARA_TEST_LIVE_TOOLS=1` and
  `CAPYBARA_TEST_TELEGRAM_BOT_TOKEN` + `CAPYBARA_TEST_TELEGRAM_CHAT_ID` (optional
  `CAPYBARA_TEST_TELEGRAM_GROUP_ID`): `verify`; `send` a message, `update` it, a 5000-char split send,
  a card with buttons (no click); group variant when the group id is set. Never print the token.
- [ ] **Step 2:** README per spec (BotFather steps: `/newbot`, privacy mode note, `/setjoingroups`;
  "press Start once" for binding; anonymous policy has no effect; topics in private chats unsupported;
  webhook: the `setWebhook` call with `secret_token` and `allowed_updates=["message","callback_query"]`,
  `deleteWebhook` to switch back; every limit with source and date 2026-11-08; idempotency trade-off).
- [ ] **Step 3:** `pnpm exec capybara-plugin marketplace --write`; update the docs listed above.
- [ ] **Step 4:** `pnpm lint && pnpm typecheck && pnpm check && pnpm check:marketplace && pnpm exec vitest run plugins/telegram` — all PASS.
- [ ] **Step 5:** maintainer supplies the bot token in `~/.capybara-test.env`; run
  `set -a; . ~/.capybara-test.env; set +a; CAPYBARA_TEST_LIVE_TOOLS=1 pnpm exec vitest run plugins/telegram/test/live`
  (never echo the file). Record the result in the README's "verified live" line.
- [ ] **Step 6: Commit** `docs(telegram): README, marketplace entry and live tests`; raise testing to
  the Part 2 release, rerun Step 4, open the PR via `contributing`.
