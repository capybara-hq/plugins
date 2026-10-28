---
name: writing-channels
description: 'Use when creating or modifying an IM channel, third-party login or directory sync extension in this repository (provides channel@1 / identity-source@1 / directory@1, e.g. plugins/slack, plugins/lark): the identity key <plugin>:<tenant>, inbound event conventions (messageId / threadId / tenantId, stripping the bot @, ack only after onEvent resolves, card_action), self-managed reconnection, optional webhook inbound (Channel.webhook.handle, signature and challenge), send / update, ChannelSendError and features, the card spec (validateChannelCard, renderCardAsText), preventing @everyone and the link allowlist, what the kernel guarantees (leader election, dedupe, durable queues, card re-authorization), PKCE and ID tokens, directory pagination and incomplete listings, and tests with startFakeChannelServer / startFakeSlack / startFakeLark, dual-replica and live tests.'
---

# Writing channel, login and directory extensions

An IM platform is usually one extension offering all three extension points, sharing **the same identity key**:

| Extension point | Contract (SDK) | Config level | Enabled per org |
|---|---|---|---|
| `channel@1` (bot) | `channel.ts`, cards in `cards.ts` | one per **channel connection** (`connectionSchema`, created by an org admin under "Channels") | yes (`orgScoped`) |
| `identity-source@1` (web login) | `identity.ts` | **deployment-level** (`config.deployment`, enabled through the kernel config `auth.loginSources`) | no |
| `directory@1` (directory sync) | `directory.ts` | **org-level** (`config.org`) | yes (`orgScoped`) |

General extension authoring (manifest, two-level config, multi-replica rules, approval) is in `.agents/skills/writing-extensions`; this skill covers what is specific to these three extension points. The kernel side (gateway role, leader election and sharing, durable queues, dedupe, the webhook route, the login flow, the directory sync guards) is core's: [writing-channels in core](https://github.com/capybara-hq/core/tree/main/.agents/skills/writing-channels).

Reference implementations:

- `plugins/slack`: Socket Mode, Block Kit, Sign in with Slack (OIDC, validating the ID token), `users.list` directory, webhook inbound.
- `plugins/lark`: the Lark long connection (official SDK `WSClient`), JSON 2.0 interactive cards, OAuth authorization code + PKCE, a directory traversed by department, webhook inbound.
- The `fake-im` extension of `@capybara-hq/testing` (`fakeExtensionDir("fake-im")`): the minimal shape against `startFakeChannelServer`; read it before the real extensions.

The two plugins' READMEs (`plugins/slack/README.md`, `plugins/lark/README.md`) list the platform doc source and every trade-off; follow that granularity for a new platform.

## Identity key (look at this first)

- An identity is `"<plugin name>:<tenant id>"` + the platform user id. Login, channel inbound and directory must all derive **the same** key, so one person maps to exactly one identity and one account (Slack: `slack:<team id>` + `U…`; Lark: `lark:<tenant_key>` + `open_id`).
- The tenant definition must agree in all places: the `tenantId` returned by `verify`, the inbound `sender.tenantId`, `ExternalIdentity.tenantId`, `DirectoryMember.tenantId`. Slack uses the team id (under Enterprise Grid the workspace team, **not** the enterprise `E…`, else one person splits in two); Lark uses `tenant_key`.
- For platforms whose user ids differ per app (Lark's `open_id`): login, bot and directory must be the same app; check this automatically where possible (see the Lark README).

## `channel@1`

```ts
interface Channel {
  connectionSchema: ZodTypeAny;            // use secret() for secret fields
  features: { cards: boolean; edit: boolean; threads: boolean; minEditIntervalMs?: number };
  verify(args): Promise<{ botUserId; botName; tenantId }>;
  connect(args: ChannelConnectArgs): Promise<void>;   // long connection loop
  send(args: ChannelSendArgs): Promise<{ messageId: string }>;
  update(args: ChannelSendArgs & { messageId: string }): Promise<void>;
  webhook?: { handle(args): Promise<ChannelWebhookResult> };   // optional webhook inbound
}
```

### Conventions for inbound events (`InboundEvent`)

- **`messageId` is unique and stable within the connection** (the same when the platform redelivers): the kernel dedupes by it. Slack `<channel>:<ts>`, Lark `message_id`.
- **In a group chat, `target.threadId` = the `messageId` of the thread's root message** (exactly the string sent as `messageId` for the root), not another platform thread id (Lark: the `om_…` of `root_id`, not the `omt_…` of `thread_id`). Not in a thread: omit `threadId` (the kernel uses this message's `messageId` as the thread key and replies into the thread rooted at it). Direct messages carry none.
- **`sender.tenantId`** is the speaker's enterprise (same definition as above). People from another tenant (external contacts, shared channels, other Grid workspaces) can only bind, never act as anonymous guests.
- **`sender.displayName` / `avatarUrl`**: include them if you can (Slack: the event's `user_profile`, else `users.info`; Lark: the user info API), with a short timeout; leave them out rather than miss the platform's ack deadline. The kernel shows the name on the binding page (anti-phishing).
- **`text` has the bot @ stripped**, and `mentionsBot` says whether the bot was mentioned; only tidy the spaces around the @, keep newlines and indentation (code blocks). Mentions of other people become a readable `@name`.
- **Commands are the kernel's** (never parse them): a direct message `/new` starts a new conversation; a text starting with `/name args` (or `/<plugin>:<name>`) that names a skill the person may invoke is posted as a skill invocation, else as text. So keep the leading `/` exactly where the person typed it when stripping the @. Slack treats a message starting with `/` as a slash command, so invocation works after a mention (`@bot /fix-issue 12`); Lark passes the text through. Cover this in `plugins/<name>/test/channel.test.ts`.
- **Text only**: attachments are ignored, and a message with only attachments sends no event (for a file share with a caption, only the caption).
- **Edits and recalls send no event**; messages from this bot and other bots are ignored.
- In group chats forward thread replies faithfully (including `mentionsBot: false`); the kernel currently handles only group messages that mention the bot.
- **`card_action`**: `messageId` = the message the card is in; `eventId` = the platform's unique id for this click if available (Slack `<channel>:<card ts>:<clicker>:<action_ts>`, Lark callback `header.event_id`), used for dedupe; in group chats include `target.threadId` if you can.
- **`target.chatType` of a click is only a hint**: the kernel checks the click's chat against the target recorded when the card was sent and uses the **recorded** type, chat and thread, so a tampered callback value or a forwarded card has no effect.
- `directory_changed`: when the platform pushes personnel changes (Slack `team_join` / `user_change`, Lark `contact.user.*_v3`), send `{ type: "directory_changed", tenantId }`; the kernel batches them into a directory sync.

### `connect` and acknowledgement

- `onEvent` is the kernel's: it dedupes (`message` by `messageId`, `card_action` by `eventId`, 24 hours) and durably enqueues, returning quickly. **Resolving means the kernel has reliably received it.**
- **Acknowledge to the platform only after `onEvent` resolves**; on reject **don't acknowledge** (Lark's handler rethrows and the SDK answers 500), so the platform redelivers. Never retry `onEvent` yourself, and do no slow work before it (Slack and Lark ack deadlines are a few seconds).
- Ignored events are acknowledged directly.
- `connect` returns only when `signal` aborts. If it throws or returns early, the kernel records the connection's `last_error`, backs off exponentially (up to 5 minutes) and some replica retries.
- `connect` handles one connection and never decides "whether I should connect": the kernel picks the holder. When the extension is disabled or upgraded, the kernel aborts the old instance's `connect` signal, waits for it to return, and lets the new instance reconnect. So **respond to `signal` promptly and return; never swallow the abort and keep reconnecting**.

### Reconnection

- If the SDK's built-in reconnection swallows errors (Slack SDK 3.1.0 turns a failed `apps.connections.open` into an unhandled rejection; the Lark SDK silently retries on the server's long interval and never returns), **turn it off and write your own loop**: reconnect immediately when the platform recycles a connection normally; on failure or consecutive short-lived connections (under 10 seconds) back off exponentially **with jitter**; after 5 in a row, or when the platform refuses (bad credentials, `link_disabled`, connection limit), **throw**, so the kernel records `last_error` and takes over.
- Wait with an abortable `AbortSignal.timeout` (see `pause` in `plugins/lark/src/wait.ts`), never `setTimeout` (`plugin-timer`).
- When `signal` aborts, close the socket, then return; if it aborts mid-connect, check `signal.aborted` and disconnect (or the connection leaks).

### Webhook inbound (optional, `Channel.webhook`)

Inbound is a **long connection by default**. When the extension implements `Channel.webhook` and the deployment sets `channels.webhookBaseUrl`, an org admin can switch a connection to webhook mode; the platform then calls `POST <channels.webhookBaseUrl>/channels/webhook/<connectionId>` on a gateway replica, and the connection gets no `connect` call.

- **`handle({ connectionId, config, request, signal })`** returns one of (`ChannelWebhookResult`): `respond` (answer directly, no events: the URL-verification challenge), `events` (`InboundEvent`s plus the `ack` response), or `reject` with 400 / 401 / 403 (not genuine; nothing enqueued).
- **Signature verification, decryption, the challenge and timestamp replay checks are the extension's job**; the kernel puts no authentication on the route. `request.body` is the raw bytes (verify over them), `headers` are lower-cased, `receivedAt` is the kernel's receive time. Fail closed: anything not provably genuine is `reject`.
- **The kernel acks only after every event's `onEvent` resolved**; otherwise (or after a 10 s deadline) it answers 503 and the platform redelivers. An empty `events` list just acks.
- **Dedupe uses the same keys as the long connection** (`messageId`, `eventId`): keep them identical in both modes so a redelivery or a mode switch never processes a message twice.
- **Keep it quick**: parse, verify, return; no slow lookups. The kernel caps the body at 1 MiB, answers unknown connections itself, and drops `set-cookie` and framing headers you set.

### `send` / `update`

- `message.text` is Markdown, converted to the platform's native rich text, **not translated**. Over the platform's per-message limit, split into several messages in order and **return the id of the last one** (the kernel edits that one later).
- When `update`'s new text cannot fit one message, throw a non-retryable `ChannelSendError` with `reason: "too_large"`: the kernel then `send`s the full text as a new message. `update` is never called when `features.edit` is false; the kernel sends a new card when a card's state changes, and old buttons get "already handled".
- `features.minEditIntervalMs`: the minimum interval between two edits of a message; streaming drafts update every `max(1000, minEditIntervalMs)` (Slack 2500, Lark 1500).
- `locale` (`"zh" | "en"`, the org's IM language): pick the extension's own fixed wording (buttons, fallback text) by it.
- `idempotencyKey` (optional): at most 40 `[A-Za-z0-9_-]` characters, the same on every retry of one logical message. Pass it through when the platform supports idempotent sending (Lark `uuid`; split messages use `<key>-<i>`), ignore it otherwise (Slack).
- With `features.cards` false, the kernel has already turned each card into Markdown via `renderCardAsText(card, locale)` and appended it to the text; the message has no `cards`. Model-controllable fields are in inline code / fenced code, so the converter must show code content as is. With `cards: true` you get `message.cards` and render native cards; a card you cannot render (e.g. a callback value over the limit) falls back to a link or text.
- With `features.threads` false, targets carry no `threadId` and replies go straight into the chat; each mention in a group then opens its own conversation.
- With `features.edit` false, no streaming draft is sent, only one message at the end.

### Failure classification (`ChannelSendError`)

| Situation | Throw | What the kernel does |
|---|---|---|
| rate limit, platform 5xx, network, timeout | `retryable: true`, with the platform's `retryAfterMs` | retry after backoff (capped attempts) |
| credentials invalid, permission revoked, app disabled | `retryable: false, reason: "auth"` | record the connection's `last_error`, stop this round for the conversation |
| bot removed from the group, group dissolved, user unreachable | `reason: "target_gone"` | stop this round for the conversation, not a poison event |
| content rejected by the platform | `reason: "rejected"` (the default) | skip after 3 failures, best-effort "please handle this on the web" reply |
| still over the limit after splitting / edit too long | `reason: "too_large"` | as above; on `update`, send a new message instead |

Other exceptions count as retryable (a limited number of times). Check with `isChannelSendError` (duck typing, not `instanceof`). The message carries only the step and the platform error code, **never tokens, request headers or response bodies** (`cause` may attach the original error, which must not contain credentials either; see Lark's header-free errors).

Sub-agents' approvals and questions arrive as ordinary `approval` / `question` cards in the parent conversation's thread; nothing changes for the extension.

## Card spec (`cards.ts`)

`ChannelCard` is produced by the kernel; the extension renders it natively:

| `kind` | Content | Interaction |
|---|---|---|
| `approval` | title, tool / connector, agent, argument preview (redacted by the kernel, ≤500 characters), optional `scopes`, `expiresAt`, `state`, `decidedBy`, `webUrl` | when `pending`, one approve button per scope + reject + web link; otherwise no buttons, only the state and a "details" link |
| `question` | `form` (`InputForm`), `state`, `answerSummary`, `webUrl` | when `questionRenderableInline(form)` (exactly one enum field, single-select ≤5 / multi-select ≤10, no "other") it is answered in the IM, else only the web link |
| `connect` | `appName`, `url` | link button |
| `bind` | `text`, `url` | link button (sent only in direct messages) |

- Validate with `validateChannelCard(card)` (returns problems); URL fields are absolute http(s), at most 2000 characters.
- For fallback text always use `renderCardAsText(card, locale)`; never write your own.
- A click resolves into `CardAction { cardKind, cardId, action, scope?, answer? }`. **Button callback value**: encode everything needed (card id, action, scope, option value) into the button (a compact JSON array), since the extension doesn't remember what it sent and any replica must parse it; over the platform limit (Slack 2000; Lark unstated, take 2000) throw and give only the web link. Parse **strictly**: length, type, kind and scope item by item; invalid -> null and the click is ignored; only action ids with this extension's prefix are recognized.
- If you can, turn off interaction on forwarded cards (Lark `enable_forward_interaction: false`).
- The response to a click doesn't change the card; the kernel updates it per the new state.

## Security rules (every channel extension)

- **Model text must not @ everyone or anyone**: escape the platform's control sequences when converting. Slack: escape `&`, `<`, `>`, percent-encode `<`, `>`, `|` in link addresses, so the model can't write `<!channel>` / `<!here>` / `<@U…>`; Lark: turn `<` and `&` outside code into entities, backslash into `&#92;`, split `<at` inside code, so the model can't write `<at id=all>`. Escape card titles, argument previews, display names and fallback text the same way.
- **Link allowlist**: only `http(s)://` (Lark adds `mailto:`) become links; `javascript:`, private protocols, images and reference-style links stay plain text. Card link buttons use only http(s).
- **Credentials stay out of logs and errors** (tokens, App Secret, client secret: not in logs, error messages or `last_error`). The kernel's redaction of `secret()` fields is only a backstop.
- All credentials come from config, so the extension needs no `permissions.secrets`; `permissions.network` lists fixed domains (display only, no wildcards; when the WSS host is assigned by the platform, list the main one or none).

## What the kernel guarantees (never do these yourself)

- **Long connections run on the gateway role, one holder per connection** (a Redis lease, taken over by another replica when the holder dies, with fair sharing across gateway replicas); a disabled, deleted or re-credentialed connection is disconnected and reconnected by the kernel.
- **Durable inbound and outbound**: inbound is processed from a queue with retries; outbound resumes by conversation event sequence after a crash without duplicates; streaming drafts, finalization and card updates are orchestrated by the kernel.
- **Dedupe**: inbound by `messageId` / `eventId`, outbound by `idempotencyKey` and the delivered sequence.
- **Card actions are re-authorized**: the clicker is mapped to an account and checked by the approval / question service; unbound people get a binding card in a direct message.
- **Identity resolution, binding, anonymous guests and fixed wording** (i18n by the org's `locale`).

So an extension **keeps no shared state across calls** (module-level Maps, in-process events and timers are blocked by `pnpm check`). The only allowed in-process caches are read-only lookups that are "correct even if lost", created in the factory function with a size cap and expiry (e.g. a display-name cache of 10 minutes / 1000 people, a tenant token cache until 3 minutes before expiry).

## `identity-source@1`

```ts
interface IdentitySource {
  label: { zh: string; en: string };
  authorizeUrl(args: { config; redirectUri; state; nonce; codeChallenge?; codeChallengeMethod? }): string;
  callback(args: { config; redirectUri; query; nonce; signal; codeVerifier? }): Promise<ExternalIdentity>;
}
```

- Deployment-level: `config` is `config.deployment`; the login page shows the source once the extension name is in `auth.loginSources`. The callback address is `<http.publicUrl>/api/v1/auth/sso/<plugin name>/callback`.
- State, nonce and PKCE verifier are generated and stored by the kernel (state is single-use and bound to the browser).
- **`source` must be `` `${extension name}:${tenantId}` ``**: the kernel rejects a mismatch.
- **`externalId` is the same kind of id as the channel's `sender.externalId`** (same app, same definition), or login and bot can't match people.
- **`emailVerified` is true only when the platform docs explicitly say the email is verified** (Slack OIDC's `email_verified`); otherwise false (Lark login and both directories). It decides whether an existing account can be merged by email (only for sources the deployment trusts in `auth.trustedIdentitySources`).
- **Use PKCE if the platform supports it**: `codeChallenge` / `codeChallengeMethod` in the authorization URL, `codeVerifier` in the token exchange (Lark). If not, ignore them and say why in the README (Slack OIDC doesn't declare PKCE).
- **Validate the ID token if there is one**: JWKS signature, `iss`, `aud = clientId`, not expired, `nonce` equal to the initiation's; userinfo's user / tenant must match it. Without an ID token (Lark), check that the user's tenant equals the login app's tenant and that `redirect_uri` matches strictly.
- Request only the scopes login needs: an ungranted scope makes login fail for everyone (Lark 20027), so Lark login requests none.
- Login only creates an account; it never adds it to an org.

## `directory@1`

```ts
interface Directory {
  configured?(orgConfig: unknown): boolean;
  listMembers(args: { orgConfig; cursor?; signal }): Promise<{ members: DirectoryMember[]; next?: string }>;
}
```

- **Pagination**: one page per call with `next`; the last page has none. Each page gets 60 seconds, a round at most 10000 pages. Put everything needed to continue in the cursor (stateless).
- **`configured(orgConfig)`**: implement it when the same extension also provides other extension points and the directory fields are optional in the org config. False makes the kernel skip scans, `directory_changed` and re-checks, and a manual sync answers 409 `directory.not_configured`. Pure function: no requests, no throwing.
- **Throw when not configured or the credentials are wrong; never return an empty list**: an empty list means "everyone left".
- **An incomplete listing must fail**: any page that can't be fetched in full (insufficient permission, rate-limit waits over budget, the department structure changing mid-sync, the tenant changing within a round, a status field unavailable) throws. The kernel removes people only after a fully successful round. Never return "whatever you could get".
- **Rate limiting**: within a page retry for the wait the platform gives, with a budget (both extensions: 30 seconds per page, at most 3 per request); beyond it throw "rate limited" (the round is incomplete).
- **`active: false`** reports someone as left (Slack `deleted`, Lark `is_resigned` / `is_frozen` / `is_exited`); people who aren't formal members are not reported (Slack guests `is_restricted` / `is_ultra_restricted`; Lark inactive and not-joined people; bots and Slackbot). Duplicates are fine; the kernel dedupes by identity.
- The kernel also guards against mass removals (a non-manual round planning to remove more than `max(5, 20%)` of directory members removes nobody), removes only memberships the directory created, and remembers people an admin removed; you don't implement any of this.

## Testing

The fake platforms are in `@capybara-hq/testing`:

| Fake server | Plays | Constructing inbound events |
|---|---|---|
| `startFakeChannelServer()` | a generic fake IM: NDJSON long connection, `/send` `/update` (dedupe by `idempotencyKey`), OAuth (with PKCE), directory `book(key)`; counts peak concurrent long connections per connection | `fakeDm`, `fakeGroupMessage`, `fakeCardAction`, `fakeDirectoryMember`; `push(connectionId, event)` |
| `startFakeSlack()` | Web API, Socket Mode (records `acks`), Sign in with Slack (RS256 ID token, `tamperNextIdToken`), `users.list`; `failNext` injects platform errors / 429 | `slackDmEvent`, `slackMentionEvent`, `slackBlockAction`, `findSlackButton` |
| `startFakeLark()` | OpenAPI, long connection (the SDK's protobuf frames, runs the real `WSClient`, records `acks`), OAuth + PKCE, department / user pagination; `failNext`, `hideUserStatus` | `larkMessageEvent`, `larkCardAction`, `findLarkButton` |

- **Extension unit tests** (`plugins/<name>/test`): call the factory directly (e.g. `createSlackChannel({ apiUrl })`) against the fake server, covering: each inbound message kind and its ids, stripping the @, ack only after `onEvent` resolves (no ack on reject), reconnection and backoff, the error mapping, splitting and `too_large`, escaping (`@channel` / `<at id=all>` injection), the link allowlist, the callback value limit and strict parsing, the identity key and ID token tampering, directory pagination / rate-limit budget / not configured / incomplete-listing errors.
- **Webhook tests**: `signFakeWebhook(body, secret)` (with `fakeWebhookEvents` / `fakeWebhookChallenge`), `signSlackWebhook(body, signingSecret, ts)` and `encryptLarkWebhook(payload, encryptKey)` sign like the platforms. Cover: bad signature and stale timestamp rejected, challenge answered, no ack when `onEvent` rejects, a redelivered event processed once. See `plugins/slack/test/webhook.test.ts`, `plugins/lark/test/webhook.test.ts`, `plugins/slack/test/kernel/slack-webhook.dual.test.ts`.
- **Dual-replica kernel acceptance** (`plugins/<name>/test/kernel/*.dual.test.ts`): `createDualReplicaHarness({ resolveFrom: <plugin dir>, extensions: ["@capybara-hq/plugin-model-fake", <plugin entry path>], extensionConfig: { <plugin>: { apiUrl: fake.apiUrl, … } } })`, the extension by source path and model-fake (a devDependency) by package name; tests import only `@capybara-hq/testing`, the SDK, model-fake and the plugin (`plugin-test-imports`). Prove: only one long connection; after killing the holder another replica takes over; a redelivered message is processed once; streaming replies, approval card clicks, card updates and the final reply are each delivered once. See `plugins/slack/test/kernel/slack.dual.test.ts`, `plugins/lark/test/kernel/lark.dual.test.ts`, `m4-segment2-slack.dual.test.ts` / `m4-segment2-lark.dual.test.ts`. To find the replica holding the long connection use the fake platform's `socketPeerPorts()` plus `pidOwningLocalPort`.
- **The same identity in all three places**: the flow of `slack-identity.dual.test.ts` / `lark-identity.dual.test.ts`: web login (fake authorization page, callback) -> directory sync adds the same person to the org (no new identity or account) -> the same person messaging the bot is recognized as that account (no binding card). A new platform must have this case; it catches wrong tenant definitions, id kinds and app mismatches.
- **Live tests**: `plugins/<name>/test/live/*.live.test.ts` run only when `CAPYBARA_TEST_LIVE_TOOLS=1` and the platform variables are set (Slack: `CAPYBARA_TEST_SLACK_BOT_TOKEN`, `CAPYBARA_TEST_SLACK_APP_TOKEN`, `CAPYBARA_TEST_SLACK_CHANNEL`, `CAPYBARA_TEST_SLACK_TEAM_ID`, `CAPYBARA_TEST_SLACK_CLIENT_ID`, `CAPYBARA_TEST_SLACK_CLIENT_SECRET`; Lark: `CAPYBARA_TEST_LARK_APP_ID`, `CAPYBARA_TEST_LARK_APP_SECRET`, `CAPYBARA_TEST_LARK_CHAT_ID`, `CAPYBARA_TEST_LARK_CHAT_TYPE`); only checks that need no human action run. Keep keys in an env file outside the repository and never print them.
- Run from the repository root: `pnpm exec vitest run plugins/slack`.

## New channel extension checklist

1. Write the README first: app creation steps and the permission (scope) table, the doc source and lookup date of every trade-off, acknowledgement / reconnection / rate limiting / length / error mapping, and items to confirm in a real integration.
2. Manifest: `provides` the extension points needed, `permissions.network`, `config.deployment` (login), `config.org` (directory; `configured` when fields are optional), and the channel connection config in `connectionSchema`.
3. Implement per the conventions above, with escaping and the link allowlist in their own file with unit tests.
4. Fake server: if the platform protocol can be fully simulated, simulate it (Lark's protobuf frames) so tests run the real SDK; a new fake platform belongs in `@capybara-hq/testing` (a PR in core).
5. A dual-replica case for the same identity in all three places.
6. `pnpm lint && pnpm typecheck && pnpm check && pnpm exec vitest run plugins/<name>`.
