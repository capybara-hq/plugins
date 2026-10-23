# @capybara-hq/plugin-slack

The official Slack plugin. It provides three capabilities:

- `channel@1` (bot): receives events over [Socket Mode](https://docs.slack.dev/apis/events-api/using-socket-mode)
  (no public callback URL needed), sends messages through the Web API, and renders approval / question /
  connection / binding cards as Block Kit.
- `identity-source@1` (Sign in with Slack, OpenID Connect): sign in to Capybara with a Slack account.
- `directory@1` (directory sync): syncs Slack workspace members into org members.

All three use the same identity key: `identities.source` = `slack:<team id>`, `external_id` = the Slack user id (`U…`).
When the same person appears through sign-in, a DM to the bot and directory sync, it maps to one identity row and one account.

The Slack docs cited here were consulted on 2026-10-20.

## Create the Slack app

1. Open <https://api.slack.com/apps> → **Create New App** → **From a manifest**, pick the workspace, and paste this directory's
   [`app-manifest.yaml`](./app-manifest.yaml) (format: [App manifest reference](https://docs.slack.dev/reference/app-manifest)).
   It turns on Socket Mode and Interactivity, subscribes to the events `message.im`, `app_mention`, `message.channels`,
   `message.groups`, `team_join` and `user_change`, and requests these bot scopes:

   | scope | Purpose |
   |---|---|
   | `chat:write` | Send and update replies and cards |
   | `im:history` | Receive DM messages |
   | `app_mentions:read` | Receive messages that @-mention the bot in channels |
   | `channels:history` / `groups:history` | Receive thread replies in public / private channels |
   | `users:read` | Look up the speaker's display name and avatar; people-change events; directory `users.list` |
   | `users:read.email` | Read emails during directory sync (the bot itself does not use it) |

2. **Basic Information → App-Level Tokens → Generate Token and Scopes**: add the scope `connections:write`
   to get the app-level token `xapp-…` (Socket Mode uses it to call `apps.connections.open`).
3. **Install App → Install to Workspace** to get the bot token `xoxb-…`.
4. In the Capybara org settings, enable the `slack` plugin, then **create a new channel connection**: pick Slack as the plugin, fill in `appToken` (`xapp-…`) and
   `botToken` (`xoxb-…`), and bind an agent. Both are stored in the secret store, and the API only returns "set".
5. In Slack, DM the bot, or add the bot to a channel and @-mention it. The first conversation gets a binding card; click the button to confirm the binding on the web page.

Note: apps that use Socket Mode cannot currently be listed in the public Slack Marketplace, and one app can hold at most 10 concurrent
Socket Mode connections ([Using Socket Mode](https://docs.slack.dev/apis/events-api/using-socket-mode)). At any moment Capybara has only one
replica hold one connection per channel connection.

## Webhook inbound mode (optional)

Socket Mode is the default. A connection can instead receive events over HTTPS webhooks, when the
deployment exposes a gateway replica and sets `channels.webhookBaseUrl` (see
[Deploying: webhook](https://github.com/capybara-hq/core/blob/main/docs/deploy/README.md#webhook-optional)). Switch the connection to webhook mode in the web app (Channels →
connection → Overview → Inbound mode); the connection page then shows its webhook URL.

1. Copy **Basic Information → App Credentials → Signing Secret** into the connection's
   `signingSecret`. Every request is verified with it (HMAC-SHA256 over `v0:<timestamp>:<body>`)
   and must be at most 5 minutes old; without it every webhook request is refused.
2. In the app settings, turn **Socket Mode** off, then use the webhook URL as the **Event
   Subscriptions → Request URL** (Slack verifies it with a `url_verification` challenge, which the
   plugin answers) and as the **Interactivity & Shortcuts → Request URL** (card buttons).
3. `appToken` is optional in webhook mode: only Socket Mode uses it.

Both modes parse events the same way (same message and card-click ids), so the kernel's dedupe
still drops a redelivery that arrives across a mode switch.

## Sign in with Slack (login)

[Sign in with Slack](https://docs.slack.dev/authentication/sign-in-with-slack/) is based on OpenID Connect.

1. In the app settings, add
   `<http.publicUrl>/api/v1/auth/sso/slack/callback` under **OAuth & Permissions → Redirect URLs** (for example `https://capybara.example.com/api/v1/auth/sso/slack/callback`;
   the `redirect_uri` the kernel sends must equal it or be a sub-path of it).
2. The login flow requests the scopes `openid`, `email` and `profile` in the authorization URL (`openid` is required; `email` gives the email and
   `email_verified`, `profile` gives the name and avatar). Do **not** add them to the app's Bot / User Token Scopes: Slack requires the
   Sign in with Slack scopes to be requested in a different OAuth flow from the other scopes; installing the app (bot) and signing in are two separate flows.
3. Put the Client ID and Client Secret from **Basic Information → App Credentials** into the deployment-level config (see below), and add `slack`
   to the kernel config `auth.loginSources`. "Slack" then appears on the login page.

How the plugin works: the authorization URL is `https://slack.com/openid/connect/authorize` (`response_type=code`, `state`, `nonce`);
the callback exchanges the authorization code at `openid.connect.token` (`client_secret_post`) and **verifies the ID token** (JWKS
`https://slack.com/openid/connect/keys` verifies the RS256 signature, `iss = https://slack.com`, `aud = clientId`, not expired,
`nonce` matches the one sent at the start), then calls `openid.connect.userInfo` with the access token to get the email, name and avatar (its user / workspace must match
the ID token). `email_verified` is used as-is as the email-verified flag.

**No PKCE**: neither Slack's OIDC docs nor its [discovery](https://slack.com/.well-known/openid-configuration) declare
PKCE; Slack's [PKCE](https://docs.slack.dev/authentication/using-pkce) applies only to `oauth.v2.*`, and once enabled the app irreversibly
becomes a public client. The plugin ignores the PKCE parameters the kernel supplies; login is protected by the kernel's state (single use, bound to the browser that started the login), the nonce
(checked inside the verified ID token) and the client secret.

Note: users from any Slack workspace can complete Sign in with Slack (as with other identity sources, login only creates an account and does not join any org;
org membership comes from invitations or directory sync). Merging into an existing account by verified email applies only to identity-source tenants the admin trusts.

## Directory (directory@1)

When enabling the `slack` plugin in the org settings, fill in the org-level config `teamId` (the workspace id, `T…`) and `botToken` (`xoxb-…`; it may be the same bot token as a
channel connection uses, but the config is stored separately and goes through the secret store). The bot token needs:

| scope | Purpose |
|---|---|
| `users:read` | [`users.list`](https://docs.slack.dev/reference/methods/users.list) lists members |
| `users:read.email` | Member emails (without it `users.list` returns no emails) |

- The tenant is the **workspace**: `teamId` accepts only `T…`; an enterprise id (`E…`) would split one person into two identity rows. Each page first calls `auth.test`:
  a token from an org-level install (`is_enterprise_install`) or a token whose `team_id` is not `T…` is rejected; the workspace the token belongs to must also equal
  `teamId`, otherwise the sync errors (to avoid recording another workspace's people as this tenant). For Enterprise Grid, use each workspace's own bot token.
- `users.list` paginates by cursor (200 per page; Slack recommends at most 200); it excludes bots (`is_bot`), Slackbot (`USLACKBOT`),
  **guests** (`is_restricted` multi-channel guests, `is_ultra_restricted` single-channel guests; guests do not become org members and can be invited manually if needed),
  and, under Enterprise Grid, members of other workspaces whose own `team_id` differs from `teamId`; people with `deleted = true` are reported as departed
  (`active = false`), and the kernel only revokes memberships that were added by directory sync.
- Emails are always reported as **unverified**: the `users.list` docs do not say whether `profile.email` is verified (only OIDC's
  `email_verified` at login counts).
- Rate limits: `users.list` is Tier 2 (20+ requests/minute). On HTTP 429 the sync waits per `Retry-After` and retries within the same sync, at most 3 times and
  at most 30 seconds cumulative per page; beyond that it errors, the kernel records the run as incomplete (it only adds people and removes no one), and the next sync tries again.
- People-change events (`team_join`, `user_change`, received through the channel connection) trigger a sync.
- When `teamId` / `botToken` are not filled in (the org only uses the bot), the plugin's `configured()` returns false: the kernel does not scan or sync, and records no audit
  or warning; a manual sync returns 409 `directory.not_configured`. It is not treated as an empty directory.

## Behavior

- **DMs**: every text message goes to the kernel. **Channels**: only messages that @-mention the bot (a new message gets a thread reply under it), and replies inside threads
  (the kernel currently handles only those that @-mention the bot). Edits, deletions, messages from the bot itself and other bots, and other messages with a `subtype` are ignored;
  file shares with a caption (`file_share`, only the text is taken) and thread replies also sent to the channel (`thread_broadcast`) are handled as text.
  M4 handles text only. The text has the bot @-mention removed (only the whitespace on both sides of the @ is tidied; indentation and line breaks are kept) and `&amp;` / `&lt;` / `&gt;` are unescaped.
  In link addresses inside model replies, `<`, `>` and `|` are percent-encoded, so model text cannot inject control sequences such as `<!channel>`.
- **ids**: message id = `<channel id>:<ts>` (unique and stable within a connection); group-chat thread id = `<channel id>:<thread_ts>`, which is the message id of the thread's root message;
  the card-click `eventId` = `<channel>:<card message ts>:<clicker>:<action_ts>` (the payload is the same on redelivery, so it is stable).
  The speaker's tenant = the Slack team id (for an external member of a shared channel, `user_team`), on the same basis as `verify` (the `team_id` of `auth.test`).
- **Ack**: the kernel acks only after `onEvent` resolves; a reject is not acked, and Slack redelivers (three times in total: immediately, after about 1 minute and after about 5 minutes,
  see [Events API](https://docs.slack.dev/apis/events-api/)).
- **Format**: the model reply's Markdown is converted to [mrkdwn](https://docs.slack.dev/messaging/formatting-message-text);
  a single text is capped at 4000 characters (beyond that `chat.update` returns `msg_too_long`, see [chat.update](https://docs.slack.dev/reference/methods/chat.update)),
  and longer text is split into several messages; when an edit is too long it reports `too_large` and the kernel sends a new message instead.
- **Streaming edits**: `minEditIntervalMs = 2500` (`chat.update` is Tier 3, about 50 per minute, counted per workspace, see
  [chat.update](https://docs.slack.dev/reference/methods/chat.update) and
  [Rate limits](https://docs.slack.dev/apis/web-api/rate-limits)); under more concurrency, 429 + Retry-After is the backstop.
- **Reconnect**: managed by the plugin (SDK auto-reconnect is turned off). When Slack recycles a connection normally it reconnects immediately; consecutive short-lived (under 10 seconds) connections back off exponentially
  (with jitter), and after 5 in a row, or on receiving `link_disabled`, it reports an error; the kernel records `last_error` and backs off.
- **Idempotency**: `chat.postMessage` has no idempotency parameter, so `idempotencyKey` is ignored.
- **Profile**: the display name / avatar come from the `user_profile` carried by the event, otherwise from `users.info` (cached per process for 10 minutes, at most 1000 people,
  1.5 second timeout; if the lookup fails it is left out).
- **Permission manifest**: `network: ["slack.com", "wss-primary.slack.com"]`, shown only and not enforced; login (OIDC) and the directory also use
  `slack.com`. The WSS host for Socket Mode is
  assigned by Slack and is not fixed (for example `wss-primary.slack.com`, `wss-backup.slack.com`, `wss-111.slack.com`); the manifest's domain
  validation does not support wildcards, so only the main one is listed.

## Channel connection config

| Field | Description |
|---|---|
| `botToken` | Bot token (`xoxb-…`, secret) |
| `appToken` | App-level token (`xapp-…`, secret); required for Socket Mode, unused in webhook mode |
| `signingSecret` | Signing Secret (secret); required in webhook mode, unused with Socket Mode |

## Deployment-level config

| Field | Default | Description |
|---|---|---|
| `apiUrl` | `https://slack.com/api/` | Web API root URL; change it only in tests or when going through a proxy |
| `openidUrl` | `https://slack.com/` | Root URL for the OIDC authorization page and JWKS; change it only in tests or when going through a proxy (the ID token's `iss` is fixed at `https://slack.com`) |
| `clientId` | — | Client ID for Sign in with Slack; leave empty if you don't use login |
| `clientSecret` | — | Client Secret for Sign in with Slack (secret, masked in logs); leave empty if you don't use login |

The deployment-level config lives under the kernel config `pluginConfig.slack`.

## Org-level config

| Field | Description |
|---|---|
| `teamId` | The Slack workspace id for directory sync (`T…`) |
| `botToken` | The bot token for directory sync (`xoxb-…`, secret) |
