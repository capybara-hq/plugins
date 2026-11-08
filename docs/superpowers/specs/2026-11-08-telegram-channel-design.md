# Telegram channel plugin: design

Date: 2026-11-08. Status: for maintainer approval.

## Intent

Teams want to talk to Capybara agents from Telegram, both in a private chat with a bot and by
mentioning the bot in a group. Today Capybara ships Slack and Lark channels; Telegram is the next
IM. This plugin is a messaging channel only.

Success: the maintainer runs a real bot (token supplied by the maintainer) and, in both a private
chat and a group, binds an account, gets a streamed reply, and approves a tool call from a card.
The live test suite passes against that bot.

The same branch also fixes the out-of-date kernel test fixtures in other plugins (see "Bundled
fix" below), because the new plugin's tests need the same `@capybara-hq/testing` upgrade.

## Goals

- `@capybara-hq/plugin-telegram`, providing `channel@1` only.
- Private chats: every text message goes to the kernel.
- Groups and supergroups: messages that mention the bot, and replies to the bot's messages, go to
  the kernel; replies stay in one conversation (see Threads).
- Cards (approval, question, connect, bind) as Telegram inline keyboards; clicks come back as
  `card_action`.
- Streaming replies by sending a message and editing it.
- Inbound by long polling (`getUpdates`, default, no public URL needed) or by webhook (optional,
  through the kernel's existing webhook route).
- README in the granularity of `plugins/slack/README.md`: bot setup with BotFather, every trade-off
  with its doc source and lookup date.
- Unit tests, dual-replica kernel tests, and a live test suite.

## Non-goals

- No `identity-source@1` (login with Telegram): Telegram login gives no email, its widget does not
  fit the kernel's redirect / callback flow well, and binding through the bot already links a
  Telegram user to an account. Decided by the maintainer.
- No `directory@1`: the Bot API cannot list group members, and Telegram has no organization
  concept. Decided by the maintainer.
- No proxy support for networks where `api.telegram.org` is unreachable. Decided by the
  maintainer. (`apiUrl` stays configurable, which also covers a reverse proxy.)
- No attachments, media, voice, stickers, polls, inline mode, business accounts, channels
  (broadcast channels), or `sendMessageDraft` streaming (see Streaming).
- No kernel changes.

## Anti-goals

- **Anonymous guests must never work on Telegram.** A Telegram bot is reachable by anyone who
  finds it; anonymous access would let the whole internet use an org's agent and model budget.
  Every person binds a Capybara account first. Decided by the maintainer.
- Model text must never be able to mention or notify people it was not meant to, or produce
  non-http(s) links.
- Tokens never appear in logs, errors or `last_error`. Note: the Bot API puts the token in the URL
  path (`/bot<token>/method`), so every error message and log line must be built without the URL.

## Constraints

- Follow `.agents/skills/writing-channels/SKILL.md` and `writing-extensions` in this repository.
  Everything there applies unless stated here.
- Multi-replica rules: no timers, no module-level state; waits use abortable `AbortSignal.timeout`
  (Lark's `wait.ts` pattern); shared state only in `ctx.kv` with a TTL.
- Telegram Bot API facts used below were read from <https://core.telegram.org/bots/api> (Bot API
  10.3) on 2026-11-08; the README must cite them with that date.

## Decisions

### Identity and tenant

- Telegram user ids are global (the same person has the same id for every bot), so the identity is
  `telegram:global` + the Telegram user id (decimal string). One person maps to one identity across
  every Telegram bot in a deployment.
- `sender.tenantId` is always `global`.
- `verify` returns `tenantId: "bot<bot id>"` (anything that is never `global`). The kernel treats
  a sender whose tenant differs from the connection's as external
  (`packages/kernel/src/channels/inbound.ts`, `external = sender.tenantId !== row.tenantId`), and an
  external sender can never be an anonymous guest. This is how the anti-goal is met with no kernel
  change. A unit test pins that `verify`'s tenant never equals the inbound sender tenant, and a
  dual-replica test proves an unbound sender on a connection set to `anonymous` gets the binding
  reply, not an agent run.
- The README states plainly that the `anonymous` unbound policy has no effect for Telegram.

### kv keys

`send` and `update` receive no `connectionId` (SDK `ChannelSendArgs`), so every kv key is scoped by
the **bot id** (the digits before `:` in the token), not the connection. This also means a token
swap on a connection never reuses the old bot's offset. Two connections sharing one bot token share
the records, which is harmless (and long polling would 409 anyway).

### Connection config (`connectionSchema`)

| Field | Notes |
|---|---|
| `botToken` | `secret()`, format `<digits>:<token>` |
| `webhookSecret` | `secret()`, optional, 1–256 chars of `[A-Za-z0-9_-]`; required for webhook mode |

Deployment config: `apiUrl` (default `https://api.telegram.org`), for tests and reverse proxies.
No org-level config.

### `verify`

`getMe`; returns `botUserId` = bot id, `botName` = `@username`, tenant as above. If
`can_read_all_group_messages` is true (privacy mode off), log a warning: the bot then receives
every group message; the plugin still forwards only what the Inbound rules allow.

### Inbound rules

- Private-chat topic mode (`has_topics_enabled`) is not supported: the kernel keys every private
  chat as one thread per user. `verify` logs a warning when it is on; the README says to keep it
  off. (My call.)

- Private chat (`chat.type == "private"`): every text message; `chatType: "dm"`, no `threadId`.
- Group / supergroup: forward messages that mention the bot (a `mention` entity for
  `@<bot username>`, or a `text_mention` / `bot_command` addressed to the bot) and replies whose
  `reply_to_message` is from the bot. Replies to the bot count as `mentionsBot: true` (Telegram
  users address a bot by replying to it). Other group messages are dropped.
- `messageId` = `<chat id>:<message id>`; stable on redelivery. Messages with `message_id == 0`
  (ephemeral or scheduled messages, Bot API 10.2+) send no event: they have no stable id and would
  collide in the kernel's dedupe.
- Text: `text`, or `caption` for media with a caption (media itself ignored); media without a caption
  sends no event. The bot mention is stripped per the skill (keep a leading `/`; `/cmd@botname`
  becomes `/cmd`). Mentions of others become readable `@name`.
- Edited messages, channel posts, messages from bots (`from.is_bot`) and service messages send no
  event.
- `sender.displayName` = first + last name, from the update itself (no extra API call).
  `avatarUrl` is omitted (getting it needs two calls and exposes a token-bearing file URL).
- A `migrate_to_chat_id` (group upgraded to supergroup) is logged; old conversations in that group
  stop receiving replies (`target_gone`), which is acceptable.

### Threads

- `features.threads: true`.
- Plain groups and forum supergroups behave the same (forums: decided by the maintainer): each
  mention that is not a reply starts its own conversation (no `threadId`; the kernel roots a thread
  at it), and replies continue it. A forum topic is only where the messages live, never the
  conversation key, so a topic does not become one ever-growing conversation (`/new` works only in
  private chats).
- Telegram replies only point to their direct parent, so the plugin records the thread of every
  message it sends into a group: kv `thread/<bot id>/<chat>:<sent message id>` = threadId, TTL
  30 days. An inbound reply whose parent is in kv gets that `threadId`; a reply to the root
  message itself gets the root as `threadId`; otherwise no `threadId`.
- Forums: when an inbound message in a topic (`is_topic_message`) roots or continues a thread, the
  plugin records kv `topic/<bot id>/<threadId>` = `message_thread_id`, TTL 30 days, because `send`
  only receives the `threadId` (the root's `messageId`). Outbound group replies are sent with
  `reply_parameters` pointing at the thread root (`allow_sending_without_reply: true`) and, when the
  kv record exists, `message_thread_id`, so they land in the right topic.

### Cards

- `features.cards: true`. Rendered as HTML text plus an inline keyboard. Button labels in the
  org's `locale`. Fallback text from `renderCardAsText`.
- Link buttons (`url`) only for http(s) URLs. Telegram rejects some hosts as button URLs
  (verified 2026-11-08: `http://localhost:…` → 400 "Wrong HTTP URL"; IPs are accepted): on such a
  400 the post is sent (or edited) once more without URL buttons, with the link in the text and
  the callback buttons kept. (Decided in the final review.)
- One Telegram message per card: the message text leads the first card's post unless it repeats a
  card's headline; a card post is truncated to fit, never split, so a card refresh always edits one
  message. (Decided in the final review: the kernel sends cards as a fixed phrase plus the card, and
  a two-post rendering made every question-card refresh fail.)
- `callback_data` is limited to 64 bytes, too small for card id + action + scope + answer. Each
  button gets `callback_data = "cb:" + <random 16-char base64url token>`; kv
  `card/<bot id>/<token>` holds the compact JSON payload (card id, kind, action, scope,
  answer), TTL 30 days. A click whose token is missing or invalid is answered and ignored.
  Payloads are parsed strictly as the skill requires. (Builder may encode inline when it fits in
  64 bytes and skip kv; behavior must be identical.)
- Every `callback_query` is answered with `answerCallbackQuery` (no text) after `onEvent`
  resolves, so the client's progress indicator stops; the answer is best-effort and never blocks
  the ack. Webhook mode has no hook after the kernel accepts, so there the answer is sent before
  returning the events (documented trade-off).
- `card_action`: `messageId` = the card's message, `eventId` = `callback_query.id`, target from
  the message's chat (and thread as above).

### Send, update, formatting

- Markdown converted to Telegram HTML (`parse_mode: "HTML"`); everything else is escaped (`&`, `<`,
  `>`). Link allowlist http(s) only; `tg://` and others stay plain text, so the model cannot
  produce `tg://user?id=` mentions. A raw `@username` in model text would notify group members,
  so the converter neutralises it (a zero-width joiner after `@`, outside code), with injection
  tests like Slack's `<!channel>` ones. (My call.)
- Limit 4096 characters after entity parsing: text-only messages split into several messages,
  return the last id; `update` that does not fit one message throws `too_large`.
- `features.edit: true`, `minEditIntervalMs: 3000` (Telegram allows about 20 messages per minute in
  a group; edits count). On 429 use `parameters.retry_after`.
- `idempotencyKey` ignored (no idempotent send in the Bot API); same trade-off as Slack.
- "message is not modified" on `update` is success.
- Link previews disabled on bot messages.

### Streaming

Edit-based, like Slack and Lark. `sendMessageDraft` exists but only in private chats, is a
30-second ephemeral preview that must be followed by a real `sendMessage`, and does not fit the
kernel's send-then-edit model; out of scope.

### Errors (`ChannelSendError`)

| Telegram | Mapping |
|---|---|
| 429 | retryable, `retryAfterMs` from `retry_after` |
| 5xx, network, timeout | retryable |
| 401 Unauthorized | `auth` |
| 403 (bot blocked, kicked, can't initiate conversation) | `target_gone` |
| 400 chat not found / group migrated | `target_gone` |
| 400 message too long | `too_large` |
| other 400 | `rejected` |

Messages carry the method and Telegram's `error_code` / short description only.

Binding in groups: the kernel sends binding cards only in private chats; a Telegram bot cannot
message a user who never started it (403). The README tells users to open the bot and press Start
once; the kernel's existing handling of `target_gone` applies.

### Long polling (`connect`)

- `connect` never changes webhook state behind the admin's back (no `deleteWebhook`). On start it
  calls `getWebhookInfo`; if a webhook URL is set, it throws an actionable error ("a webhook is set for this bot; switch the connection to webhook mode
  or remove the webhook").
- Loop `getUpdates(offset, timeout=25, allowed_updates=["message","callback_query"])` with the
  request aborted by `signal`.
- Process updates in order; after each update's `onEvent` resolves (or it is ignored), advance the
  offset to `update_id + 1`. If `onEvent` rejects, stop the batch and refetch from that update after a
  short backoff (Telegram keeps updates for 24 hours), never skipping it.
- The confirmed offset is also stored in kv (`offset/<bot id>`, TTL 7 days) so a new holder
  after failover resumes without reprocessing; reprocessing is still safe (kernel dedupe).
- 409 Conflict (another `getUpdates` consumer, e.g. the same token used elsewhere) and 401 throw,
  so the kernel records `last_error`. Network errors back off with jitter (cap 30 s); 5 consecutive
  failures throw.

### Webhook (`Channel.webhook`)

- Reject (401) unless `x-telegram-bot-api-secret-token` equals `webhookSecret` (constant-time
  compare); no secret configured → reject everything.
- Parse the single update with the same parser as long polling, so ids and dedupe match.
- Kernel acks (200) after `onEvent`; non-2xx makes Telegram retry.
- The plugin does not call `setWebhook` itself; the README gives the one `setWebhook` call
  (URL from the connection page, `secret_token`, `allowed_updates`). Switching back to long polling
  needs `deleteWebhook`, also in the README.

### Permissions manifest

`network: ["api.telegram.org"]`.

## Testing

- **Fake server:** `startFakeTelegram()` in `@capybara-hq/testing`, following the skill's rule that
  fake platforms live there (decided by the maintainer). Order: the bundled fix lands first on
  testing rc.8; then a core PR adds the fake server and the maintainer releases it; then the
  Telegram plugin raises testing to that release and merges. The fake covers: Bot API methods
  used here, long polling with offsets, webhook signing helper, `failNext` for 401/403/429/409,
  recorded `answerCallbackQuery` calls, builders `telegramPrivateMessage`, `telegramGroupMention`,
  `telegramReply`, `telegramCallback`, `findTelegramButton`.
- **Unit tests** per the skill's list, plus: tenant never `global` in `verify`; reply-to-bot in a
  group counts as a mention; thread lookup through kv; callback token round trip and strict
  parsing; offset advances only after `onEvent` resolves; webhook set → `connect` throws; token
  never appears in any error text (a test greps errors for the token).
- **Dual-replica kernel tests:** one long poller per connection across replicas, failover after
  killing the holder, binding, streamed reply, approval card click and card update each delivered
  once, webhook mode, and the anonymous-policy refusal.
- **Live tests** (`CAPYBARA_TEST_LIVE_TOOLS=1`, `CAPYBARA_TEST_TELEGRAM_BOT_TOKEN`,
  `CAPYBARA_TEST_TELEGRAM_CHAT_ID`, optional `CAPYBARA_TEST_TELEGRAM_GROUP_ID`): `getMe`, send, edit,
  split, a card with buttons. Keys from the local env file, never printed.

## Bundled fix

Core replaced the agent definition field `tools` with `disabledTools` (every tool on unless turned
off). With `@capybara-hq/testing` 0.1.0-rc.8, kernel tests that create agents with `tools` fail with
400 `validation_failed`. In the same branch:

- Raise `@capybara-hq/testing` to the latest release (and `plugin-sdk`, `plugin-model-fake` to
  match) in the root and every plugin that uses it; update the lockfile.
- Replace `tools: [...]` in agent definitions with `disabledTools: []` in
  `plugins/slack/test/kernel/*` (4 files, verified passing after the change),
  `plugins/lark/test/kernel/*`, `plugins/connector-mcp/test/kernel/mcp-e2e.test.ts`,
  `plugins/connector-openapi/test/kernel/openapi-e2e.test.ts`; check that each `tools:` hit is an
  agent definition before changing it.
- No plugin source changes, so no changesets for these.

## Left to the builder

Module layout (follow Slack / Lark), HTML conversion details, backoff constants not stated above,
exact error wording, README structure, and whether to encode small callback payloads inline.
