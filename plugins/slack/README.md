# @capybara-hq/plugin-slack

The official Slack plugin. It provides three capabilities and a connector template:

- `channel@1` (bot): receives events over [Socket Mode](https://docs.slack.dev/apis/events-api/using-socket-mode)
  (no public callback URL needed), sends messages through the Web API, and renders approval / question /
  connection / binding cards as Block Kit.
- `identity-source@1` (Sign in with Slack, OpenID Connect): sign in to Capybara with a Slack account.
- `directory@1` (directory sync): syncs Slack workspace members into org members.
- The connector template `slack` ([Slack connector](#slack-connector-slacks-mcp-server)): agents search,
  read and send in Slack **as the person talking to them**, through Slack's MCP server and each member's own
  OAuth authorization. Switched off by default.

All three use the same identity key: `identities.source` = `slack:<team id>`, `external_id` = the Slack user id (`U…`).
When the same person appears through sign-in, a DM to the bot and directory sync, it maps to one identity row and one account.

The Slack docs cited here were consulted on 2026-10-20.

## Create the Slack app

The steps live in the product: the plugin ships the setup guide `slack-app`
([`guides/slack-app.md`](./guides/slack-app.md), Chinese
[`guides/slack-app.zh.md`](./guides/slack-app.zh.md)). When an org admin creates a Slack channel
connection (Channels → New channel) or opens one, the web app shows the guide for the connection's
inbound mode (Socket Mode or webhook) with the app manifest filled in for that connection (its name,
the Sign in with Slack callback and, in webhook mode, its webhook URL) and a copy button. When a
plugin upgrade changes the manifest, the channel page says so and asks you to update the Slack app.
To preview the guide outside Capybara, run
`capybara-plugin guide slack-app --mode long_connection` (or `--mode webhook`, `--locale zh`) in
this repository.

The guide carries live checks, run when the page is viewed (cached for five minutes) or on
**Check again**:

| Check | What it does |
|---|---|
| `bot-token` | `auth.test` with the connection's bot token: refused (`invalid_auth`, `token_revoked`, …), wrong token type or an org-wide install is failing with the fix |
| `bot-scopes` | Compares the scopes Slack reports for the bot token (`x-oauth-scopes`) with the manifest's bot scopes and names the missing ones |
| `app-token` | `apps.connections.open` with the app-level token (Socket Mode only; the socket is never opened) |

Each check makes one read-only call, passes the kernel's abort signal on and never retries; rate
limits and Slack outages answer "unknown", never "failing". The guide also uses the kernel checks
`capybara:public-url`, `capybara:webhook-public` and `capybara:webhook-received`.

Notes for operators:

- The org must enable the `slack` plugin before it can create a connection (its org-level fields are
  optional and only for [directory sync](#directory-directory1)). The tokens are stored in the
  secret store, and the API only returns "set".
- The app's name in the manifest is the connection's name; Slack caps it at 35 characters, so shorten it in
  the app settings if Slack refuses it (the bot user's name stays `capybara`).
- In Slack, DM the bot, or add the bot to a channel and @-mention it. The first conversation gets a
  binding card; click the button to confirm the binding on the web page.

Note: apps that use Socket Mode cannot currently be listed in the public Slack Marketplace, and one app can hold at most 10 concurrent
Socket Mode connections ([Using Socket Mode](https://docs.slack.dev/apis/events-api/using-socket-mode)). At any moment Capybara has only one
replica hold one connection per channel connection.

In long-connection mode the connection is held by one `gateway` replica; with several gateways the
connections are spread by fair share (`channels.shareSlack`, see
[Roles and scaling](https://github.com/capybara-hq/core/blob/main/docs/deploy/README.md#roles-and-scaling)).

## Webhook inbound mode (optional)

Socket Mode is the default. A connection can instead receive events over HTTPS webhooks, when the
deployment exposes a gateway replica and sets `channels.webhookBaseUrl` (see
[Deploying: webhook](https://github.com/capybara-hq/core/blob/main/docs/deploy/README.md#webhook-optional)). Switch the connection to webhook mode in the web app (Channels →
connection → Overview → Inbound mode); the connection page then shows its webhook URL.

1. Copy **Basic Information → App Credentials → Signing Secret** into the connection's
   `signingSecret`. Every request is verified with it (HMAC-SHA256 over `v0:<timestamp>:<body>`)
   and must be at most 5 minutes old; without it every webhook request is refused.
2. The webhook manifest of the setup guide turns **Socket Mode** off and uses the connection's webhook
   URL as the **Event Subscriptions → Request URL** (Slack verifies it with a `url_verification`
   challenge, which the plugin answers), the **Interactivity & Shortcuts → Request URL** (card
   buttons) and each slash command's **Request URL**. For an existing app, paste it under **App
   Manifest**, or set the four URLs by hand. The plugin tells a slash command from an event by its
   form body and answers it like Socket Mode does.
3. The webhook URL exists only once the connection is saved, so the guide shows it after saving;
   create the connection first, then let Slack verify the URL.
4. `appToken` is optional in webhook mode: only Socket Mode uses it.

Both modes parse events the same way (same message and card-click ids), so the kernel's dedupe
still drops a redelivery that arrives across a mode switch.

## Sign in with Slack (login)

[Sign in with Slack](https://docs.slack.dev/authentication/sign-in-with-slack/) is based on OpenID Connect.

1. The setup guide's manifest already lists the callback; otherwise, in the app settings, add
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

## Slack connector (Slack's MCP server)

The template [`connectors/slack.json`](./connectors/slack.json) connects Slack's official MCP server
(`https://mcp.slack.com/mcp`, [Slack MCP server](https://docs.slack.dev/ai/slack-mcp-server/)) through the
`connector-mcp` plugin (a dependency in `plugin.json`, preinstalled with Capybara). Each member authorizes
their own Slack account, so an agent sees and does exactly what that person may in Slack, and every call runs
on the caller's own user token; there is no shared org token. Design and decisions:
[docs/superpowers/specs/2026-11-08-slack-connector-design.md](https://github.com/capybara-hq/plugins/blob/main/docs/superpowers/specs/2026-11-08-slack-connector-design.md).

- **Off by default** (`defaultEnabled: false`): an org that turns on the `slack` plugin for the bot does not
  see the connector until an org admin switches the template on and enters the OAuth client.
- **Auth**: OAuth authorization code, personal credentials, MCP discovery (Slack's metadata points at
  `https://slack.com/oauth/v2_user/authorize` and `oauth.v2.user.access`), a manually entered client (Slack
  offers no dynamic client registration), `client_secret_post`, and 30 explicit user scopes (the full set
  Slack's server supports; a scope Slack adds later needs a template update).
- **Tools**: reads are allowed; every write (send, schedule, draft, create, update, react, upload) and
  `slack_search_public_and_private` (reaches DMs and private channels) ask the person first. Org admins and
  agents change the policies on the tools page; tools Slack adds later default by their annotations (`ask`
  without `readOnlyHint`).

### Set it up

The connector template carries the setup guide `slack-connector`
([`guides/slack-connector.md`](./guides/slack-connector.md), Chinese
[`guides/slack-connector.zh.md`](./guides/slack-connector.zh.md)), shown on the template's pages:
org admins see how to create the internal Slack app (the manifest with this deployment's OAuth
callback filled in), keep it internal and enter its client id and secret; members see how to connect
their own Slack account. Preview it with
`capybara-plugin guide slack-connector --audience admin` (or `--audience member`). Its rows are
kernel checks: `capybara:public-url`, `capybara:oauth-client`, `capybara:oauth-token-endpoint`
(the stored client against Slack's token endpoint; the secret stays in the kernel),
`capybara:connector-tools` and, for members, `capybara:connector-connected`.

Notes for operators:

- The deployment must set `http.publicUrl`: the OAuth callback is
  `<http.publicUrl>/api/v1/oauth/callback`.
- Each org enters its own client (the same Slack app may serve several orgs); rotate the secret later
  through the connector's org credentials.
- Capybara stays a confidential client: it still sends a PKCE challenge (Slack's metadata advertises
  it), but PKCE must not be enabled in the app settings.

### Decided risks

- **Slack data in conversations**: tool results stay in the conversation event log and archives like any
  other connector's, although Slack's Real-time Search terms say retrieved data must not be stored. The app
  is the customer's own internal app under its own Slack agreement.
- **Quoting private Slack content into shared threads**: in a Slack channel thread (through the bot), a tool
  call runs on the acting member's token and the reply goes to a channel others read. There is no special
  rule for this; it relies on the tool policies (the `ask` default of `slack_search_public_and_private`
  plus whatever the org or agent sets).
- **No identity check**: a member may connect a different Slack account than the one bound to their
  Capybara account; the token still reaches only their own calls.
- **No revoke on disconnect** and **one client per org** (no platform-level client) in this release.
- **Scopes**: the full set only; there is no reduced variant (for example without DM scopes).

## Commands

The kernel parses commands from the message text: `/new` (DM: start a new conversation), `/env [name]`
(DM: list or set your default environment) and `/<skill> args` (invoke a skill). The Slack client,
however, treats any message starting with `/` as a slash command and refuses names no app registered
("/env is not a valid command"), so those messages never reach the bot. The app therefore registers
three slash commands, and the plugin turns each back into the text the kernel parses (it parses no
command itself):

| Slash command | Text the kernel gets |
|---|---|
| `/new` | `/new` |
| `/env [name]` | `/env [name]` |
| `/capybara <skill> [args]` | `/<skill> [args]` (`/capybara fix-issue 12` → `/fix-issue 12`; also `/capybara github:fix-issue 12`) |

`@capybara /fix-issue 12` in a channel still works as plain text, as before. Commands other than `/new`
and `/env` map like `/capybara`, so an admin may rename it (for example when another app already owns
`/capybara`). Slack lets several apps register `/new` or `/env`; a person who has two such apps picks
one in Slack's menu.

- **In your DM with the bot**: the command becomes a DM message from you, exactly as if you had typed
  the text (binding, `/new`, `/env` and skills behave the same). Slack shows no slash command in the
  conversation, so the ack carries an ephemeral echo of what you ran ("only visible to you"); the
  kernel's reply follows as usual. The message id is `<DM channel>:cmd-<trigger_id>`.
- **In a channel**: the bot first posts a visible echo `@you: /capybara fix-issue 12` and the event is
  that message, with `mentionsBot: true` (the same as `@capybara /fix-issue 12`): the kernel applies its
  group rules (`/new` and `/env` are plain text in a group) and replies in the echo's thread, where you
  can follow up by @-mentioning the bot. The bot must be in the channel; otherwise you get an
  ephemeral "invite the app first" hint and nothing is sent to the kernel.
- **In a DM between two people** (where the bot cannot reply): an ephemeral hint to use your DM with
  the app or a channel; nothing is sent. The plugin finds the bot's own DM with `conversations.open`
  (cached in kv for a day; if the lookup fails it assumes the DM is the bot's).
- **`/capybara` without a skill**: an ephemeral usage line.
- **Ack**: Slack wants a slash command acked within 3 seconds and never redelivers one. The plugin acks
  only after `onEvent` resolves, which is quick (the kernel dedupes and enqueues); before it, at most
  one Web API call runs (the echo post, or the DM lookup), each with a 1.5 second timeout, in parallel
  with the profile lookup. If `onEvent` rejects, nothing is acked and Slack shows the person a timeout
  error, so they run the command again. A Socket Mode redelivery of the same command (same
  `trigger_id`) reuses the cached echo, so it is posted once.
- The fixed hints are bilingual (English · 中文): the org's IM language is not known on inbound.

Existing apps: re-paste the manifest from the setup guide (**App Manifest** in the app settings) or add the three commands
by hand under **Slash Commands**, add the bot scopes `commands` and `im:write`, then **reinstall the
app** to the workspace (Slack asks for it because the scopes changed). The bot token stays the same.

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
- **Profile, time zone and language**: every speaker is looked up with
  [`users.info`](https://docs.slack.dev/reference/methods/users.info) `include_locale=true` (Tier 4, `users:read`):
  `user.tz` becomes `sender.timeZone` and `user.locale` becomes `sender.locale`, passed as is (the kernel
  ignores an unknown zone and normalizes the language; both win over the person's Capybara settings for the
  run's date, zone and language). The display name and avatar come from the event's `user_profile` when it
  has one, else from the same lookup. The result is cached in the plugin kv per team and user for 10 minutes
  (shared by every replica; nothing in process memory; an unknown user is cached as empty). The lookup has a
  1.5 second timeout so the 3 second ack deadline holds; on any failure the fields are left out and nothing
  is cached.
- **Permission manifest**: `network: ["slack.com", "wss-primary.slack.com"]`, shown only and not enforced; login (OIDC) and the directory also use
  `slack.com`. The WSS host for Socket Mode is
  assigned by Slack and is not fixed (for example `wss-primary.slack.com`, `wss-backup.slack.com`, `wss-111.slack.com`); the manifest's domain
  validation does not support wildcards, so only the main one is listed.

## Channel connection config

| Field | Description |
|---|---|
Shown in the form with zh / en labels and help.

| Field | Label | Description |
|---|---|---|
| `appToken` | App-level token / 应用令牌 | `xapp-…` (secret); required for Socket Mode (Basic Information → App-Level Tokens, scope `connections:write`), unused in webhook mode |
| `botToken` | Bot token / 机器人令牌 | `xoxb-…` (secret; Install App → Bot User OAuth Token) |
| `signingSecret` | Signing secret / 签名密钥 | Secret; only needed in webhook mode, leave empty for Socket Mode |

## Deployment-level config

| Field | Default | Description |
|---|---|---|
| `apiUrl` | `https://slack.com/api/` | Web API root URL; change it only in tests or when going through a proxy |
| `openidUrl` | `https://slack.com/` | Root URL for the OIDC authorization page and JWKS; change it only in tests or when going through a proxy (the ID token's `iss` is fixed at `https://slack.com`) |
| `clientId` | — | Client ID for Sign in with Slack; leave empty if you don't use login |
| `clientSecret` | — | Client Secret for Sign in with Slack (secret, masked in logs); leave empty if you don't use login |

The deployment-level config lives under the kernel config `extensionConfig.slack`.

## Org-level config

| Field | Description |
|---|---|
| `teamId` | Optional: the Slack workspace id (`T…`) for syncing members into the org; leave empty if you only chat with the bot |
| `botToken` | Optional, only for member sync (`xoxb-…`, secret); the tokens for chat go into the channel connection |

## Icon

`icon.svg`: the Slack mark (owner: Slack (Salesforce)), downloaded on 2026-11-08 from the Slack media kit,
https://slack.com/media-kit (Logos: https://salesforce.widencollective.com/c/yn6bxnam, file
SLA-Slack-icon-RGB.svg). It is a trademark of its owner, used only to identify the service this
plugin connects to; the plugin is not affiliated with or endorsed by the owner. The artwork is
unchanged except for removing editor metadata and setting a square viewBox.
