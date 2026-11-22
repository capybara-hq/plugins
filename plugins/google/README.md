# @capybara-hq/plugin-google

Sign in with Google for Capybara (`identity-source@1`): OpenID Connect against Google with PKCE
(S256) and a nonce through the kernel's SSO flow, the ID token verified against Google's JWKS, the
Workspace hosted domain (`hd`) enforced on the verified token, and consumer accounts refused unless
the super admin allows them. Plus seven connector templates on `connector-mcp` for Google's hosted
MCP servers: Gmail, Google Drive, Google Calendar, Google Sheets, Google Docs, Google Slides and
BigQuery, each member connecting their own Google account (design:
`docs/superpowers/specs/2026-11-22-google-plugin-design.md`; plan:
`docs/superpowers/plans/2026-11-22-google-plugin-phase2.md`).

**Requires kernel 0.1.0-rc.68 or newer** (the templates use `authorizationParams`, core#552); the
extension's `sdk` range `^0.1.0-rc.52` makes an older kernel refuse the plugin at import.

## Configuration (platform only)

A super admin sets it up on the extension's platform page, guided by the setup guide
`google-sign-in` (Google Cloud console steps, the redirect URI, two checks). There is no org config:
the login page runs before any org is known. Login is offered once `google` is in
`auth.loginSources`.

| Field | Default | What |
|---|---|---|
| `clientId` | | The Web application OAuth client ID (`….apps.googleusercontent.com`); trimmed. Login is unavailable while empty |
| `clientSecret` (secret) | | The client's secret; trimmed, sealed at rest, never in a check result or an error |
| `allowedDomains` | `[]` | Workspace / Cloud Identity primary domains (`hd` values), lowercased, deduplicated, at most 50. Non-empty: the ID token's `hd` must be present and listed. `gmail.com` / `googlemail.com` are refused (consumer accounts carry no `hd`; use `allowConsumerAccounts`) |
| `allowConsumerAccounts` | `false` | Only read when `allowedDomains` is empty. `false`: an account without `hd` is refused (any Workspace domain may sign in). `true`: consumer Google accounts may sign in too |
| `endpoints` (advanced) | Google's | `authorizationUrl`, `tokenUrl`, `jwksUrl`, `issuers`, `discoveryUrl`; only for tests and egress proxies (`https:`, or plain http on 127.0.0.1 / localhost) |

The authorized redirect URI to register at Google is `<http.publicUrl>/api/v1/auth/sso/google/callback`.

Invalid config never fails startup: the login page shows the source as unavailable.

## The identity

| `ExternalIdentity` | Value |
|---|---|
| `externalId` | `sub` (Google: never use the email as the identifier) |
| `tenantId` | the `hd` claim lowercased; `consumer` for an account without `hd` |
| `source` | `google:<tenantId>` |
| `email` | `email` lowercased (dropped when not plain ASCII) |
| `emailVerified` | true only when `email_verified` is the boolean `true` **and** Google is authoritative for the address: `hd` is set, or the address ends in `@gmail.com` |
| `displayName` | `name`, else `given_name family_name`, else the email's local part, else `sub` |
| `avatarUrl` | `picture` when it is an `https:` URL |

Why the tenant is `hd`: trust in `auth.trustedIdentitySources` is per tenant, so the super admin can
trust `google:example.com` (their own Workspace, whose admins control every address in it) without
trusting every Google account. **Never list `google:consumer` in `auth.trustedIdentitySources`:**
anyone can create a Google account on any email address, and Google vouches only for `@gmail.com`
addresses there. The email domain is not required to equal
`hd` (Workspace users on secondary domains are legitimate).

A person whose organization changes its primary domain arrives under a new `source` and becomes a
new identity (accepted cost of per-domain trust).

## The flow

- **Authorize**: `https://accounts.google.com/o/oauth2/v2/auth` with `response_type=code`,
  `scope=openid email profile`, the kernel's `state`, `nonce` and PKCE challenge
  (`code_challenge_method=S256`), `prompt=select_account`, and `hd=<domain>` only when exactly one
  domain is allowed. That `hd` is a UI hint only; the gate is the ID token's `hd` claim. No
  `access_type`: login needs no refresh token, and the plugin stores no Google token.
- **PKCE**: Google's discovery document advertises S256 and the token endpoint accepts
  `code_verifier`, though the web-server guide does not describe PKCE for confidential clients;
  we send it in addition to the client secret.
- **Callback**: one `POST https://oauth2.googleapis.com/token` (`client_secret_post` plus
  `code_verifier`, 10 s timeout, no retries); the `id_token` verified with jose against
  `https://www.googleapis.com/oauth2/v3/certs` (RS256 only, `iss` `https://accounts.google.com` or
  `accounts.google.com`, `aud` = the client, `exp` / `iat` / `sub` / `nonce` required, 60 s clock
  tolerance, at most one hour old), the nonce compared in constant time, `azp` equal to the client
  when present (required with several audiences). Then the hosted-domain gate. No userinfo call.
- **JWKS rotation**: jose caches Google's keys (10 minutes) and refetches on an unknown `kid` after
  its 30-second cooldown, so a key rotation needs no restart.
- **Refusals**: a domain or consumer account that is not allowed throws `IdentitySourceRefused`;
  the login page says the account is not allowed (`sso.account_not_allowed`). Every other failure is
  `sso.provider_error`. Errors carry Google's error code or the HTTP status only, never a body, the
  code, a token or the secret.

## Setup checks (platform page)

| Id | What |
|---|---|
| `google-discovery` | `GET https://accounts.google.com/.well-known/openid-configuration`: ok when the issuer and the authorization, token and JWKS endpoints equal the plugin's; failing ("update the plugin") when they differ |
| `google-client` | `POST` the token endpoint with the saved client and the fixed invalid code `capybara-setup-probe`: `400 invalid_grant` = ok (client accepted); `invalid_client` / `unauthorized_client` / 401 = failing; anything else unknown (a 2xx is dropped unread) |

The redirect URI cannot be checked this way (Google refuses the invalid code first); the guide shows
the exact URI.

## Connector templates

Seven `connectors/<id>.json` on `connector-mcp` (needs `connector-mcp ^0.1.0-rc.1`, a `plugin.json`
dependency). Each starts **switched off** in every org (`defaultEnabled: false`) while Google calls
the servers a preview; an org admin switches on the ones the org uses.

| Template | Endpoint | Scopes (`https://www.googleapis.com/auth/…`) | Writes (ask) |
|---|---|---|---|
| `gmail` | `https://gmailmcp.googleapis.com/mcp/v1` | `gmail.readonly`, `gmail.compose`, `gmail.modify` | drafts, labels, trash, spam (no send tool) |
| `google-drive` | `https://drivemcp.googleapis.com/mcp/v1` | `drive.readonly`, `drive.file` | `create_file`, `copy_file`, `upload_file_revision` |
| `google-calendar` | `https://calendarmcp.googleapis.com/mcp/v1` | `calendar.calendarlist.readonly`, `calendar.events.freebusy`, `calendar.events.readonly`, `calendar.events` | `create_event`, `update_event`, `delete_event`, `respond_to_event` |
| `google-sheets` | `https://sheetsmcp.googleapis.com/mcp/v1` | `drive.readonly`, `drive.file`, `spreadsheets.readonly`, `spreadsheets` | `update_spreadsheet`, `update_values`, `update_formulas`, `insert_dimension` |
| `google-docs` | `https://docsmcp.googleapis.com/mcp/v1` | `drive.readonly`, `drive.file`, `documents.readonly`, `documents` | `update_doc` |
| `google-slides` | `https://slidesmcp.googleapis.com/mcp/v1` | `drive.readonly`, `drive.file`, `presentations.readonly`, `presentations` | `update_presentation` |
| `bigquery` | `https://bigquery.googleapis.com/mcp` | `bigquery` | `execute_sql`, `cancel_job` |

- **Auth, fixed by the template** (an org edits none of it): `oauth_code`, `ownership: personal`
  (each call carries the caller's own Google token; the org holds only the OAuth client),
  `discovery: manual` with Google's authorization and token endpoints (the same constants as the
  sign-in flow, `GOOGLE_ENDPOINTS`), `client: manual`, `client_secret_post`, Google's documented
  scope set per server, and `authorizationParams: { access_type: "offline", prompt: "consent" }`
  so Google returns a refresh token (without it the access token dies after an hour). No
  `include_granted_scopes`: every connector shares one client, and incremental authorization would
  widen each token to every scope the member granted any Google connector. No `editableEndpoint`.
- **Policies**: `allow` exactly for the tools Google annotates `readOnlyHint`, every other tool
  `ask`, nothing `deny`. The tool lists are recorded in `test/fixtures/<id>-tools.json` (2026-11-22)
  and the tests tie the policies to them. A tool Google adds later gets the kernel's annotation
  default (read-only allow, otherwise ask). BigQuery's `execute_sql_readonly` is a read and runs
  without asking, but BigQuery bills the bytes a query scans to the project it runs in: set custom
  query quotas where that matters.
- **One separate agent client.** Google blocks OAuth clients without "Use this client for an
  AI-powered agent" (Google Auth Platform → Clients) from the Workspace MCP servers and asks for a
  separate client when one also serves non-agent features, so the connectors use their own Web
  client, not the sign-in client, in the same project as the enabled services. One such client
  serves all seven connectors; its redirect URI is the kernel's `{{oauthCallbackUrl}}`.
- **Internal vs External.** An Internal consent screen (a Workspace-owned project) needs no Google
  verification even for Gmail's and Drive's restricted scopes, and its refresh tokens do not
  expire. External works only for test users in Testing (refresh tokens expire after seven days);
  External in production needs verification and, for restricted scopes, a CASA assessment.
- **Developer Preview.** Google offers the Workspace servers "as part of the Google Workspace
  Developer Preview Program": the Workspace account and the Cloud project must be enrolled, and the
  terms forbid giving users outside the company access. Google's pages disagree on whether
  enrolment is still required; the guides state it as a prerequisite. BigQuery's server carries no
  preview label.
- **BigQuery** needs `roles/mcp.toolUser`, `roles/bigquery.jobUser` and `roles/bigquery.dataViewer`
  per member on the projects they query; every tool takes a `projectId`. Enabling the BigQuery API
  enables its MCP server.
- **Setup guides**: one per template (`guides/<id>-oauth.md` + `.zh.md`, place
  `connector-template`), with the kernel checks `capybara:oauth-client`,
  `capybara:oauth-token-endpoint`, `capybara:connector-tools` (admin) and
  `capybara:connector-connected` (member). With the sign-in guide that is eight, the per-plugin
  limit.
- **Icons**: Google's product icons, unaltered except for an added `<title>` (and BigQuery's inline
  style block turned into fill attributes), from
  `https://www.gstatic.com/images/branding/productlogos/<product>_2020q4/v<N>/192px.svg` and
  `https://fonts.gstatic.com/s/i/gcpiconscolors/bigquery/v1/24px.svg` (downloaded 2026-11-22).
  Google's marks are trademarks of Google LLC, used to refer to its products.

### For Workspace admins: what reaches Capybara

Tool results are conversation content: mail, files, events and query results that a connector reads
land in the conversation event log and the tool-output archives like any connector result, and they
are model input. Google asks integrators to screen prompts and responses for prompt injection; a
Workspace admin can turn on Model Armor floor settings in the Cloud project
(https://developers.google.com/workspace/guides/configure-mcp-security). A Workspace admin may also
restrict third-party API access (Admin console → Security → Access and data control → API controls)
and must then trust the connectors' client.

## Not supported (yet)

- `directory@1` (Admin SDK Directory API) and a Google Chat channel.
- Other Google MCP servers (Classroom, Workspace search, People, Chat): the guide limit is reached.
- Per-org Google clients or domain lists for sign-in.

## Live acceptance

`test/live/google.live.test.ts` runs both checks against Google when
`CAPYBARA_TEST_GOOGLE_CLIENT_ID` and `CAPYBARA_TEST_GOOGLE_CLIENT_SECRET` are set (an Internal Web
client in a Workspace-owned project). The interactive login is checked by hand on a dev deployment:

1. A Workspace account of an allowed domain signs in and lands in the app.
2. A consumer account (`@gmail.com`) is refused while `allowConsumerAccounts` is off.
3. An account of a second, unlisted Workspace domain is refused.
4. A refused account sees the "this account is not allowed" login page.

`test/live/google-mcp.live.test.ts` checks Google's MCP servers: with `CAPYBARA_TEST_LIVE_TOOLS=1`
the unauthenticated part (tool lists and hints equal the fixtures, per-tool scopes, 401 with
`resource_metadata`, Google's authorization server; `CAPYBARA_TEST_GOOGLE_RECORD_FIXTURES=1`
re-records the fixtures); with `CAPYBARA_TEST_GOOGLE_ACCESS_TOKEN` too (an access token minted with
the agent-flagged test client and all seven templates' scopes, e.g. in the OAuth 2.0 Playground with
your own credentials) the token's tool lists and one read per server; optional
`CAPYBARA_TEST_GOOGLE_BIGQUERY_PROJECT` adds BigQuery's read. The connectors are accepted by hand on
a dev deployment (kernel ≥ 0.1.0-rc.68, an Internal agent-flagged client):

1. Import the plugin; the seven templates appear switched off in an org; the import review shows
   each template's auth with `authorizationParams`.
2. Switch on Gmail, create the connector, enter the client: the three admin checks are green.
3. A member connects: Google's consent lists the three Gmail scopes; `list_labels` runs; a draft
   asks first.
4. After an hour (or after revoking the access token at Google) a call still works (refresh);
   reconnecting shows consent again.
5. Steps 2–3 for the other five Workspace templates with the same client.
6. BigQuery: create, connect and run `execute_sql_readonly` on a project where the member has the
   three roles; note whether Google accepted the redirect URI ("Custom redirect URIs aren't
   supported"). If it refuses, `bigquery` is removed before the release.
7. Untick one scope at consent: the matching tool fails with Google's insufficient-scope error, and
   the member guide's advice fixes it.

## Sources (read 2026-11-21 / 22)

- OpenID Connect: https://developers.google.com/identity/openid-connect/openid-connect
- Verify the ID token (email authority): https://developers.google.com/identity/gsi/web/guides/verify-google-id-token
- Web server OAuth: https://developers.google.com/identity/protocols/oauth2/web-server
- Discovery: https://accounts.google.com/.well-known/openid-configuration
- Configure the Workspace MCP servers: https://developers.google.com/workspace/guides/configure-mcp-servers
- Gmail MCP reference: https://developers.google.com/workspace/gmail/api/reference/mcp
- Developer Preview Program: https://developers.google.com/workspace/preview
- MCP security for Workspace: https://developers.google.com/workspace/guides/configure-mcp-security
- BigQuery MCP: https://docs.cloud.google.com/bigquery/docs/use-bigquery-mcp
- Enable Google Cloud MCP servers: https://docs.cloud.google.com/mcp/enable-disable-mcp-servers
- Gmail scopes: https://developers.google.com/workspace/gmail/api/auth/scopes
