# Google plugin: Sign in with Google and Google Workspace connectors

- Status: draft for maintainer review
- Date: 2026-11-22
- Issue: [#139](https://github.com/capybara-hq/plugins/issues/139)
- Plugin: `plugins/google` (new; `@capybara-hq/plugin-google`)
- Phases: **phase 1** (Sign in with Google, `identity-source@1`) ships alone first; **phase 2**
  (Google Workspace connector templates on `connector-mcp`) follows in its own PR, after one core
  change (§9.1).

## 1. Intent

Many organizations run on Google Workspace. People there expect to sign in with their Google
account, and the work agents should help with lives in Gmail, Drive, Calendar, Sheets, Docs, Slides
and BigQuery. Capybara has neither today: the identity sources are Slack and Lark, and a deployment
that wants Google tools has to hand-write MCP connector settings for each Google service.

### Goals

- **Phase 1.** A `google` extension providing `identity-source@1`: OpenID Connect against Google,
  PKCE and nonce through the kernel's SSO flow, the ID token verified against Google's JWKS, the
  Workspace hosted domain (`hd`) enforced server-side on the ID token, consumer accounts refused
  unless the super admin allows them, a setup guide for the Google Cloud console and read-only
  setup checks that never return a secret.
- **Phase 2.** Connector templates for Google's hosted remote MCP servers (Gmail, Drive, Calendar,
  Sheets, Docs, Slides, BigQuery), each member connecting their own Google account with OAuth
  through a client the org admin registers; reads allowed, writes asked, by default.

### Non-goals

- A generic OIDC identity source (useful, separate work; Google needs `hd` handling and its own
  guide anyway).
- `directory@1` (Admin SDK Directory API) and a Google Chat `channel@1` bot: later, see §8.
- Our own Gmail / Drive tool implementations. Gaps in Google's MCP servers (sending mail, Forms,
  which has no hosted MCP server) are a later extension-tools change.
- A Capybara-owned, Google-verified OAuth client. Every deployment registers its own client in its
  own Google Cloud project.

### Anti-goals (never)

- Restricting sign-in by the `hd` **authorization URL parameter** alone. It is a UI hint that the
  browser can strip; the `hd` **claim in the verified ID token** is the only gate.
- Using the email address as the identity key. Google: "Don't use the `email` field as a unique
  identifier" ([OIDC][oidc]).
- Reporting `emailVerified: true` for an address Google is not authoritative for (§4.4): that would
  let a consumer Google account created on `alice@customer.com` merge into Alice's account.
- A shared org Google credential through which members read each other's mail or files. Every
  connector call runs on the caller's own token.
- Stdio MCP. Google's servers are remote Streamable HTTP servers; nothing here runs a local process.

## 2. Findings (sources accessed 2026-11-21 / 22 unless dated)

### 2.1 Sign in with Google (OpenID Connect)

| Topic | Finding |
|---|---|
| Discovery | `https://accounts.google.com/.well-known/openid-configuration` (live 200) ([OIDC][oidc]) |
| Endpoints | authorize `https://accounts.google.com/o/oauth2/v2/auth`, token `https://oauth2.googleapis.com/token`, JWKS `https://www.googleapis.com/oauth2/v3/certs`, userinfo `https://openidconnect.googleapis.com/v1/userinfo` (discovery document) |
| Issuer | `iss` is "Always `https://accounts.google.com` or `accounts.google.com`" ([OIDC][oidc]); both must be accepted |
| Signing | RS256 (`id_token_signing_alg_values_supported`) |
| PKCE | Discovery advertises `code_challenge_methods_supported: ["plain","S256"]`; the web-server page does not describe PKCE for confidential clients, but the token endpoint accepts `code_verifier` ([web server][websrv], discovery). We send S256 (§4.2) |
| `nonce` | Supported, echoed in the ID token ([OIDC][oidc]) |
| `hd` parameter | "Don't rely on this UI optimization to control who can access your app, as client-side requests can be modified." ([OIDC][oidc]) |
| `hd` claim | "The domain associated with the Google Workspace or Cloud organization of the user"; "You must check this claim when restricting access to a resource to only members of certain domains"; absent = "the account does not belong to a Google hosted domain" ([OIDC][oidc]). Not listed in discovery `claims_supported`, but documented |
| `email` domain | "You also can't rely on the domain of the `email` claim to identify users of Google Workspace or Cloud organizations" ([OIDC][oidc]) |
| Email authority | Google is authoritative when "`email` has a `@gmail.com` suffix" or "`email_verified` is true and `hd` is set"; otherwise "Google is not authoritative and password or other challenge methods are recommended" ([verify ID token][gsiverify]) |
| `sub` | "Use `sub` … as the unique-identifier key" ([OIDC][oidc]) |
| `azp` | The authorized presenter; "only needed when the party requesting the ID token is not the same as the audience" ([OIDC][oidc]) |
| Scopes | `openid email profile` are non-sensitive: no app verification, and refresh-token expiry rules for apps in Testing do not apply to them ([OAuth 2.0][oauth2]) |

### 2.2 Google's hosted MCP servers

Sources: [WS] [Configure the Workspace MCP servers][ws]; [SP] [Supported products][sp];
[BQ] [Use the BigQuery MCP server][bq]; [BLOG] [Workspace updates, 2026-05-01][blog];
[GMREF] [Gmail MCP reference][gmref]. Live columns come from unauthenticated probes on 2026-11-21
UTC (`initialize`, `tools/list`, `tools/call`, the metadata documents); no credentials were used.

| Server | Endpoint (confirmed in docs and live) | Stage | Scopes Google documents [WS] / [BQ] | Tools (live `tools/list`; `ro` = `readOnlyHint`) |
|---|---|---|---|---|
| Gmail | `https://gmailmcp.googleapis.com/mcp/v1` | Developer Preview | `gmail.readonly`, `gmail.compose`, `gmail.modify` | ro: `search_threads`, `get_thread`, `get_message`, `list_drafts`, `get_draft`, `list_labels`. Write: `create_draft`, label / unlabel thread and message, `update_message_labels`, `create_label`, `apply_sensitive_*_label`, trash / untrash, mark / unmark spam. **No send tool.** [GMREF] lists 10 of the 23 live tools |
| Drive | `https://drivemcp.googleapis.com/mcp/v1` | Developer Preview | `drive.readonly`, `drive.file` | ro: `search_files`, `list_recent_files`, `get_file_metadata`, `get_file_permissions`, `read_file_content`, `download_file_content`. Write: `create_file`, `copy_file`, `upload_file_revision` (destructive) |
| Calendar | `https://calendarmcp.googleapis.com/mcp/v1` | Developer Preview | `calendar.calendarlist.readonly`, `calendar.events.freebusy`, `calendar.events.readonly`, `calendar.events` | ro: `list_events`, `get_event`, `search_events`, `list_calendars`, `suggest_time`. Write: `create_event`, `update_event`, `delete_event`, `respond_to_event` |
| Sheets | `https://sheetsmcp.googleapis.com/mcp/v1` | Developer Preview | `drive.readonly`, `drive.file`, `spreadsheets.readonly`, `spreadsheets` | ro: `get_spreadsheet`, `get_values`. Write: `update_spreadsheet`, `update_values`, `update_formulas`, `insert_dimension` |
| Docs | `https://docsmcp.googleapis.com/mcp/v1` | Developer Preview | `drive.readonly`, `drive.file`, `documents.readonly`, `documents` | ro: `read_doc`. Write: `update_doc` |
| Slides | `https://slidesmcp.googleapis.com/mcp/v1` | Developer Preview | `drive.readonly`, `drive.file`, `presentations.readonly`, `presentations` | ro: `read_presentation`, `read_slide_page`, `read_slide_page_thumbnail`. Write: `update_presentation` (destructive) |
| BigQuery | `https://bigquery.googleapis.com/mcp` (no `/v1`) | **Uncertain**: no label on [SP]; a January 2026 Cloud blog called it Preview | `https://www.googleapis.com/auth/bigquery` | ro: `list_dataset_ids`, `get_dataset_info`, `list_table_ids`, `get_table_info`, `execute_sql_readonly`, `get_query_results`, `get_job`. Write: `execute_sql`, `cancel_job`. [BQ] documents six tools |

Also live, not in the issue's list (candidates for later, §8): Chat
`https://chatmcp.googleapis.com/mcp/v1` (write calls also need a Chat app in the project [WS]),
People `https://people.googleapis.com/mcp/v1` (read-only; **not** `peoplemcp.…`, which is 404),
Workspace search `https://workspacemcp.googleapis.com/mcp/v1` (one read-only `search_corpus` over
Gmail, Drive, Calendar and Chat), and some sixty Google Cloud servers at
`https://<service>.googleapis.com/mcp` [SP]. **Forms has no hosted server**
(`formsmcp.googleapis.com/mcp/v1` is 404 and no page lists one).

Protocol and auth facts that shape the templates:

- **Transport**: Streamable HTTP; `initialize` answers plain `application/json` (protocol
  `2025-06-18`), `GET` is 405 (no SSE stream), no `Mcp-Session-Id` (stateless) [WS] [BQ] (live).
- **Unauthenticated discovery works**: `initialize` and `tools/list` answer 200 without a token;
  only `tools/call` answers 401 with `WWW-Authenticate: Bearer resource_metadata=
  "https://<host>/.well-known/oauth-protected-resource/<tool>"` (a per-tool document listing the
  minimal scopes for that tool).
- **Protected-resource metadata**: the bare `/.well-known/oauth-protected-resource` is 404; the
  path form `/.well-known/oauth-protected-resource/mcp/v1` (`/mcp` for BigQuery) is 200, with
  `authorization_servers: ["https://accounts.google.com/"]` (**trailing slash**). Google's
  authorization-server metadata says `issuer: "https://accounts.google.com"` (no slash). Per-tool
  documents name `resource` as `https://<host>/mcp` while the server-level one says `/mcp/v1`.
- **No dynamic client registration** (no `registration_endpoint`): the customer creates a Web
  application OAuth client [WS].
- **Customer setup** [WS]: enable the product API **and** the matching MCP service in a Google Cloud
  project (`gmailmcp.googleapis.com`, `drivemcp…`, `calendarmcp…`, `sheetsmcp…`, `docsmcp…`,
  `slidesmcp…`; BigQuery: enable its MCP server, Service Usage Admin needed ([enable MCP][enable]));
  create a Web OAuth client with the redirect URI and **"Use this client for an AI-powered agent"**
  selected; consent screen Internal where available, else External with test users. BigQuery also
  needs `roles/mcp.toolUser`, `roles/bigquery.jobUser`, `roles/bigquery.dataViewer` for each user
  [BQ]. No Workspace admin-console step is required; App access control can still block the client.
- **Google OAuth rules** ([web server][websrv], [OAuth 2.0][oauth2]): a refresh token comes only
  with `access_type=offline`, and only on first consent unless `prompt=consent`; granular consent is
  on by default, so a person may grant a subset of the scopes (the token response's `scope` says
  which); an External app in Testing gets refresh tokens that expire after **7 days**; Gmail-scoped
  refresh tokens die on password change; 100 refresh tokens per account per client.
- **Restricted scopes** ([restricted scopes][restricted]): Gmail's read / modify scopes (including
  `gmail.readonly`) and `drive.readonly` are restricted. A production External app
  needs verification plus a yearly CASA assessment; an **Internal** app (consent screen user type
  Internal, project owned by the Workspace org) is exempt.

### 2.3 Still uncertain (re-verify when phase 2 is written)

1. Whether the Workspace servers need enrollment in the Developer Preview Program ([WS] says "as
   part of the Google Workspace Developer Preview Program"; [BLOG] says open to all customers).
2. BigQuery's stage (above) and the exact enable command (`gcloud beta services mcp enable` appears
   in a search snippet, not on [BQ]).
3. Whether the OAuth client must live in the project where the MCP services are enabled, and which
   project's enablement and quota a call is checked against.
4. [BQ] says "Custom redirect URIs aren't supported"; whether that refuses a third-party Web
   client's redirect URI, and what the "AI-powered agent" client setting enforces.
5. The `resource` mismatch (`/mcp` vs `/mcp/v1`): quirk or intended.
6. Tool sets still move during the preview (Gmail: 10 documented, 23 live).
7. PKCE for confidential Web clients: advertised in discovery, not described in prose.
8. Whether `gmail.drafts.create` (seen in a per-tool metadata document) is a published scope.

## 3. Packaging

**One plugin, `plugins/google`**, like `slack`: one extension (phase 1, `identity-source@1` and its
setup checks), the connector templates (phase 2, on `connector-mcp`), guides, README, tests.
`plugin.json` depends on `connector-mcp` (`^0.1.0-rc.1`) from phase 2 on. The icon is Google's own
mark (a brand plugin, added to the brand list in `tools/checks/src/plugin-icons.ts`), each template
carries its product icon.

Why one plugin: the issue's reasoning holds (an admin thinks "connect Google"; the same Google Cloud
project and OAuth client serve sign-in and the connectors). The cost: a deployment that only wants
the connectors still loads a small extension it never enables as a login source; that extension does
nothing until `google` is listed in `auth.loginSources`.

## 4. Phase 1: Sign in with Google

### 4.1 Where config lives

`identity-source@1` is **deployment-level** and not org-scoped (core Ruling P1): the login page runs
before any org is known, and the kernel passes `config.deployment` to `authorizeUrl` and `callback`
(`SsoFlow` reads `registry.deploymentConfig(plugin)`). So **no field carries an org level**
(`orgAccess`): every field is platform-only and hidden from orgs. An org that wants "only our
Workspace domain" gets it through the platform's `allowedDomains`, and which accounts join which
org is still decided by invitations, `auth.trustedIdentitySources` (also a platform setting, not an
org one as the issue says) and, later, the directory. Per-org Google clients are out of scope (§10,
D4).

### 4.2 Config (`config.deployment`, `src/config.ts`)

| Field | Type | Default | Notes |
|---|---|---|---|
| `clientId` | string, optional | | The Web OAuth client id (`….apps.googleusercontent.com`). Login is unavailable while empty |
| `clientSecret` | `secret(string)`, optional | | The client secret; sealed at rest, redacted in logs, never in a check result |
| `allowedDomains` | string[] (lowercased hostnames, max 50) | `[]` | Workspace / Cloud Identity primary domains (`hd` values). Non-empty: the ID token's `hd` must be present and listed |
| `allowConsumerAccounts` | boolean | `false` | Only read when `allowedDomains` is empty. `false`: an ID token without `hd` is refused (any Workspace domain may sign in). `true`: consumer accounts (`@gmail.com` and Google accounts on other addresses) may sign in too |
| `endpoints` | object, optional, advanced | Google's | `authorizationUrl`, `tokenUrl`, `jwksUrl`, `issuers` (array). Only for tests and egress proxies, like Slack's `apiUrl` / `openidUrl`; platform-only, so no org can point it elsewhere |

Validation: `allowedDomains` entries are hostnames (ASCII labels with inner hyphens, a letter or
`xn--` TLD, after trimming and ASCII lowercasing; the regex is `src/domain.ts`), deduplicated. Invalid config never fails startup (core rule): `authorizeUrl` throws, and the kernel
shows `sso.unavailable` on the login page.

`authorizeUrl` is synchronous in the contract, so the endpoints are fixed constants (Google says to
hard-code the discovery URL; the authorization endpoint has been stable for years), not fetched
from discovery at login time. The setup check (§4.6) reads discovery and fails when Google's
published endpoints ever differ from ours.

### 4.3 The flow

`authorizeUrl({ config, redirectUri, state, nonce, codeChallenge, codeChallengeMethod })`:

```
https://accounts.google.com/o/oauth2/v2/auth?response_type=code&client_id=…
  &redirect_uri=<publicUrl>/api/v1/auth/sso/google/callback
  &scope=openid%20email%20profile&state=…&nonce=…
  &code_challenge=…&code_challenge_method=S256
  [&hd=<domain>]            # only when allowedDomains has exactly one entry: a UI hint
  [&prompt=select_account]  # D6
```

No `access_type=offline`: login needs no refresh token, and the plugin stores no Google token.

`callback({ config, redirectUri, query, nonce, signal, codeVerifier })`:

1. `query.error` -> throw (the kernel already maps `access_denied` before calling us). Missing
   `code` -> throw.
2. `POST tokenUrl` (form): `grant_type=authorization_code`, `code`, `redirect_uri`, `client_id`,
   `client_secret` (`client_secret_post`), `code_verifier`. One request, `signal` combined with a
   10-second timeout, no retries. The error carries only Google's `error` code and the HTTP status,
   never the body, code or secret.
3. Verify `id_token` with `jose` (`createRemoteJWKSet` over `jwksUrl`, one key set per URL created in
   the factory: a read-only cache that is correct when lost): `algorithms: ["RS256"]`,
   `issuer: ["https://accounts.google.com", "accounts.google.com"]`, `audience: clientId`,
   `requiredClaims: ["exp", "iat", "sub", "nonce"]`, `clockTolerance: 60`; then `nonce` must equal
   the kernel's nonce (constant-time compare); if `azp` is present it must equal `clientId`.
4. **Hosted-domain gate, on the verified claims only** (never on the URL `hd` parameter, never on
   the email domain):
   - `hd` = the `hd` claim lowercased, or undefined. A present `hd` that is not a hostname (the
     same rule as `allowedDomains`) is refused, so it can never become a tenant such as `consumer`.
   - `allowedDomains` non-empty: refuse unless `hd` is defined and listed.
   - `allowedDomains` empty and `allowConsumerAccounts` false: refuse unless `hd` is defined.
   - Otherwise accept.
   A refusal throws `"Google account not allowed: hosted domain <hd | none> is not permitted"` (the
   domain is not a secret; no email in the message). Today the kernel shows it as
   `sso.provider_error`; §9.2 proposes a precise reason code.
5. No userinfo call: the ID token carries `sub`, `email`, `email_verified`, `hd`, `name`, `picture`
   for `openid email profile`. (One request fewer inside the kernel's 15-second callback budget.)

### 4.4 The identity

| `ExternalIdentity` field | Value |
|---|---|
| `externalId` | `sub` |
| `tenantId` | the `hd` claim lowercased; **`consumer`** for an account without `hd` |
| `source` | `google:<tenantId>` (the kernel checks it equals `${plugin}:${tenantId}`, Ruling A19) |
| `email` | `email` lowercased, when present |
| `emailVerified` | **`email_verified === true` and Google is authoritative**: `hd` is set, or the address ends in `@gmail.com` ([verify ID token][gsiverify]). False otherwise |
| `displayName` | `name`, else `given_name family_name`, else the email's local part, else `sub` |
| `avatarUrl` | `picture`, when it is an `https:` URL |

Why the tenant is `hd`: trust in `auth.trustedIdentitySources` is per tenant. With `hd` as tenant
the super admin can trust `google:example.com` (their own Workspace, whose admins control every
address in it) without trusting every Google account in the world. `consumer` contains no dot, so it
can never collide with a domain. The README and the guide say plainly: **never list
`google:consumer` in `auth.trustedIdentitySources`**; anyone can create a Google account.

Known cost: a person's `hd` changes only when their organization changes its primary domain or the
account moves between organizations. Then the same `sub` arrives under a new `source` and becomes a
new identity row (the old account is reachable again by merging with a verified email into a
trusted source, or by an admin). Accepted: the alternative (`google:google` + `sub`) loses per-domain
trust (D3).

A Workspace user's email may be on a secondary domain of the same organization, so we do **not**
require the email domain to equal `hd` (the issue proposed it; Google says the email domain does not
identify the organization).

The same key is what a later `directory@1` must produce (§8): the Admin SDK user `id` is the Google
account id, the same number as `sub` (to verify when that work starts).

### 4.5 Setup guide (`guides/google-sign-in.md` + `.zh.md`, place `extension-deployment`)

Audience admin (the super admin's page of the extension). Variables: only the common ones; the
callback URL is written as `{{publicUrl}}/api/v1/auth/sso/google/callback` (a url variable at the
start of the value, as the validator requires). Steps:

1. Pick or create a Google Cloud project (owned by the Workspace organization, for the Internal
   user type).
2. Google Auth Platform -> Branding / Audience: user type **Internal** for a single Workspace
   (no verification needed for `openid email profile` either way); External when consumer accounts
   or several Workspace domains must sign in.
3. Clients -> Create client -> **Web application**; authorized redirect URI
   `{{publicUrl}}/api/v1/auth/sso/google/callback`. (Phase 2 adds `{{publicUrl}}/api/v1/oauth/callback`
   to the same client if the org uses it for connectors.)
4. Enter the client id and secret in this page's config; set `allowedDomains` (recommended) or
   decide on consumer accounts.
5. `::check google-discovery`, `::check google-client`.
6. Add `google` to `auth.loginSources`; optionally add `google:<your domain>` to
   `auth.trustedIdentitySources` (with the warning about `google:consumer`).

Every UI string (field labels, help, guide text, check texts, the source label) has zh and en; the
label is `{ zh: "Google", en: "Google" }`. zh copy follows core's terms (平台, 超级管理员, 智能体).

### 4.6 Setup checks (`permissions.setupChecks`, place `extension-deployment`)

Both read-only, one request each, `signal` on every request, no retries, fixed texts only (never a
secret, never a response body):

| Id | Request | ok | failing | unknown |
|---|---|---|---|---|
| `google-discovery` | `GET` the discovery document | issuer, `authorization_endpoint`, `token_endpoint`, `jwks_uri` equal ours (or the configured `endpoints`) | they differ (fix: "update the plugin") | network error, 5xx |
| `google-client` | `POST tokenUrl` with the configured client id and secret and the fixed invalid code `capybara-setup-probe` (the same probe the kernel runs for manual connector clients) | `invalid_grant` (client accepted, code refused) | `invalid_client` / `unauthorized_client` / 401 (fix: "re-copy the client id and secret") ; client id missing | anything else, including a 2xx (never stored) |

The probe uses the secret to authenticate, as login does, and nothing is written at Google or in
Capybara. The redirect URI cannot be checked this way: Google refuses an invalid code before it
compares redirect URIs, and the authorization endpoint answers with an HTML page we will not scrape.
The guide shows the exact URI to paste instead.

### 4.7 Extension manifest

```ts
defineExtension({
  name: "google",
  provides: [IDENTITY_SOURCE_EXTENSION_POINT],
  permissions: {
    network: ["accounts.google.com", "oauth2.googleapis.com", "www.googleapis.com"],
    setupChecks: ["google-discovery", "google-client"],
  },
  config: { deployment: GoogleDeployment },
  setup(ctx) { … },
});
```

No `secrets` permission (the kernel hands the config in), no hooks, no tools, no UI, no migrations,
no kv. Dependencies: `@capybara-hq/plugin-sdk`, `jose`, `zod`.

### 4.8 Security summary

- **State, nonce, PKCE**: generated and stored by the kernel (Redis, 10 minutes, single use, bound to
  the browser cookie); the plugin uses the nonce in the URL and checks it in the ID token, sends the
  S256 challenge and the verifier.
- **Redirect URI**: built by the kernel from `http.publicUrl` (`/api/v1/auth/sso/google/callback`);
  the plugin sends back the same value at the token exchange; Google matches it exactly against the
  client's registered URIs. No `webhookBaseUrl` is involved (that is for channel webhooks).
- **`hd` enforced on the verified ID token**, the URL parameter only a hint.
- **Confidential client** (`client_secret_post`) in addition to PKCE.
- Nothing from Google is stored by the plugin; the kernel stores the identity row.
- Errors and logs carry Google's error code and HTTP status only.

### 4.9 Tests

- **Unit** (`test/identity.test.ts`, `test/config.test.ts`, `test/checks.test.ts`): authorize URL
  shape (PKCE, nonce, `hd` hint only with one domain, no `access_type`); ID token verification with
  local `jose` keys over a local JWKS: wrong signature, wrong `aud`, each accepted `iss` form, an
  unknown `iss`, expired, missing / wrong nonce, `azp` mismatch; the hosted-domain matrix
  (allowed / not listed / missing `hd` with and without `allowConsumerAccounts`, upper-case `hd`);
  `emailVerified` matrix (`hd` + verified, `@gmail.com`, consumer on another domain -> false,
  `email_verified: false`); `tenantId` `consumer`; secrets never in error texts or check results;
  each check's ok / failing / unknown.
- **Kernel-level** (`test/login.test.ts`, one app per file): a real kernel with `auth.loginSources:
  ["google"]` against a fake Google: full login round trip creates `google:example.com` + `sub`;
  a refused domain ends on the login page with an error; merging into an existing account happens
  only when `google:example.com` is trusted and the email is authoritative; the kernel's own
  state / binding / PKCE checks still hold. Needs the fake OIDC provider in `@capybara-hq/testing`
  (§9.3).
- **Live** (`test/live/google.live.test.ts`): runs only with `CAPYBARA_TEST_GOOGLE_CLIENT_ID` and
  `CAPYBARA_TEST_GOOGLE_CLIENT_SECRET`; it runs both setup checks against Google (an interactive
  login cannot be automated) and verifies the discovery endpoints. The manual login (a Workspace
  account, a consumer account refused, a second domain refused) goes on the live acceptance list in
  the README.

### 4.10 Release

New package `@capybara-hq/plugin-google` at `0.1.0-rc.0` with a changeset; `package.json`
`repository.directory: plugins/google`; the Version Packages PR adds its `marketplace.json` entry.
The first publish of a new package name follows the repository's first-release rule for a new name
(maintainer dispatch if `release --auto` refuses). Not a bootstrap plugin; no core pin needed.

## 5. Phase 2: Google Workspace connector templates

### 5.1 Templates

Seven files `connectors/<id>.json`: `gmail`, `google-drive`, `google-calendar`, `google-sheets`,
`google-docs`, `google-slides`, `bigquery` (ids prefixed where the bare word is generic; D8). Each:

```json
{
  "displayName": { "zh": "Gmail", "en": "Gmail" },
  "description": "Search and read mail, write drafts and manage labels as the connected person, through Google's Gmail MCP server (Developer Preview). Each member connects their own Google account; an org admin enters the OAuth client of the company's Google Cloud project.",
  "icon": "./icons/gmail.svg",
  "defaultEnabled": false,
  "template": {
    "plugin": "connector-mcp",
    "pluginVersion": "^0.1.0-rc.1",
    "connector": "mcp",
    "endpoint": { "url": "https://gmailmcp.googleapis.com/mcp/v1" },
    "auth": {
      "type": "oauth_code",
      "ownership": "personal",
      "discovery": "manual",
      "authorizationUrl": "https://accounts.google.com/o/oauth2/v2/auth",
      "tokenUrl": "https://oauth2.googleapis.com/token",
      "client": "manual",
      "tokenAuthMethod": "client_secret_post",
      "scopes": ["https://www.googleapis.com/auth/gmail.readonly", "…"],
      "authorizationParams": { "access_type": "offline", "prompt": "consent", "include_granted_scopes": "true" }
    },
    "defaultToolPolicies": { "search_threads": "allow", "create_draft": "ask", "…": "…" }
  }
}
```

- **`discovery: "manual"`, not `"mcp"`.** With `"mcp"` the kernel's discovery would fail on Google
  today: the protected-resource metadata names `https://accounts.google.com/` and Google's
  authorization-server metadata says `issuer: "https://accounts.google.com"`, so the RFC 8414 issuer
  equality check refuses it. Manual endpoints also mean the kernel sends no `resource` parameter,
  which avoids the `/mcp` vs `/mcp/v1` mismatch (§2.3.5). Neither needs a core change.
- **`authorizationParams`** does not exist yet: §9.1. Without `access_type=offline` Google returns no
  refresh token, the access token dies after an hour and every member would reconnect hourly, so
  **phase 2 waits for that core change**.
- **Scopes** are the full URLs (`https://www.googleapis.com/auth/<name>`), the sets Google documents
  per server (§2.2), so every tool works. A read-only variant is D9.
- **`defaultEnabled: false`** while the servers are Developer Preview: an org admin switches on the
  services they use.
- **Endpoints not editable** (`editableEndpoint` omitted): there is one Google endpoint per service.

### 5.2 Default tool policies

Reads `allow`; every write `ask`; nothing `deny` by default (Google's own consent and the person's
approval suffice). Tools marked destructive by Google (`upload_file_revision`,
`update_presentation`, `delete_event`, Gmail trash and spam) stay `ask` like every write, and
BigQuery `execute_sql` is `ask` while `execute_sql_readonly` is `allow`. Tool names come from the
live lists in §2.2, re-read when the PR is written; tool keys have no dots.

### 5.3 What the admin and members do

- **Admin** (per template's guide, place `connector-template`, audiences admin and member): in the
  same Google Cloud project as sign-in (or another), enable the product API and its MCP service;
  add `{{oauthCallbackUrl}}` to the Web client's redirect URIs and select "Use this client for an
  AI-powered agent"; consent screen Internal (restricted Gmail and Drive scopes need no verification
  then; External production needs verification and CASA, External testing kills refresh tokens after
  7 days and only admits test users); create the connector from the template and enter the client
  id and secret. `::check capybara:oauth-token-endpoint` (the kernel's probe) verifies the client.
  BigQuery's guide adds the IAM roles per user and the project.
- **Member**: 我的连接 -> connect -> Google consent. The member guide says to keep all boxes ticked
  (granular consent lets a person untick scopes; the matching tools then fail with Google's
  insufficient-scope error).

The guide limit is 8 per plugin (`SETUP_GUIDE_LIMITS.guides`) and one per template: phase 1's guide
plus seven template guides use all eight. Adding Chat, People or Workspace search later needs a
higher limit or guide sharing (§9.5).

### 5.4 Security and privacy

- Personal ownership only: each call carries the caller's own token; the org admin holds only the
  OAuth client.
- Tokens stay in the kernel (`auth()` before each request, refresh 60 s before expiry, one
  `onUnauthorized` retry); `connector-mcp` never logs headers; the kernel redacts injected values.
- Results land in the conversation event log and archives like every connector result; the README
  states this for Workspace admins (Gmail and Drive content).
- A member's Google session-length policy or a password change can end the refresh token
  (`invalid_grant`): the kernel deletes the credential and the person sees "connection required".

### 5.5 Tests

- **Unit** (`test/connector-templates.test.ts`, like `plugins/github`): every template parses with
  the SDK's template schema, endpoint hosts are the Google hosts in §2.2, scopes are full URLs, every
  tool in the policies exists in a recorded tool list fixture (`test/fixtures/<id>-tools.json`, the
  live `tools/list` answer, refreshed by the live test), writes are never `allow`.
- **Guides** (`test/guides.test.ts`): every guide validates for its place in both languages.
- **Kernel-level**: install a template against `startFakeMcpServer` + `startFakeOAuthServer`
  (manual client) and connect a member: the authorize request carries `access_type=offline` and
  `prompt=consent`; a refresh token is stored; a refresh keeps it. (Needs §9.1 and the fake's
  "refresh token only with offline" mode, §9.3.)
- **Live** (`test/live/google-mcp.live.test.ts`, `CAPYBARA_TEST_LIVE_TOOLS` plus
  `CAPYBARA_TEST_GOOGLE_ACCESS_TOKEN`, a short-lived token minted outside the test): `tools/list`
  and one read-only call per server; the unauthenticated part (tool lists, 401 challenge, metadata
  shape) runs with `CAPYBARA_TEST_LIVE_TOOLS` alone and refreshes the fixtures.

### 5.6 Release

A minor changeset on `@capybara-hq/plugin-google` (phase 2 PR), after core releases §9.1 and the
plugins repo's lockfile picks up the SDK that has `authorizationParams`. The template's
`pluginVersion` stays `^0.1.0-rc.1` (no `connector-mcp` change is needed: the OAuth flow is the
kernel's).

## 6. Order of work

1. **Core (for phase 1 tests)**: OIDC mode in `startFakeOAuthServer` (§9.3); optional precise login
   error code (§9.2). Released as `@capybara-hq/testing` / kernel rc.
2. **Plugins, phase 1 PR**: `plugins/google` with the identity source, checks, guide, README, tests;
   changeset; release.
3. **Core (for phase 2)**: `authorizationParams` on `oauth_code` (§9.1), the fake's offline mode;
   released.
4. **Plugins, phase 2 PR**: templates, guides, icons, tests; changeset; release.

## 7. What changes for people

| Who | Phase 1 | Phase 2 |
|---|---|---|
| Super admin | Installs `google`, configures the client and domains on the extension's page, adds `google` to `auth.loginSources` | Nothing beyond the catalog |
| Org admin | Nothing (invitations, trusted sources as today) | Switches on the Google templates, creates connectors, enters the client |
| Member | A "Google" button on the login page | Connects each Google service once under 我的连接 |

## 8. Later (not in this design)

- `directory@1` through the Admin SDK Directory API (org-level config: a domain and a service
  account with domain-wide delegation, or an admin's OAuth grant; `DirectoryMember` keyed
  `google:<hd>` + user `id`; `suspended` / `archived` -> `active: false`). A design of its own: the
  credential model needs a decision, and the `id` = `sub` equivalence must be verified.
- Templates for Chat (needs a Chat app for writes), People (read-only directory search) and
  Workspace search (needs §9.5 for guides).
- Extension tools for what the MCP servers lack (send mail with attachments, Drive upload, Forms).
- A Google Chat `channel@1` bot.

## 9. Gaps in core

### 9.1 Extra authorization parameters on `oauth_code` (blocks phase 2)

The kernel's flow sends no extra authorize parameters (core writing-connectors: "No extra authorize
parameters"), and `ConnectorAuthSchema`'s `oauth_code` branch is strict. Google needs
`access_type=offline` (else no refresh token) and `prompt=consent` (else no refresh token on a
reconnect after the first grant). Proposal for a core design: an optional
`authorizationParams: Record<string, string>` on `oauth_code` (max 10 entries, names
`/^[a-z_]{1,40}$/`, values printable ≤ 200), refusing the names the kernel owns (`response_type`,
`client_id`, `redirect_uri`, `state`, `code_challenge`, `code_challenge_method`, `scope`,
`resource`, `nonce`, `request`, `request_uri`), appended in `flow.ts`. It also covers Slack's
`team=` noted in the same skill. This is an SDK public API change (changeset on
`@capybara-hq/plugin-sdk`, `gen:sdk-api`). The issue suggested a `connector-mcp` option; that would
not work: the OAuth flow is the kernel's, not the connector extension's.

### 9.2 A login refusal reason (nice to have, not blocking)

`SsoFlow.callback` maps every plugin error to `sso.provider_error` ("sign-in failed"). A person
whose domain is not allowed deserves "this Google account is not allowed on this platform". Proposal:
an SDK error class or duck-typed marker (`IdentitySourceRefused`) the kernel maps to a new
`sso.account_not_allowed` code with zh / en text. Phase 1 ships without it if needed.

### 9.3 Fake OIDC provider in `@capybara-hq/testing` (needed for phase 1 kernel-level tests)

`startFakeOAuthServer` issues no ID token and has no JWKS. Proposal: an `oidc` option (RS256 key,
`/jwks`, an `id_token` in the code exchange with the request's `nonce`, configurable claims per
next login such as `sub`, `email`, `email_verified`, `hd`, `name`, `picture`; `tamperNextIdToken`
like `startFakeSlack`; a choice of `iss` form), plus `refreshTokenOnlyWith: { access_type:
"offline" }` for phase 2. The alternative, a `startFakeGoogle`, duplicates most of the fake OAuth
server; a fake kept inside `plugins/google/test` would work but could not be shared with core's
kernel tests, and the Slack and Lark fakes set the precedent of living in core.

### 9.4 No `signInCallbackUrl` variable at `extension-deployment` (cosmetic)

The `extension-deployment` place offers only the common variables, so the guide spells the callback
as `{{publicUrl}}/api/v1/auth/sso/google/callback`, repeating a kernel path. Adding
`signInCallbackUrl` to that place (as `channel-connection` and `connector-template` have) keeps the
path in one place. Not blocking.

### 9.5 One guide per template, eight per plugin (limits phase 2's breadth)

Seven templates plus the login guide hit `SETUP_GUIDE_LIMITS.guides = 8`. A guide covering several
templates (`templates: [...]`) or a higher limit is needed before Chat / People / Workspace search
templates join. Also an admin enters the same Google client in up to seven connectors; a shared
client per plugin would help (later, UX).

### 9.6 Granted scope subset (later)

Google's granular consent may grant fewer scopes than requested; the kernel stores the granted
`scope` but neither warns the member nor maps the per-tool 403 to "reconnect and grant X". Later.

## 10. Decisions for the reviewer

**Accepted 2026-11-22 by the maintainer:** every recommendation below (D1–D14).

| # | Decision | Recommendation | Alternatives |
|---|---|---|---|
| D1 | One plugin or two | **One `google` plugin** (sign-in + templates), like `slack` | `google` (login) + `google-workspace` (templates): smaller installs, two guides sets, "connect Google" split |
| D2 | Consumer accounts when `allowedDomains` is empty | **Refused by default**; `allowConsumerAccounts: true` opts in | Allowed by default (simpler for small teams, but any Google account can create a Capybara account) |
| D3 | Identity key | **`externalId = sub`, tenant = `hd`, `consumer` for no `hd`** | tenant `google` for everyone (stable across domain changes, but trust becomes all-or-nothing); email as id (forbidden by Google) |
| D4 | Org-level config (`orgAccess`) | **None**: identity-source is deployment-level (Ruling P1); every field platform-only | A per-org Google client or domain list needs a core change to the login flow (org-aware login URLs); not worth it now |
| D5 | Email domain must match `hd` | **No** (secondary domains are legitimate; Google says not to rely on the email domain) | Require it, as the issue proposed (breaks secondary-domain users) |
| D6 | `prompt=select_account` on login | **Yes**: people with several Google accounts pick deliberately | Omit (one click fewer for single-account people) |
| D7 | `directory@1` | **Out of both phases**; own design later | Phase 3 in this doc (credential model undecided: service account with domain-wide delegation vs admin OAuth) |
| D8 | Template ids | **`gmail`, `google-drive`, `google-calendar`, `google-sheets`, `google-docs`, `google-slides`, `bigquery`** | Bare `drive`, `calendar`, …, as in the issue (shorter, collide in meaning with other vendors) |
| D9 | Scope sets | **Google's documented set per server** (all tools work), writes gated by `ask` | Read-only templates (`*.readonly` only; fewer restricted-scope worries, no drafts / edits); or two templates per service (doubles the guide count past the limit) |
| D10 | `defaultEnabled` on templates | **`false`** while Developer Preview | `true` (on wherever the plugin is; surprises orgs with preview servers) |
| D11 | Which servers in phase 2 | **The seven in the issue** | Add Chat / People / Workspace search now (needs §9.5 first) |
| D12 | `discovery` for templates | **`manual`** with Google's endpoints | `mcp` after a core change normalizing trailing slashes in issuer comparison (fragile against Google's metadata quirks) |
| D13 | Login setup checks | **`google-discovery` + `google-client` (token-endpoint probe with the secret)** | Discovery only (no secret ever used by a check, but a wrong secret is found only at the first login) |
| D14 | Phase 2 gating | **Wait for §9.1** | Ship templates without refresh tokens (hourly reconnects: not acceptable) |

## 11. AGENTS.md rules touched

None changed. Rules this design relies on: core "no stdio MCP" (remote Streamable HTTP only);
identity-source is deployment-level and org levels come only from `orgAccess` (no such fields here,
§4.1); "invalid extension config never fails startup" (§4.2); setup checks never write and never
return a secret (§4.6); "contract changes need a PR in core first" (§9); multi-replica discipline
(the extension keeps no state beyond a read-only JWKS cache); live API tests gated by
`CAPYBARA_TEST_*` variables (§4.9, §5.5).

## 12. Left to the builder

- Exact zh / en copy of the guide and check texts.
- Product icons for the templates (Google's brand guidelines for third-party use).
- Whether `displayName` fallbacks need `given_name` / `family_name` ordering per locale.

[oidc]: https://developers.google.com/identity/openid-connect/openid-connect
[gsiverify]: https://developers.google.com/identity/gsi/web/guides/verify-google-id-token
[websrv]: https://developers.google.com/identity/protocols/oauth2/web-server
[oauth2]: https://developers.google.com/identity/protocols/oauth2
[restricted]: https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification
[ws]: https://developers.google.com/workspace/guides/configure-mcp-servers
[sp]: https://docs.cloud.google.com/mcp/supported-products
[bq]: https://docs.cloud.google.com/bigquery/docs/use-bigquery-mcp
[enable]: https://docs.cloud.google.com/mcp/enable-disable-mcp-servers
[blog]: https://workspaceupdates.googleblog.com/2026/05/agent-tools-and-security-updates-for-workspace-developers.html
[gmref]: https://developers.google.com/workspace/gmail/api/reference/mcp
