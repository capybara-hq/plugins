# Slack connector: per-person OAuth to Slack's MCP server

- Status: draft; the maintainer's answers to the open questions are recorded below and marked
  **(decided, 2026-11-08)**
- Date: 2026-11-08
- Plugin: `plugins/slack` (adds a connector template; no extension code)
- Direction (maintainer, 2026-11-08): an enterprise-internal Slack app (not on the Slack
  Marketplace), authorized per person via OAuth, preferably through Slack's official MCP server,
  packaged as a connector template in the `slack` plugin.

## 1. Intent

A Capybara agent should read and send Slack messages, search Slack and use canvases, lists and
files **as the person who is talking to it**, with exactly that person's Slack permissions. Today
the `slack` plugin only gives Capybara a bot in Slack (`channel@1`), sign-in (`identity-source@1`)
and directory sync (`directory@1`); the bot sees only messages addressed to it and cannot search or
read on anyone's behalf.

### Goals

- A connector template `connectors/slack.json` in the `slack` plugin, on `connector-mcp`, pointing
  at Slack's MCP server `https://mcp.slack.com/mcp`.
- Each member authorizes once from 我的连接 (`/account/connections`); the kernel stores their user
  token as a personal credential and refreshes it.
- Reads run freely; every write (send, schedule, create, update, react, upload) asks the person
  first by default.
- Works with one Slack app that the customer creates in its own workspace (internal app), with a
  manifest and README steps shipped in the plugin.

### Non-goals

- A Capybara-owned, Marketplace-listed Slack app.
- Replacing the bot channel (`channel@1`); the two coexist.
- Bulk export, indexing or caching of Slack content in Capybara.
- Our own Slack tool implementation, unless the fallback (§9) is needed.

### Anti-goals (never)

- A shared org token (bot or user) through which members read other people's DMs or private
  channels. Every call runs on the caller's own user token; there is no org-owned Slack credential
  in this connector.
- Slack tokens visible to org admins, in events, logs, archives or model context.
- Writes in Slack without the person's approval unless they or an admin chose `allow`.

## 2. Findings (sources accessed 2026-11-08 unless dated)

### 2.1 Slack's MCP server

| Topic | Finding |
|---|---|
| Endpoint | `https://mcp.slack.com/mcp`, JSON-RPC over Streamable HTTP; SSE not supported ([overview](https://docs.slack.dev/ai/slack-mcp-server/)) |
| Status | Launched with the Real-time Search API ([changelog 2026-02-17](https://docs.slack.dev/changelog/2026/02/17/slack-mcp)); "generally available" ([Feature Drop, 2026-02-28](https://slack.com/blog/news/feature-drop-feb26)); more tools on [2026-05-13](https://docs.slack.dev/changelog/2026/05/13/new-mcp-tools) (reactions, create conversation, channel members, emoji, read files) |
| Who may use it | "Only apps published in the Slack Marketplace and internal apps can use MCP at this time … unlisted apps are prohibited" (overview). An internal app is fine. |
| App setting | Manifest `settings.is_mcp_enabled` ([manifest reference](https://docs.slack.dev/reference/app-manifest)) |
| Auth | Confidential OAuth client with the app's client id and secret; **no dynamic client registration** (overview). Probed live today: `POST /mcp` without a token returns `401` with `WWW-Authenticate: Bearer resource_metadata="https://mcp.slack.com/.well-known/oauth-protected-resource"`. Protected-resource metadata: `resource` `https://mcp.slack.com`, `authorization_servers` `["https://mcp.slack.com"]`. Authorization-server metadata (`/.well-known/oauth-authorization-server`): issuer `https://mcp.slack.com`, `authorization_endpoint` `https://slack.com/oauth/v2_user/authorize`, `token_endpoint` `https://slack.com/api/oauth.v2.user.access`, grants `authorization_code` and `refresh_token`, `token_endpoint_auth_methods_supported` `["client_secret_post"]`, PKCE `S256`, no `registration_endpoint`. |
| Scopes | All user scopes, listed in `scopes_supported`: `search:read.public/.private/.mpim/.im/.files/.users`, `channels/groups/mpim/im:history`, `channels/groups/mpim/im:read`, `channels/groups/mpim/im:write`, `chat:write`, `canvases:read/write`, `lists:read/write`, `files:read/write`, `reactions:read/write`, `emoji:read`, `users:read`, `users:read.email` |
| Admin | Workspace admins approve MCP clients through normal app approval; app IP allow-lists apply; calls are in audit logs (overview) |
| Plans | Not documented beyond "may depend on your subscription" (Feature Drop). Real-time Search's semantic search needs Slack AI Search ([RTS](https://docs.slack.dev/apis/web-api/real-time-search-api)). |
| Rate limits | Same as the matching Web API methods: search and send "special"; Tier 2 for user/channel search, create conversation/canvas, list channels; Tier 3 for read channel/thread, schedule, reactions, update canvas; Tier 4 for read files/profile, members, upload (overview). Per user token, so per person. |
| Data use | RTS (behind search): "You must not store or copy any of the data retrieved", no training ([RTS](https://docs.slack.dev/apis/web-api/real-time-search-api)). Capybara stores tool results in the conversation event log and archives: see §7.4. |

Tools (names as exposed through an MCP client today; Slack's docs list functions, not names, so a
live `tools/list` is the source of truth):

- read: `slack_search_public`, `slack_search_public_and_private`, `slack_search_channels`,
  `slack_search_users`, `slack_search_emojis`, `slack_read_channel`, `slack_read_thread`,
  `slack_read_canvas`, `slack_read_file`, `slack_read_list`, `slack_read_user_profile`,
  `slack_list_user_channels`, `slack_list_channel_members`, `slack_get_reactions`
- write: `slack_send_message`, `slack_send_message_draft`, `slack_schedule_message`,
  `slack_create_canvas`, `slack_update_canvas`, `slack_create_conversation`, `slack_add_reaction`,
  `slack_create_list`, `slack_add_list_record`, `slack_update_list`, `slack_update_list_record`,
  `slack_get_file_upload_url`, `slack_complete_file_upload`

Whether Slack sets MCP `readOnlyHint` / `destructiveHint` annotations is unknown; the template sets
explicit policies (§6) so we do not depend on them.

### 2.2 Slack OAuth details that matter

- **User-only flow** (what the MCP metadata points at): authorize at `/oauth/v2_user/authorize`,
  exchange at `oauth.v2.user.access`, documented as following "the standard OAuth spec"; response has
  a top-level `access_token` (`xoxp-…`) **with `token_type: "user"`**, plus `authed_user{id,scope}`,
  `team{id}` ([oauth.v2.user.access](https://docs.slack.dev/reference/methods/oauth.v2.user.access)).
  The classic `oauth.v2.access` nests user tokens under `authed_user` and is not used here.
- **Errors come as HTTP 200 with `{"ok":false,"error":…}`**. Probed live today:
  `oauth.v2.user.access` with a bad code → `200 {"ok":false,"error":"invalid_code"}`; with a bad
  refresh token → `200 {"ok":false,"error":"invalid_refresh_token"}`.
- **Redirect URLs**: https; the sent `redirect_uri` must equal or be a sub-path of a configured
  Redirect URL; the same value in authorize and exchange; codes expire in 10 minutes
  ([installing with OAuth](https://docs.slack.dev/authentication/installing-with-oauth)).
- **Token rotation**: app-wide (bot, user and `xapp` tokens), cannot be turned off once on; access
  tokens last 12 h; refresh tokens are single-use and rotate
  ([token rotation](https://docs.slack.dev/authentication/using-token-rotation)). Off → user tokens
  never expire (no `expires_in`, no `refresh_token`).
- **PKCE**: enabling "PKCE" in app settings turns the app into a public client irreversibly, and
  refresh tokens then expire after 30 days ([PKCE](https://docs.slack.dev/authentication/using-pkce)).
  We stay a confidential client; whether Slack accepts the `code_challenge` the kernel always sends
  from a confidential client is to be verified live (the metadata advertises `S256`).
- **Approval**: with "Only allow pre-approved apps", members request the app and owners / app
  managers approve; an Enterprise Grid org policy applies it everywhere
  ([help 222386767](https://slack.com/help/articles/222386767)). Org-wide installs on Grid need an
  org owner / admin.
- **Revoke**: `auth.revoke` (token in the request; Tier 3)
  ([auth.revoke](https://docs.slack.dev/reference/methods/auth.revoke)). Not an RFC 7009 endpoint and
  not in the MCP metadata.
- **One app, bot plus user tokens**: supported (each person authorizes the same app for user
  scopes). Constraint: token rotation is app-wide, and the channel bot runs on a static `xoxb`
  (`token_rotation_enabled: false` in our `app-manifest.yaml`), so a shared app must keep rotation
  off.
- **Internal app**: an app that is not distributed (Manage Distribution off) and installed only in
  the workspace / Grid org where it was created. Each Capybara deployment's customer creates its own
  app; Capybara publishes none. A non-distributed app also cannot be authorized from other
  workspaces, which pins the connector to the company's workspace.

### 2.3 What core does today (`packages/kernel/src/tools/oauth/*`, core `fix/acceptance`)

- `auth.type: "oauth_code"`, `ownership: "personal"`, `discovery: "mcp" | "manual"`,
  `client: "dcr" | "manual"`, optional `scopes`, `tokenAuthMethod` (`credentials.ts`).
- `discovery: "mcp"` runs RFC 9728 → RFC 8414 discovery at install; `client: "manual"` takes
  `client: { clientId, clientSecret? }` from the **org admin at template install**
  (`plugin-install.ts` `missingTemplateInput`), stored as an org secret; rotated with
  `PUT …/credentials/org`. There is no deployment-level OAuth client.
- Connect: `POST /api/v1/orgs/:orgId/connectors/:id/connect` → authorization URL with
  `response_type=code`, `client_id`, `redirect_uri=<http.publicUrl>/api/v1/oauth/callback`, `state`
  (Redis, 10 min, single use, browser-bound cookie), PKCE S256, `scope` (space-joined), `resource`;
  callback checks RFC 9207 `iss` when present, exchanges the code and stores the person's tokens.
  First connection refreshes the tool snapshot with that person's token.
- `tokenRequest` (`tokens.ts`) requires HTTP 200 with a top-level `access_token`, **rejects any
  `token_type` other than Bearer** (`unsupported_token_type`), and treats an error only when it comes
  as 400 / 401 with an RFC 6749 `error`; anything else is "unavailable" and keeps the credential.
- Refresh 60 s before expiry under a cross-replica Redis lock; a 401 from the server forces one
  refresh; no refresh token → credential deleted → "connection required". Refresh errors
  `invalid_grant` / `invalid_client` / `unauthorized_client` delete the credential.
- Disconnect deletes the stored token; nothing is revoked at the provider.
- Tool policy default: `readOnlyHint: true` → `allow`, else `ask`; template `defaultToolPolicies`
  apply once the first snapshot exists (`policy_source 'template'`).
- The credential used for a call is the acting account's (`ctx.accountId` in `pipeline.ts`).

## 3. Chosen approach

A declarative connector template in `plugins/slack`, run by `connector-mcp`, with kernel-managed
OAuth via MCP discovery and a manually entered (pre-registered) client.

`plugins/slack/connectors/slack.json`:

```json
{
  "$schema": "https://capybarahq.com/schemas/connector-template.v1.schema.json",
  "displayName": { "zh": "Slack", "en": "Slack" },
  "description": "Search, read and send Slack messages, canvases, lists and files as the connected person, through Slack's MCP server.",
  "icon": "./icons/slack.svg",
  "template": {
    "plugin": "connector-mcp",
    "pluginVersion": "^0.1.0-rc.1",
    "connector": "mcp",
    "endpoint": { "url": "https://mcp.slack.com/mcp" },
    "auth": {
      "type": "oauth_code",
      "ownership": "personal",
      "discovery": "mcp",
      "client": "manual",
      "tokenAuthMethod": "client_secret_post",
      "scopes": ["search:read.public", "search:read.private", "search:read.mpim", "search:read.im",
                 "search:read.files", "search:read.users", "channels:history", "groups:history",
                 "mpim:history", "im:history", "channels:read", "groups:read", "mpim:read",
                 "im:read", "channels:write", "groups:write", "mpim:write", "im:write",
                 "chat:write", "canvases:read", "canvases:write", "lists:read", "lists:write",
                 "files:read", "files:write", "reactions:read", "reactions:write", "emoji:read",
                 "users:read", "users:read.email"]
    },
    "defaultToolPolicies": { "…": "see §6" }
  }
}
```

- No `editableEndpoint`: the URL is Slack's and is the same for everyone.
- `plugin.json` gains `dependencies: [{ "name": "connector-mcp", "version": "^0.1.0-rc.1" }]` so the
  template validates against a dependency at import.
- Scopes are explicit (not taken from metadata) so they are reviewed with the template and a
  Slack-side addition does not silently widen what we ask for. Scopes Slack later adds to the server
  need a template update.
- **(decided, 2026-11-08)** The first release ships this full set only, with no reduced variant
  (for example without DM scopes), unless the maintainer asks otherwise.
- **(decided, 2026-11-08)** The template ships **switched off by default** in an org, so an org that
  turns on `slack` only for the bot does not see 需要配置; an org admin switches the template on and
  enters the client when they want the connector. If the catalog cannot yet express a per-component
  default state inside a plugin, that is a core change to make alongside G1 (to check while planning).

### 3.1 Who configures what

| Who | Where | What |
|---|---|---|
| Customer's Slack admin | api.slack.com/apps | Creates the internal app (§8), sets the Redirect URL, approves / installs it |
| Super admin | Admin console → catalog | Imports the `slack` plugin (already the case for the bot); sets `http.publicUrl` (required for OAuth) |
| Org admin | Org → plugins → Slack | When turning on the plugin's Slack connector template: enters `client { clientId, clientSecret }` from the Slack app's Basic Information. Rotation: `PUT …/credentials/org` |
| Member | 我的连接 / `/account/connections` | Clicks Connect → Slack consent screen → back to Capybara |

The client is org-level today. A deployment with several orgs on one Slack workspace enters the same
client in each org. A platform-level client (G4) is **later, not in the first release (decided,
2026-11-08)**.

### 3.2 Connect, refresh, revoke

1. Member clicks Connect; kernel `start()` builds
   `https://slack.com/oauth/v2_user/authorize?response_type=code&client_id=…&redirect_uri=<publicUrl>/api/v1/oauth/callback&state=…&code_challenge=…&code_challenge_method=S256&scope=<space-joined>&resource=https://mcp.slack.com`.
2. Slack shows consent for the user scopes; in approval-required workspaces the app must already be
   approved, else the member sees Slack's request-approval screen.
3. Callback: `state` and browser binding checked, `iss` checked if Slack sends one, code exchanged at
   `oauth.v2.user.access` with `client_secret_post`. Requires G1 (token type).
4. Stored as the member's personal credential (envelope-encrypted, `capybara.secrets`); first
   connection refreshes the tool snapshot, then template policies apply.
5. Refresh: with rotation off (the recommended v1 setup, §8) there is no expiry and no refresh;
   a revoked token gets a 401 from `mcp.slack.com` → forced refresh finds no refresh token →
   credential deleted → "connection required" card / page. With rotation on, the kernel refreshes
   12 h tokens via `refresh_token`; requires G2 so a dead refresh token deletes the credential.
6. Revoke: Disconnect in 我的连接 deletes the stored token. The first release does not call
   `auth.revoke`: G3 is **later (decided, 2026-11-08)**. The README tells people and admins to remove
   the authorization in Slack (Apps → Manage) when needed.
   Removing a member from the org follows the kernel's existing personal-credential cleanup.

## 4. Which Slack app: reuse the channel app or a separate one

Both work. **(decided, 2026-11-08)** The README default is **a separate internal app "Capybara
connector"** (user scopes only, MCP on, no bot, no Socket Mode), shipped as
`plugins/slack/app-manifest.connector.yaml`; the maintainer may still revise this. Reasons:

- Least privilege per app: the bot app's approval stays bot-only; user scopes do not appear on the
  bot's install screen and vice versa.
- Rotation becomes a free choice for the connector (it stays off for the bot's static `xoxb`).
- An admin can disable one without breaking the other.

Reusing the channel app is allowed and documented as the alternative, **as long as token rotation
stays off**: rotation is app-wide and would make the channel bot's static `xoxb` token expire. Add
the user scopes, `is_mcp_enabled: true` and the Redirect URL
`<http.publicUrl>/api/v1/oauth/callback` to the existing app. Slack prefix-matches Redirect URLs, so one entry
`<http.publicUrl>/api/v1/` covers both this callback and Sign in with Slack's
`/api/v1/auth/sso/slack/callback`.

## 5. What the person sees

- 我的连接 lists "Slack" with Connect / Disconnect and the connected state (no token, no scopes
  detail beyond the template's).
- In a conversation, a Slack tool with no credential yields the kernel's standard "connection
  required" card (web and channel), linking to the connect flow.
- Writes ask for approval (§6) in the web UI or as an approval card in a channel.

## 6. Tools and approval

**(decided, 2026-11-08)** Per-tool policies are configured on the tools page (org and agent tool
policies). The template only ships defaults: reads `allow`, writes `ask`, the private / DM search
`ask`. Tools that appear later fall back to annotations (`ask` without `readOnlyHint`).
Template `defaultToolPolicies` (local names):

| Policy | Tools | Why |
|---|---|---|
| `allow` | `slack_search_public`, `slack_search_channels`, `slack_search_users`, `slack_search_emojis`, `slack_read_channel`, `slack_read_thread`, `slack_read_canvas`, `slack_read_file`, `slack_read_list`, `slack_read_user_profile`, `slack_list_user_channels`, `slack_list_channel_members`, `slack_get_reactions` | Read-only, the person's own visibility |
| `ask` | `slack_search_public_and_private` | Reaches DMs and private channels in one call; first use in a conversation is a visible decision (see §7.3) |
| `ask` | `slack_send_message`, `slack_schedule_message`, `slack_send_message_draft`, `slack_create_conversation`, `slack_add_reaction`, `slack_create_canvas`, `slack_update_canvas`, `slack_create_list`, `slack_add_list_record`, `slack_update_list`, `slack_update_list_record`, `slack_get_file_upload_url`, `slack_complete_file_upload` | Writes as the person; others see them as the person's own |

No `deny` defaults. The policy names are verified against a live `tools/list` before release (§10);
a renamed tool would otherwise lose its template policy and fall back to annotations.

## 7. Security and privacy

### 7.1 Tokens

- Per person only (`ownership: "personal"`); no org-level Slack user or bot token in this
  connector. The client secret is an org secret (write-only in the API, "set" on read).
- Tokens and the client secret are registered with the kernel's redaction: tool results, errors,
  events, archives and logs are redacted with the values injected for the call. `connector-mcp`
  never echoes headers.
- Slack tokens never enter model context; the model sees only tool results.

### 7.2 What an org admin can see

- That a member has connected (connections list, audit `connector.credential.set`), never the token.
- Not the member's Slack content, except where it lands in conversations the admin may already see
  under the kernel's existing conversation privacy rules (trajectories are private: 404 to others).

### 7.3 Channel and DM privacy

- The agent sees what the person sees in Slack, nothing more (Slack enforces it per user token).
- Known consideration: in a Slack channel thread (via `channel@1`), the tool call runs on the
  **acting member's** token, and the reply goes to a channel others read, so the agent could quote
  the member's DMs or private channels into that channel. **(decided, 2026-11-08)** No special
  kernel rule for group threads: this relies on the configured tool policies (the template's
  `ask` default for `slack_search_public_and_private`, plus whatever the org or agent sets on the
  tools page).
- **(decided, 2026-11-08)** No identity check: a member may connect a different Slack account than
  their bound Slack identity (`slack:<team>`); connecting another account is allowed. The token is
  still theirs and only reaches their own calls.
- Guests: Slack's RTS excludes guests; guests are not org members via directory sync anyway.

### 7.4 Slack data terms

RTS says retrieved data must not be stored or copied. Capybara's event log keeps tool results (the
replay invariant), and big results are archived. **(decided, 2026-11-08)** Accepted as a risk:
Slack tool results stay in the event log and archives exactly as for any other connector; nothing
special is done for Slack. The app is the customer's own internal app under its own Slack agreement.

## 8. What the customer does in Slack

Separate app (recommended), from `app-manifest.connector.yaml`:

```yaml
display_information:
  name: Capybara connector
  description: Lets Capybara agents use Slack as you, with your permission.
oauth_config:
  redirect_urls:
    - https://capybara.example.com/api/v1/oauth/callback   # <http.publicUrl>/api/v1/oauth/callback
  scopes:
    user: [ …the 30 scopes in §3… ]
settings:
  is_mcp_enabled: true
  org_deploy_enabled: false     # true for an Enterprise Grid org-wide install
  socket_mode_enabled: false
  token_rotation_enabled: false # true only once G2 has shipped
```

Steps (README): create from the manifest in the company workspace; leave Manage Distribution off
(internal); do not enable PKCE; install / approve the app (workspace admin, or org admin on Grid);
copy Client ID and Client Secret into the org's Slack connector; members connect from 我的连接.

## 9. Fallback: Web API tools with user tokens

Only if Slack's MCP proves unusable for us (e.g. Q2 or plan gating). A `connector-openapi` template
needs an OpenAPI document for Slack's Web API; Slack publishes none that is maintained, and every
method answers `200 {"ok":false}` on errors, so a small set of hand-written tools in the `slack`
extension (`ctx.tools` with a personal OAuth credential) would be more robust than OpenAPI. That
needs a way for an extension tool to use a connector's personal OAuth token, which does not exist
(a new contract, core first). Methods: `conversations.history` / `conversations.replies` (Tier 3;
internal apps keep normal limits, [2025-05-29 change](https://docs.slack.dev/changelog/2025/05/29/rate-limit-changes-for-non-marketplace-apps)),
`users.conversations` (Tier 3), `assistant.search.context` (RTS, internal apps allowed, 10/min per
user) instead of legacy `search.messages`, `chat.postMessage` with a user token (`chat:write`),
`users.info` (Tier 4). The classic `oauth.v2/authorize` + `user_scope` returns the token under
`authed_user`, which the kernel cannot read (G5). Not planned unless needed.

## 10. Gaps in core

| # | Gap | Needed for | Core first? |
|---|---|---|---|
| G1 | `tokenRequest` rejects `token_type: "user"` (`unsupported_token_type`). Proposal: reject only known non-bearer schemes (`DPoP`, `mac`, `N_A`) and store anything else as Bearer, or accept a template `auth.tokenType` override. | Connecting at all | **Yes, blocker** |
| G2 | Token-endpoint errors as `200 {"ok":false,"error":…}` count as "unavailable", so a dead refresh token never deletes the credential. Proposal: a 200 body with no `access_token` and an RFC 6749-shaped `error` is a grant error; treat `invalid_refresh_token` and `token_revoked` like `invalid_grant`. | Token rotation on; correct errors | **Yes**, in the first core PR (decided order) |
| G3 | Disconnect does not revoke at the provider. Proposal: optional `auth.revocation` (RFC 7009 from metadata, or a template `revokeUrl` with Slack's `auth.revoke` form) called best-effort in `afterCommit`. | Clean revoke | **Later, not in the first release (decided, 2026-11-08)**; README documents manual removal |
| G4 | OAuth client only org-level. Proposal: platform-level client for a platform template (super admin enters once; orgs inherit, may override), in line with `orgAccess` config levels. | Multi-org deployments | **Later, not in the first release (decided, 2026-11-08)**; the client is entered per org |
| G5 | Nested token responses (`authed_user.access_token`) unsupported. | Only the §9 fallback with classic `oauth.v2.access` | Only if the fallback is built |
| G6 | `@capybara-hq/testing` `startFakeOAuthServer` has no way to answer like Slack (`token_type: "user"`, 200 + `ok:false`). Proposal: a `tokenResponse` hook or a `dialect: "slack"` option. | Tests for G1 / G2 here | Yes, with G1 |
| G7 | No extra authorize parameters (e.g. Slack `team=T…` to preselect the workspace). | Nicety on multi-workspace Grid | No |
| G8 | To verify live, may become gaps: Slack accepting `code_challenge` from a confidential client, the `resource` parameter, space-separated `scope` on `v2_user/authorize`, whether Slack sends `iss` on the callback, and that a revoked token yields HTTP 401 from `mcp.slack.com`. | Connecting | Becomes "yes" if any fails |

The plugin-install coupling (an org that turns on `slack` only for the bot would see 需要配置 until the
template gets a client; spec P2-6 / P2-10 in core's plugin-component-management design) is resolved
by shipping the template switched off by default (§3, decided 2026-11-08).

## 10a. Order of work

1. **Core PR**: G1 (accept a `token_type` other than Bearer), G2 (`{"ok":false,"error":…}` on HTTP
   200 from the token endpoint treated as a token error), G6 (Slack-like mode in
   `startFakeOAuthServer`); plus the default-off template state if the catalog lacks it.
2. **Core release**, then the dependency upgrade in this repository.
3. **Plugins PR**: `connectors/slack.json`, the `connector-mcp` dependency in `plugin.json`,
   `app-manifest.connector.yaml`, README, template and kernel-level tests.
4. **Live check**: the G8 items by hand through a real Slack workspace, then the gated live test.

## 11. Testing

- **Template unit test** (`plugins/slack/test/connector-template.test.ts`): `parseConnectorTemplateFile`
  accepts the file; scopes and policies match a pinned list; every policy name is in the expected
  tool list.
- **Kernel-level e2e** (`plugins/slack/test/kernel/slack-connector.test.ts`, `startTestKernel` +
  model-fake + `connector-mcp` from the dependency): `startFakeOAuthServer` in a Slack-like mode (G6:
  `token_type: "user"`, no DCR, `client_secret_post`, `ok:false` errors) behind
  `startFakeMcpServer({ verifyBearer, protectedResource: { advertise: "header" } })` serving the
  Slack tool names; install the plugin with a `client`; connect as member A through
  `/connect` → fake authorize → `/api/v1/oauth/callback`; assert A's read tool runs with A's token,
  a write asks, member B without a connection gets "connection required", B's call never carries A's
  token, revoked token → reconnect required, and (with G2) a rotation refresh and an
  `invalid_refresh_token` deleting the credential. Redaction: the fake echoes the bearer and the
  events contain `[REDACTED]`.
- **Live** (`plugins/slack/test/live/connector.live.test.ts`), only with
  `CAPYBARA_TEST_LIVE_TOOLS=1` and `CAPYBARA_TEST_SLACK_USER_TOKEN` (a user token from the internal
  test app, obtained once by hand) plus `CAPYBARA_TEST_SLACK_CHANNEL` (a test channel id): `tools/list`
  matches the template's names, `slack_search_public` and `slack_read_channel` succeed,
  `slack_send_message` posts into the test channel (deleted or left in a dedicated channel). The
  interactive OAuth hop is verified once by hand for G8 and recorded in the PR. Keys stay in
  `~/.capybara-test.env`, never printed.

## 12. Decisions and open questions

Decided by the maintainer (2026-11-08):

1. Real-time Search data terms: accepted as a risk; tool results stay in the event log (§7.4).
2. Tool policy: configured on the tools page; the template only ships defaults. Group-thread
   leakage gets no special kernel rule and relies on the configured policies (§6, §7.3).
3. Slack app: README default is a separate "Capybara connector" app; reusing the channel app is
   allowed only with token rotation off (§4). May still be revised.
4. The connector template ships switched off by default (§3).
5. Scopes: the full set only for the first release (§3).
6. No identity check; connecting a different Slack account is allowed (§7.3).
7. G3 (revoke on disconnect) and G4 (platform-level OAuth client): later (§10).

Still open:

- **Plan gating**: Slack documents no plan requirement for MCP. Is a supported-plans statement
  needed before shipping, or is checking our test workspace's plan enough?
