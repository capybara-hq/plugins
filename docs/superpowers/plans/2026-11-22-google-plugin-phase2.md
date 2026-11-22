# Google Plugin Phase 2 (Workspace Connector Templates) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task, with core's `wave-planned-subagent-development` layer (the wave table below). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add seven Google connector templates (`gmail`, `google-drive`, `google-calendar`, `google-sheets`, `google-docs`, `google-slides`, `bigquery`) to `@capybara-hq/plugin-google`. They point at Google's hosted remote MCP servers, and each member connects their own Google account through an OAuth client the org admin enters. Refresh tokens come from `authorizationParams` (core#552). The work ships as `0.1.0-rc.1`.

**Architecture:** Declarative data in `plugins/google`: `connectors/<id>.json` on `connector-mcp` (`oauth_code`, `ownership: personal`, `discovery: manual` with Google's fixed endpoints, `client: manual`, `client_secret_post`, Google's documented scopes, `authorizationParams: { access_type: "offline", prompt: "consent" }`, `defaultEnabled: false`). Each template gets a product icon and a zh / en `connector-template` guide. Tool policies come from recorded `tools/list` fixtures. No extension code changes, except that the `sdk` range is raised (Open question 6). The OAuth flow, token storage and refresh are the kernel's, and the MCP sessions are connector-mcp's.

**Tech Stack:** JSON templates, Markdown guides, vitest, `@capybara-hq/plugin-sdk` (≥ 0.1.0-rc.52: `ConnectorAuthSchema.authorizationParams`, `OAUTH_RESERVED_AUTHORIZATION_PARAMS`), `@capybara-hq/testing` (≥ 0.1.0-rc.34: `startFakeOAuthServer({ refreshTokenOnlyWith })`, `startFakeMcpServer`, `fakeExtensionEntry("fake-connector")`), kernel ≥ 0.1.0-rc.68.

**Spec:** `docs/superpowers/specs/2026-11-22-google-plugin-design.md` §5 (D8–D14 accepted 2026-11-22). Read §5 and the re-verification below before any task. Core gate: `docs/superpowers/specs/2026-11-22-oauth-authorization-params-design.md` in capybara-hq/core (accepted, D1–D6), merged as core#608 and released as plugin-sdk `0.1.0-rc.52` / kernel `0.1.0-rc.68` / testing `0.1.0-rc.34` (`npm view … dist-tags.next`, 2026-11-22).

**Phase 1 plan:** `docs/superpowers/plans/2026-11-22-google-plugin.md` (Part 3 is the outline this plan replaces).

## Maintainer answers kept (2026-11-22)

- D8 template ids as above; D9 Google's full documented scope set per server, writes `ask`; D10
  `defaultEnabled: false` while preview; D11 these seven only; D12 `discovery: "manual"` with
  Google's fixed endpoints; D14 `authorizationParams: { access_type: "offline", prompt: "consent" }`.
- core#554 (guide limits) is not needed: the sign-in guide plus seven template guides is exactly
  `SETUP_GUIDE_LIMITS.guides = 8`.
- The live tests use an Internal Web OAuth client in a Workspace-owned project, kept in
  `~/.capybara-test.env`, which the maintainer creates. For phase 2 that client must also have
  "Use this client for an AI-powered agent" selected (see R4). Until the client exists, the live
  tests skip.

## Re-verification of spec §2.3 (2026-11-22)

All sources were accessed on 2026-11-22. "Live" means an unauthenticated probe from this machine on
2026-11-22 (`initialize`, `tools/list`, an unauthenticated `tools/call`, and the protected-resource
metadata documents); no credentials were used. Google's page dates are the pages' own "Last updated"
lines where present.

| # | Spec §2.3 item | Finding | Status |
|---|---|---|---|
| R1 | Developer Preview enrolment | **Still contradictory.** [WS] (last updated 2026-11-19) carries a banner saying the servers are "Available as part of the Google Workspace Developer Preview Program" and lists "Membership in the Google Workspace Developer Preview Program" as a prerequisite. [GMREF] says the same. [BLOG] (2026-05-01) says "Available to all Google Workspace customers and developers" and "opening the Workspace MCP server to public developer preview". The ADK codelab [ADK] says "Access to Google Workspace MCP servers is part of the Public Developer Preview Program" and asks readers to confirm their account was accepted. [DPP] enrols a Workspace account (added to a Google Group) **and** Cloud project(s) ("We provide you access to the program API features through your Google Cloud project(s)"), and service accounts cannot be enrolled. [DPP] terms: features "may not be included in public applications prior to the General Availability announcement", and the developer "may not grant end users access, outside my domain or company" to applications built on pre-GA APIs. | Uncertain. Treat enrolment as required and say so in the guides (Open question 1) |
| R2 | BigQuery stage and enable command | **Stage: still unlabelled.** No stage label on [SP] for BigQuery (every Workspace server there is "Developer Preview") or on [BQ] (last updated 2026-11-17). [BQ] mentions no Pre-GA terms. **Enable: there is no separate MCP enable step any more.** [BQ]: "The BigQuery remote MCP server is enabled when you enable the BigQuery API", and "For new projects, the BigQuery API is automatically enabled". [ENABLE] shows only `gcloud services enable SERVICE_NAME` and needs `roles/serviceusage.serviceUsageAdmin` (`serviceusage.services.enable`). `gcloud beta services mcp enable` appears in no Google page we found. Per-user roles are unchanged: `roles/mcp.toolUser`, `roles/bigquery.jobUser`, `roles/bigquery.dataViewer` [BQ]. | Enable command settled (`gcloud services enable bigquery.googleapis.com`). Stage uncertain: the guide calls it "no preview label" and keeps D10 |
| R3 | Which project holds the client, and whose enablement and quota apply | **Still undocumented.** Every Google instruction ([WS], [ADK], [BQ]) enables the services and creates the client in one project. [AUTH] shows an `x-goog-user-project: PROJECT_ID` header in MCP client configs but does not explain quota or billing. [BQ]: "The BigQuery MCP server doesn't have its own quotas"; every BigQuery tool takes a required `projectId` argument (live), so jobs run in the project the agent names. | Uncertain. The guides require one project for the client and the services (Open question 7) |
| R4 | Custom redirect URIs (BigQuery); the "AI-powered agent" client setting | **Redirect URIs:** the [BQ] sentence in context reads: "Your application's documentation should specify the redirect URI that you must use. Custom redirect URIs aren't supported." [AUTH] says the same for every Google / Cloud MCP server. Our reading: the client must register exactly the redirect URI the application documents (Capybara's is `{{oauthCallbackUrl}}`), not an arbitrary one. Google's own codelab registers its own Web-client redirect URIs for the Workspace servers [ADK]. Not yet proven for BigQuery with a third-party Web client. **Agent setting:** [WS]: "User-delegated OAuth 2.0 client IDs that call the Google Workspace MCP servers must have Use this client for an AI-powered agent selected in Google Auth Platform > Clients". If the existing client "also supports non-agent features, create a new OAuth 2.0 client ID for your AI agent". [ADK]: the setting is the client's `is_agentic` flag, and "OAuth clients without this setting enabled are blocked from calling Google Workspace MCP endpoints". [BQ] does not mention the setting. | Agent setting settled. It changes spec §5.3 and phase 1's "same client" wording: **a separate agent client** (Open question 2). The BigQuery redirect URI is verified on live acceptance (Open question 3) |
| R5 | `resource` mismatch (`/mcp` vs `/mcp/v1`) | Still present (live). Server-level metadata at `/.well-known/oauth-protected-resource/mcp/v1` says `resource: https://<host>/mcp/v1`. The per-tool documents have **moved** to `/.well-known/oauth-protected-resource/<tool>` at the host root (`WWW-Authenticate: Bearer resource_metadata="https://gmailmcp.googleapis.com/.well-known/oauth-protected-resource/search_threads"`), and they say `resource: https://<host>/mcp`. `authorization_servers` is still `["https://accounts.google.com/"]` (trailing slash), while Google's AS metadata `issuer` is `https://accounts.google.com`. | Irrelevant with D12: manual discovery sends no `resource` |
| R6 | Current `tools/list` | **Unchanged since 2026-11-21** (live): Gmail 23, Drive 9, Calendar 9, Sheets 6, Docs 2, Slides 4, BigQuery 9 tools, same names and annotations as spec §2.2. `initialize` still answers plain JSON, protocol `2025-06-18`, `serverInfo { name: "StatelessServer" }`, `tools.listChanged: false`. Per-tool scopes (live): **every tool's `scopes_supported` intersects the template's scope set** (all 62 tools). [GMREF] still documents 10 of Gmail's 23 tools, and [BQ] 6 of BigQuery's 9. Whether a token sees the same list as an unauthenticated `tools/list` is unverified. Sheets and Docs server-level metadata do not list `drive.file` (they list `drive`), although [WS] documents `drive.file` for both and their per-tool documents accept it. | Fixtures recorded from today's lists (Task 2). The authenticated list is checked by the live test (Open question 5) |
| R7 | PKCE for confidential Web clients | Discovery still advertises `code_challenge_methods_supported: ["plain","S256"]`, and the kernel always sends S256. [WS] adds: "To avoid hourly sign-in prompts with a Web application OAuth client, configure your MCP client to request offline access using `access_type=offline`", which confirms D14. | Unchanged; the live acceptance connect covers PKCE |
| R8 | `gmail.drafts.create` | It appears in Gmail's MCP metadata `scopes_supported` (with `gmail.drafts`, `gmail.labels.create`, `gmail.messages.*`, `gmail.send.self`), but not on Google's Gmail scope page [GSCOPES], which classifies `gmail.readonly`, `gmail.compose` and `gmail.modify` as Restricted. | Not a published scope; templates do not request it (D9 keeps the documented set) |

Also new since the spec: [WS] now lists Classroom (`classroommcp.googleapis.com/mcp/v1`) and calls
Workspace search "Universal Search" (out of scope, D11). [WS] notes that sensitive tool calls made
through domain-wide delegation return MCP form elicitations; with user OAuth no elicitation is
documented. connector-mcp already relays elicitations (`onElicit`). [SEC] says "You must screen
prompts and responses for malicious content or prompt injection attacks" (Model Armor floor
settings); see Open question 8.

[WS]: https://developers.google.com/workspace/guides/configure-mcp-servers
[GMREF]: https://developers.google.com/workspace/gmail/api/reference/mcp
[BLOG]: https://workspaceupdates.googleblog.com/2026/05/agent-tools-and-security-updates-for-workspace-developers.html
[ADK]: https://codelabs.developers.google.com/google-workspace-mcp-adk
[DPP]: https://developers.google.com/workspace/preview
[SP]: https://docs.cloud.google.com/mcp/supported-products
[BQ]: https://docs.cloud.google.com/bigquery/docs/use-bigquery-mcp
[ENABLE]: https://docs.cloud.google.com/mcp/enable-disable-mcp-servers
[AUTH]: https://docs.cloud.google.com/mcp/set-up-authentication-mcp-servers
[GSCOPES]: https://developers.google.com/workspace/gmail/api/auth/scopes
[SEC]: https://developers.google.com/workspace/guides/configure-mcp-security

## Global Constraints

- Everything lives in `plugins/google`. Template ids and files: `connectors/{gmail,google-drive,google-calendar,google-sheets,google-docs,google-slides,bigquery}.json`. Guide ids: `<template id>-oauth` (`gmail-oauth`, …, `bigquery-oauth`), place `connector-template`, audiences admin and member. Icons: `icons/<template id>.svg`.
- The template auth is exactly this, with nothing else: `{ type: "oauth_code", ownership: "personal", discovery: "manual", authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth", tokenUrl: "https://oauth2.googleapis.com/token", client: "manual", tokenAuthMethod: "client_secret_post", scopes: [...], authorizationParams: { access_type: "offline", prompt: "consent" } }`. The two URLs equal `GOOGLE_ENDPOINTS.authorizationUrl` / `.tokenUrl` from `src/config.ts`, the one source of truth, enforced by test. No `include_granted_scopes` (Open question 4). No `editableEndpoint`, so an org can point neither the endpoint nor the token URL elsewhere.
- Endpoints: `https://{gmailmcp,drivemcp,calendarmcp,sheetsmcp,docsmcp,slidesmcp}.googleapis.com/mcp/v1` and `https://bigquery.googleapis.com/mcp` (no `/v1`). `template.plugin: "connector-mcp"`, `pluginVersion: "^0.1.0-rc.1"`, `connector: "mcp"`. `plugin.json` `dependencies: [{ name: "connector-mcp", version: "^0.1.0-rc.1" }]`.
- Scopes are full URLs `https://www.googleapis.com/auth/<name>`, Google's documented set per server ([WS], [BQ]; D9):

  | Template | Scopes (suffix after `https://www.googleapis.com/auth/`) |
  |---|---|
  | `gmail` | `gmail.readonly`, `gmail.compose`, `gmail.modify` |
  | `google-drive` | `drive.readonly`, `drive.file` |
  | `google-calendar` | `calendar.calendarlist.readonly`, `calendar.events.freebusy`, `calendar.events.readonly`, `calendar.events` |
  | `google-sheets` | `drive.readonly`, `drive.file`, `spreadsheets.readonly`, `spreadsheets` |
  | `google-docs` | `drive.readonly`, `drive.file`, `documents.readonly`, `documents` |
  | `google-slides` | `drive.readonly`, `drive.file`, `presentations.readonly`, `presentations` |
  | `bigquery` | `bigquery` |

- Policies: `allow` exactly for the tools whose recorded `readOnlyHint` is `true`; every other recorded tool is `ask`; no `deny` (spec §5.2). Every recorded tool has a policy, and every policy names a recorded tool. A tool Google adds later gets the kernel's annotation default (`readOnlyHint` → allow, otherwise ask), the same rule.
- `defaultEnabled: false` on every template (D10). `displayName` zh / en: Gmail / Gmail, Google 云端硬盘 / Google Drive, Google 日历 / Google Calendar, Google 表格 / Google Sheets, Google 文档 / Google Docs, Google 幻灯片 / Google Slides, BigQuery / BigQuery.
- One `plugin-sdk` instance: overrides in `pnpm-workspace.yaml` and the root devDependencies move together (`pnpm why @capybara-hq/plugin-sdk` shows one version).
- Tests: no fixed sleeps, no per-test timeouts. Plugin tests import only the SDK, `@capybara-hq/testing`, model-fake and the plugin's own files (`plugin-test-imports`): the kernel-level test loads the testing kit's `fake-connector`, not `connector-mcp`. Live tests skip unless their variables are set. Keys come from `~/.capybara-test.env`, loaded only inside the test command and never printed.
- English for code, comments, identifiers and commits. zh guide copy uses 平台 / 超级管理员 / 智能体, never 企业 or the Latin word "agent". zh guides keep byte-equal code blocks. Conventional Commits, body lines ≤ 100 characters.
- `marketplace.json` is written only by the Version Packages PR (`pnpm version-packages`), never in the feature PR.

## Review Focus (security-sensitive; flagged for review)

1. **The auth preset is the trust boundary.** Templates fix the authorization and token URLs, the
   endpoint, the scopes and the authorize parameters, and an org edits none of them. Review that no
   template has `editableEndpoint`, that both URLs equal `GOOGLE_ENDPOINTS`, that every endpoint
   host is one of the seven Google hosts, and that `authorizationParams` keys are exactly
   `access_type` and `prompt`, none in `OAUTH_RESERVED_AUTHORIZATION_PARAMS` (Task 2 tests).
2. **No write is `allow`.** `allow` is derived from Google's own `readOnlyHint` in the recorded
   fixtures, so a wrong hint from Google would allow a write. Review the fixtures by eye: every
   Gmail label / trash / spam tool, Drive `create_file` / `copy_file` / `upload_file_revision`,
   Calendar `create_event` / `update_event` / `delete_event` / `respond_to_event`, Sheets / Docs /
   Slides `update_*` / `insert_dimension`, and BigQuery `execute_sql` / `cancel_job` are `ask`.
3. **Personal tokens only.** `ownership: "personal"` on all seven: each call carries the caller's
   own Google token; the org holds only the OAuth client. No `oauth_client` (org credential) variant.
4. **Narrow tokens.** No `include_granted_scopes`: all seven connectors share one client, and with
   incremental authorization each token would carry the union of the scopes granted to every
   Google connector the member connected, so a Docs connector's token could read Gmail (Open
   question 4). The kernel-level test asserts the parameter is absent and that the requested
   `scope` is exactly the template's.
5. **A separate agent client.** The guides tell the admin to create a client with "Use this client
   for an AI-powered agent" selected, separate from the sign-in client (R4). Google blocks
   unflagged clients from the Workspace servers, and its troubleshooting says a client that also
   serves non-agent features (login) should be split.
6. **Data exposure.** Gmail and Drive content lands in the conversation event log and tool-output
   archives like any connector result. The README says so for Workspace admins, together with
   [SEC]'s prompt-injection screening note.

---

## Wave plan

| Task | Depends on (interfaces) | Files / areas | Risk | Wave | Review |
|---|---|---|---|---|---|
| 1 Core upgrade | released core rc (done) | `pnpm-workspace.yaml`, root `package.json`, `pnpm-lock.yaml`, `plugins/google/package.json`, `plugins/google/src/index.ts` (`sdk` range) | normal | 1 | batched (wave 1) |
| 2 Tool fixtures, templates, icons, manifest | 1 | `plugins/google/test/fixtures/`, `connectors/`, `icons/`, `.capybara-plugin/plugin.json`, `test/connector-templates.test.ts` | **high** (auth preset, policies) | 2 | alone, most capable |
| 3 Guides (7 × zh / en) | 2 | `plugins/google/guides/*-oauth{,.zh}.md`, `test/guides.test.ts`, `plugin.json` `setupGuides` | normal | 3 | batched (wave 3) |
| 4 Kernel-level connect test | 1, 2 | `plugins/google/test/kernel/connect.test.ts` | normal | 3 | batched (wave 3) |
| 5 Live test | 2 | `plugins/google/test/live/google-mcp.live.test.ts` | normal | 3 | batched (wave 3) |
| 6 Docs, changeset | 2–5 | `plugins/google/README.md`, `package.json` / `plugin.json` descriptions, root `README.md`, `AGENTS.md`, `.agents/skills/writing-plugins/SKILL.md`, `.agents/skills/writing-connectors/SKILL.md`, spec errata, `.changeset/` | normal | 4 | batched (wave 4) |
| — PR, merge, Version Packages PR (marketplace entry), publish `0.1.0-rc.1`, live acceptance | 1–6 | | | gate | final whole-branch review, most capable |

Tasks 3, 4 and 5 touch disjoint files and run in parallel. Task 3 owns `plugin.json`'s
`setupGuides` key and Task 2 owns the rest of `plugin.json`; Task 3 starts after Task 2 is
committed.

---

## Task 1: Core upgrade

Branch: `pnpm wt:new feat/139-google-workspace-connectors --from origin/main` in
`/Users/grant/Capybara/plugins`. Read `.agents/skills/writing-plugins` (connector templates,
release) and `writing-connectors` (testing) first; `plugins/github` is the closest reference (a
`connector-mcp` template with `oauth_code`, its template test, guides test and live test).

**Files:**
- Modify: `pnpm-workspace.yaml` (`overrides`: `@capybara-hq/plugin-sdk: 0.1.0-rc.52`, `@capybara-hq/kernel: 0.1.0-rc.68`, `@capybara-hq/testing: 0.1.0-rc.34`, or the newer `next` versions if core has released again, read with `npm view @capybara-hq/<pkg> dist-tags.next`), root `package.json` (`@capybara-hq/plugin-sdk` and `@capybara-hq/testing` devDependencies to the same versions; `@capybara-hq/plugin-model-fake` to its current `next` when that version's kernel / SDK dependency ranges accept the pinned ones), `pnpm-lock.yaml`
- Modify: `plugins/google/package.json` (`@capybara-hq/plugin-sdk: ^0.1.0-rc.52`, devDependency `@capybara-hq/testing: ^0.1.0-rc.34`)
- Modify: `plugins/google/src/index.ts` (`sdk: "^0.1.0-rc.52"`, Open question 6)

**Interfaces:**
- Produces: a workspace on one SDK instance whose `ConnectorAuthSchema` accepts `authorizationParams` and exports `OAUTH_RESERVED_AUTHORIZATION_PARAMS`, and a test kit whose `startFakeOAuthServer` has `refreshTokenOnlyWith`.

- [ ] **Step 1: Edit the files; `pnpm install`.**
- [ ] **Step 2: Verify the single SDK instance:** `pnpm why @capybara-hq/plugin-sdk` → exactly one version.
- [ ] **Step 3: Verify the gate is in the installed SDK:** `node -e "import('@capybara-hq/plugin-sdk').then(m => console.log(m.OAUTH_RESERVED_AUTHORIZATION_PARAMS.length))"` from `plugins/google` prints a number (21 at rc.52).
- [ ] **Step 4: Run** `pnpm lint && pnpm typecheck && pnpm check`, then the suites that catch a second SDK copy or a kernel drift: `pnpm exec vitest run plugins/connector-mcp/test/kernel plugins/github/test plugins/google/test` → PASS. (A lockfile change runs every test in CI anyway.)
- [ ] **Step 5: Commit** `chore: upgrade the core packages for authorization parameters (#139)`.

## Task 2: Tool fixtures, templates, icons, manifest (high risk)

The auth preset and the policies are the security surface of phase 2, so this task is reviewed
alone on the most capable model.

**Files:**
- Create: `plugins/google/test/fixtures/{gmail,google-drive,google-calendar,google-sheets,google-docs,google-slides,bigquery}-tools.json`
- Create: `plugins/google/connectors/{gmail,google-drive,google-calendar,google-sheets,google-docs,google-slides,bigquery}.json`
- Create: `plugins/google/icons/{gmail,google-drive,google-calendar,google-sheets,google-docs,google-slides,bigquery}.svg`
- Modify: `plugins/google/.capybara-plugin/plugin.json` (`dependencies`, `connectorTemplates`)
- Test: `plugins/google/test/connector-templates.test.ts`

**Interfaces:**
- Fixture shape (one file per template, written by hand from the live probes now, and later by the live test, Task 5): `{ "endpoint": "<url>", "recordedAt": "2026-11-22", "tools": [{ "name": "search_threads", "readOnlyHint": true, "destructiveHint": false, "scopes": ["https://www.googleapis.com/auth/gmail.modify", "…"] }] }`. `tools` keeps `tools/list` order. `scopes` is the per-tool document's `scopes_supported`, from `https://<host>/.well-known/oauth-protected-resource/<tool>`. Missing hints are recorded as `false`.
- Template file (Gmail shown in full; the others differ only in the values in the tables):

```json
{
  "displayName": { "zh": "Gmail", "en": "Gmail" },
  "description": "Search and read mail, write drafts and manage labels as the connected person, through Google's Gmail MCP server (Google Workspace Developer Preview). Each member connects their own Google account; an org admin enters the OAuth client of the company's Google Cloud project.",
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
      "scopes": [
        "https://www.googleapis.com/auth/gmail.readonly",
        "https://www.googleapis.com/auth/gmail.compose",
        "https://www.googleapis.com/auth/gmail.modify"
      ],
      "authorizationParams": { "access_type": "offline", "prompt": "consent" }
    },
    "defaultToolPolicies": {
      "create_draft": "ask",
      "list_drafts": "allow",
      "get_draft": "allow",
      "get_thread": "allow",
      "get_message": "allow",
      "search_threads": "allow",
      "label_thread": "ask",
      "unlabel_thread": "ask",
      "apply_sensitive_thread_label": "ask",
      "trash_thread": "ask",
      "untrash_thread": "ask",
      "mark_thread_spam": "ask",
      "unmark_thread_spam": "ask",
      "list_labels": "allow",
      "label_message": "ask",
      "update_message_labels": "ask",
      "unlabel_message": "ask",
      "apply_sensitive_message_label": "ask",
      "trash_message": "ask",
      "untrash_message": "ask",
      "mark_message_spam": "ask",
      "unmark_message_spam": "ask",
      "create_label": "ask"
    }
  }
}
```

- Policies of the other six (live `tools/list`, 2026-11-22; `allow` = `readOnlyHint: true`):

  | Template | `allow` | `ask` |
  |---|---|---|
  | `google-drive` | `download_file_content`, `get_file_metadata`, `get_file_permissions`, `list_recent_files`, `read_file_content`, `search_files` | `copy_file`, `create_file`, `upload_file_revision` |
  | `google-calendar` | `list_events`, `get_event`, `list_calendars`, `suggest_time`, `search_events` | `create_event`, `update_event`, `delete_event`, `respond_to_event` |
  | `google-sheets` | `get_values`, `get_spreadsheet` | `update_spreadsheet`, `update_values`, `update_formulas`, `insert_dimension` |
  | `google-docs` | `read_doc` | `update_doc` |
  | `google-slides` | `read_presentation`, `read_slide_page`, `read_slide_page_thumbnail` | `update_presentation` |
  | `bigquery` | `list_dataset_ids`, `get_dataset_info`, `list_table_ids`, `get_table_info`, `execute_sql_readonly`, `get_query_results`, `get_job` | `execute_sql`, `cancel_job` |

- Descriptions (English, ≤ one sentence on what it does plus the shared second sentence of the Gmail one):
  Drive "Search, read and download files, create and copy files and upload new revisions as the connected person, through Google's Drive MCP server (Google Workspace Developer Preview)."; Calendar "Find and read events and free time, create, change and answer events as the connected person, through Google's Calendar MCP server (Google Workspace Developer Preview)."; Sheets "Read spreadsheets and values, update values, formulas and sheet structure as the connected person, through Google's Sheets MCP server (Google Workspace Developer Preview)."; Docs "Read and edit Google Docs as the connected person, through Google's Docs MCP server (Google Workspace Developer Preview)."; Slides "Read presentations, slides and thumbnails and edit presentations as the connected person, through Google's Slides MCP server (Google Workspace Developer Preview)."; BigQuery "Explore datasets and tables and run SQL in the projects the connected person can use, through Google's BigQuery MCP server; read-only queries run directly, other SQL asks first." Each then adds the Gmail one's second sentence (BigQuery: "… enters the OAuth client of the company's Google Cloud project; members need BigQuery roles in the projects they query.").
- `plugin.json` gains `"dependencies": [{ "name": "connector-mcp", "version": "^0.1.0-rc.1" }]` and `"connectorTemplates": [{ "path": "./connectors/gmail.json" }, …]` in the D8 order.
- Icons: Google's product marks (Gmail, Drive, Calendar, Sheets, Docs, Slides; BigQuery's product icon), unaltered, from Google's official brand resources, standalone SVG (`xmlns`), legible on light and dark. Open question 9 covers the trademark question and the fallback (`./icon.svg`, the G mark, for all seven).

- [ ] **Step 1: Record the fixtures.** For each template, `POST tools/list` to its endpoint without a token, then `GET` each per-tool metadata document. Write the fixture files as specified (the probe is the live test's code path; until Task 5 exists, use a scratch script outside the repository, never committed). Check the counts: 23 / 9 / 9 / 6 / 2 / 4 / 9.
- [ ] **Step 2: Write the failing test** `test/connector-templates.test.ts` (shape of `plugins/github/test/connector-template.test.ts`), with one `describe` per template id generated from a table `[id, endpoint, scopes]`:
  - `parseConnectorTemplateFile(file)` has no errors; `validateConnectorTemplate(file.template)` is `[]`; `ConnectorAuthSchema.safeParse(file.template.auth).success` is true (the SDK that knows `authorizationParams`).
  - The template matches `{ plugin: "connector-mcp", connector: "mcp", endpoint: { url } }` with the exact endpoint, and `new URL(url).host` is in the fixed seven-host set; `endpoint` has no other keys; `editableEndpoint` is undefined; `defaultEnabled === false`; `icon === "./icons/<id>.svg"` and the file exists.
  - `auth` `toEqual` the Global Constraints object with that template's scopes; `auth.authorizationUrl === GOOGLE_ENDPOINTS.authorizationUrl` and `auth.tokenUrl === GOOGLE_ENDPOINTS.tokenUrl` (imported from `../src/config.js`); `Object.keys(auth.authorizationParams).sort()` is `["access_type", "prompt"]`; no key of it is in `OAUTH_RESERVED_AUTHORIZATION_PARAMS`; `include_granted_scopes` is absent; every scope matches `^https://www\.googleapis\.com/auth/[a-z.]+$`.
  - Policies against the fixture: `Object.keys(policies).sort()` equals the fixture's tool names sorted; `policies[t] === "allow"` iff the fixture's `readOnlyHint` is true, otherwise `"ask"`; no `"deny"`; a hand-written `MUST_ASK` list per template (the Review Focus 2 names) is `ask` (this guards against a fixture recorded with a wrong hint).
  - Scope coverage: for every fixture tool, `tool.scopes` intersects `auth.scopes` (every tool is callable with the requested grant).
  - Tool keys: every name matches `^[a-z0-9_]+$` and ``mcp__${slug}__${name}`` fits 64 characters with the template id as the slug (`google-slides` + `read_slide_page_thumbnail`, 45 characters, is the longest).
  - `plugin.json`: `parsePluginManifest` has no errors; `connectorTemplates` lists the seven paths in D8 order; `dependencies` equals `[{ name: "connector-mcp", version: <every template's pluginVersion> }]`; all templates share one `pluginVersion` matching `^\^0\.1\.0-rc\.\d+$`.
- [ ] **Step 3: Run** `pnpm exec vitest run plugins/google/test/connector-templates.test.ts` → FAIL (no templates).
- [ ] **Step 4: Write** the seven templates, the icons and the `plugin.json` keys.
- [ ] **Step 5: Run** the test → PASS; `pnpm check` (the pack check reads `connectors/*.json` and the icons; the icon check covers `google` through its brand exemption); `pnpm exec vitest run plugins/google/test/manifest.test.ts` stays green.
- [ ] **Step 6: Commit** `feat(google): Google Workspace and BigQuery connector templates (#139)`.

## Task 3: Guides (seven templates, zh / en)

**Files:**
- Create: `plugins/google/guides/{gmail,google-drive,google-calendar,google-sheets,google-docs,google-slides,bigquery}-oauth.md` and `.zh.md` (14 files)
- Modify: `plugins/google/.capybara-plugin/plugin.json` (`setupGuides`: the existing `google-sign-in` entry, then `{ "id": "<id>-oauth", "place": "connector-template", "template": "<id>" }` × 7: eight entries, the limit)
- Test: `plugins/google/test/guides.test.ts` (extend; keep the sign-in cases)

**Interfaces:**
- Variables used: `{{oauthCallbackUrl}}`, `{{templateName}}`, `{{pluginName}}`, `{{pluginVersion}}` (all offered at `connector-template`). Kernel checks only (the extension registers none for templates): admin `capybara:oauth-client`, `capybara:oauth-token-endpoint`, `capybara:connector-tools`; member `capybara:connector-connected`.
- Admin section, in order (one shared structure; only the product names, the services to enable and the scopes differ):
  1. **Before you start.** State that Google offers these servers as part of the Google Workspace Developer Preview Program: the Workspace account and the Cloud project must be accepted into it ([DPP]), and preview terms apply (no access for users outside the company). BigQuery's guide drops this paragraph and says the server has no preview label (R2).
  2. **Project.** Use a Google Cloud project owned by the Workspace organization, ideally the one used for Sign in with Google. Enable the services in the **same project as the OAuth client** (R3). A fenced `sh` block, byte-equal in zh: `gcloud services enable gmail.googleapis.com gmailmcp.googleapis.com --project=PROJECT_ID` (Drive `drive.googleapis.com drivemcp.googleapis.com`; Calendar `calendar-json.googleapis.com calendarmcp.googleapis.com`; Sheets `sheets.googleapis.com sheetsmcp.googleapis.com`; Docs `docs.googleapis.com docsmcp.googleapis.com`; Slides `slides.googleapis.com slidesmcp.googleapis.com`; BigQuery `bigquery.googleapis.com`, with the note that enabling the API enables its MCP server and needs Service Usage Admin [BQ], [ENABLE]).
  3. **Consent screen.** Audience **Internal**: no Google verification even for the restricted Gmail / Drive scopes, and refresh tokens do not expire after 7 days. External only with test users, whose refresh tokens expire after 7 days in Testing; production External needs verification, plus CASA for restricted scopes.
  4. **OAuth client.** Google Auth Platform → Clients → Create client → **Web application**; authorized redirect URI `{{oauthCallbackUrl}}`; select **Use this client for an AI-powered agent**. Use a client **separate from the Sign in with Google client** (Google requires the setting for the Workspace servers and asks for a separate client when one also serves non-agent features, [WS]). One agent client can serve every Google connector of the org. A YAML block like GitHub's: `Application type: Web application`, `Authorized redirect URIs: ["{{oauthCallbackUrl}}"]`, `Use this client for an AI-powered agent: on`, `Scopes requested:` (the template's scope list, so the block shows them).
  5. **Enter the client** id and secret below, then `::check capybara:oauth-client`, `::check capybara:oauth-token-endpoint`, `::check capybara:connector-tools`.
  6. **Tools and approvals.** Reads run directly and every write asks the member (list the write tool names); change per tool on the connector page. Drive / Sheets / Docs / Slides: `drive.file` covers only files the connector created or opened, so writes to other files fail with Google's permission error. Gmail: there is no send tool (drafts only).
  7. **BigQuery only.** Grant each member `roles/mcp.toolUser`, `roles/bigquery.jobUser` and `roles/bigquery.dataViewer` on the projects they query ([BQ]). Every tool takes a `projectId`; tell the agent which project to use.
  8. **If calls are refused.** A Workspace admin may restrict third-party API access (Admin console → Security → API controls, [BLOG]); trust the client there. A 403 that names the agent setting means the client is not flagged ([WS] troubleshooting).
- Member section: **Connect** → Google's consent screen; **keep every box ticked** (granular consent lets a person untick scopes, and the matching tools then fail with Google's insufficient-scope error; reconnect and tick them to fix); writes ask first; **Disconnect** deletes the token in Capybara, and Google Account → Security → third-party connections revokes it at Google; `::check capybara:connector-connected`.

- [ ] **Step 1: Write the failing tests** in `guides.test.ts`, a `describe("connector template guides")` over the seven ids (`values` as in `plugins/github/test/guides.test.ts`, including the hostile `templateName`):
  - `plugin.json` `setupGuides` equals the eight entries in order, and `setupGuides.length === SETUP_GUIDE_LIMITS.guides`.
  - Each guide: `validateSetupGuide({ place: "connector-template", id, en, zh, pluginChecks: [] })` → `[]`; for both audiences the zh render has byte-equal code blocks and the same check ids as en; the zh document contains neither `企业` nor `/\bagents?\b/i`.
  - Admin render: title present, `audiences` `["admin", "member"]`, `unresolved` `[]`; the rendered text contains `values.oauthCallbackUrl` and `Use this client for an AI-powered agent`; the `sh` block's services are exactly that template's (table above, parsed from the block); every scope of the template appears in the YAML block (parsed with `yaml`) and the block lists no other scope; checks are exactly `capybara:oauth-client`, `capybara:oauth-token-endpoint`, `capybara:connector-tools`; the hostile template name stays inside a YAML comment.
  - BigQuery admin: contains the three role ids; does not contain "Developer Preview Program". The six Workspace guides contain it.
  - Member render: no code blocks; checks `["capybara:connector-connected"]`; contains the keep-every-box-ticked sentence; contains no admin heading.
- [ ] **Step 2: Run** `pnpm exec vitest run plugins/google/test/guides.test.ts` → FAIL.
- [ ] **Step 3: Write** the 14 guide files and the `setupGuides` entries.
- [ ] **Step 4: Run** → PASS; `pnpm check` (the pack reads every guide).
- [ ] **Step 5: Commit** `feat(google): setup guides for the Workspace connector templates (#139)`.

## Task 4: Kernel-level connect test

The template's auth preset goes through a real kernel against a Google-like authorization server.
The kernel cannot reach Google from a test and the template's URLs are not editable, so the test
creates a connector from the **template file's own auth object** with only `authorizationUrl` /
`tokenUrl` replaced by the fake's, and the endpoint pointed at `startFakeMcpServer`. It uses the
testing kit's `fake-connector` (an MCP client like connector-mcp, allowed by
`plugin-test-imports`). The catalog path (import, switch on, create from template) is covered by
the live acceptance below.

**Files:**
- Create: `plugins/google/test/kernel/connect.test.ts` (one kernel per file)

**Interfaces:**
- Consumes: `startTestKernel`, `testKernelConfig`, `startTestPostgres`, `startTestRedis`, `createDb`, `kernelDb`, `createLocalAccount`, `login`, `createOrg`, `enableModelProviders`, `createConversation`, `postMessage`, `waitForTerminal`, `eventsOf`, `truncateTables`, `fakeExtensionEntry("fake-connector")`, `startFakeMcpServer`, `startFakeOAuthServer` from `@capybara-hq/testing`; the template files read with `readFileSync`.
- Kernel config: `extensions: ["@capybara-hq/plugin-model-fake", fakeExtensionEntry("fake-connector")]`, `extensionPermissions: { autoApprove: true }`, `extensionConfig: { "fake-connector": {} }`, `roles: ["api", "worker"]`, `http: { port: 0, publicUrl: "https://cap.example" }`, `auth: { cookieSecure: false }`, `net: { allowInsecureLoopback: true }`, `tools: { oauthAllowInsecureLoopback: true, timeoutMs: 5_000 }`; `resolveFrom` the plugin dir; log lines captured. Per test: an org with model-fake and `fake-connector` switched on (`extension_org_configs` row, as `plugins/connector-mcp/test/kernel/mcp-e2e.test.ts` does for connector-mcp).
- Fakes per test: `startFakeOAuthServer({ refreshTokenOnlyWith: { access_type: "offline", prompt: "consent" }, clients: [{ clientId: "google-agent-client", clientSecret: "google-agent-secret-0123456789", redirectUris: ["https://cap.example/api/v1/oauth/callback"] }] })` and `startFakeMcpServer({ verifyBearer: (t) => as.verify(t), tools: [one read-only `list_labels` echoing the caller] })`.
- Helpers in the file, as in core's `packages/kernel/test/tools/oauth/oauth.http.test.ts`: `install(templateId)` → `POST /api/v1/orgs/:orgId/connectors` with `{ name, slug: templateId, connector: "fake", endpoint: { url: mcp.url }, auth: { ...template.auth, authorizationUrl: as.issuer + "/authorize", tokenUrl: as.issuer + "/token" }, credential: { clientId, clientSecret } }` → 201; `connect(id)` → `POST …/connect` → authorize URL; `approve(url)` → `fetch(url, { redirect: "manual" })` → callback path; `callback(path)` → 302.

- [ ] **Step 1: Write the tests:**
  - `it.each(TEMPLATE_IDS)("%s: the template's auth preset installs and its authorize request asks for offline access with exactly its scopes")`: install → 201; connect; `as.authorizeRequests[0]` has `access_type=offline`, `prompt=consent`, `code_challenge_method=S256`, a `state`, `client_id=google-agent-client`; `scope` split on spaces equals the template's scopes; no `include_granted_scopes`, no `resource`; after the callback, the code exchange used `clientAuth: "post"`.
  - `it("gmail: the refresh token is stored, used after the access token dies, and re-issued on reconnect")`: connect fully; `as.revokeAccessTokens()`; an agent with `disabledTools: []` (as `agentFor` in `plugins/connector-mcp/test/kernel/mcp-e2e.test.ts`) runs model-fake's `tool:mcp__gmail__list_labels:{}` and gets a non-error result; `as.tokenRequests` grant types are `["authorization_code", "refresh_token"]` with the refresh answered 200; reconnect → `authorizeRequests[1]` carries both parameters again; no token request carries `access_type` or `prompt` (`paramNames`).
  - `it("gmail: a refresh token Google revoked asks the member to reconnect")`: connect; `revokeAccessTokens()` and `revokeRefreshTokens()`; the tool call's result is the kernel's "connection required" error and a `connection_required` event exists.
  - `it("no token or client secret reaches logs, events or HTTP bodies")`: every value of `as.issuedSecrets()` and the client secret is absent from the captured log lines, the conversation events (`eventsOf`) and every HTTP body the test received.
- [ ] **Step 2: Run** `pnpm exec vitest run plugins/google/test/kernel/connect.test.ts` → PASS (Tasks 1–2 are in). If a case fails, fix the template, not the expectation, and report it.
- [ ] **Step 3: Commit** `test(google): connect the Workspace templates through a real kernel (#139)`.

## Task 5: Live test

**Files:**
- Create: `plugins/google/test/live/google-mcp.live.test.ts`

**Interfaces:**
- Variables: `CAPYBARA_TEST_LIVE_TOOLS=1` turns on the unauthenticated part. `CAPYBARA_TEST_GOOGLE_ACCESS_TOKEN` adds the authenticated part: a short-lived access token for a member of the maintainer's Workspace, minted outside the test with the **agent-flagged** test client and the union of the seven templates' scopes. Mint it with the OAuth 2.0 Playground ("Use your own OAuth credentials"; its redirect URI added to the test client) or any one-off script; never committed. Optional `CAPYBARA_TEST_GOOGLE_BIGQUERY_PROJECT` enables the BigQuery call. `CAPYBARA_TEST_GOOGLE_RECORD_FIXTURES=1` rewrites `test/fixtures/*-tools.json` from the live answers instead of comparing. Values starting with `replace` / `替换为` count as unset (the `filled()` guard of the existing live tests); one skip line is logged otherwise. Nothing beyond tool names, counts and statuses is printed.
- The MCP session helper follows `plugins/github/test/live/github.live.test.ts` (`initialize`, `notifications/initialized`, JSON or SSE answers).

- [ ] **Step 1: Write the test:**
  - Unauthenticated, per template: `initialize` answers a `protocolVersion`; `tools/list` names and hints equal the fixture (on mismatch the failure lists added / removed / changed names, so the fixture and the policies are updated together); each tool's per-tool metadata `scopes_supported` intersects the template scopes; an unauthenticated `tools/call` of the first read-only tool answers 401 with a `WWW-Authenticate` naming `resource_metadata`; the server-level metadata (`/.well-known/oauth-protected-resource/mcp/v1`, or `/mcp` for BigQuery) lists an authorization server whose origin is `https://accounts.google.com`.
  - Authenticated, per template: `tools/list` with the token; report any difference from the unauthenticated list (R6) as a failure naming the tools; one read-only call: Gmail `list_labels`, Drive `list_recent_files`, Calendar `list_calendars`; Sheets `get_spreadsheet`, Docs `read_doc` and Slides `read_presentation` with an id that does not exist (expect a tool-level error result, not HTTP 401 / 403: this proves the token, the agent flag and the enabled service were accepted); BigQuery `list_dataset_ids` with the optional project.
- [ ] **Step 2: Run** without variables: `pnpm exec vitest run plugins/google/test/live/google-mcp.live.test.ts` → skipped. With `CAPYBARA_TEST_LIVE_TOOLS=1` alone → the unauthenticated part passes. With the token (`set -a; . ~/.capybara-test.env; set +a; …`) → PASS, or report which part could not run (no agent-flagged test client yet: see Maintainer answers).
- [ ] **Step 3: Commit** `test(google): live checks against Google's MCP servers (#139)`.

## Task 6: Docs, spec errata, changeset

**Files:**
- Modify: `plugins/google/README.md`. Covers the connector templates (what each does, the scopes, policies, the separate agent client, Internal vs External, Developer Preview enrolment and terms, the BigQuery roles). Also covers what lands in the event log (Gmail and Drive content) and [SEC]'s prompt-injection screening note for Workspace admins, plus "requires kernel ≥ 0.1.0-rc.68". It lists the live acceptance items below and the sources with access dates, and drops the "phase 2, waiting" line.
- Modify: `plugins/google/package.json` `description` and `.capybara-plugin/plugin.json` `description` (en / zh): Sign in with Google plus Google Workspace and BigQuery connector templates; root `README.md` table row.
- Modify: `AGENTS.md` ("Live API tests": `CAPYBARA_TEST_GOOGLE_ACCESS_TOKEN` with `CAPYBARA_TEST_LIVE_TOOLS`, optional `CAPYBARA_TEST_GOOGLE_BIGQUERY_PROJECT`).
- Modify: `.agents/skills/writing-plugins/SKILL.md`, the connector template `auth` bullet: `oauth_code` may carry `authorizationParams` (≤ 10, names `[a-z][a-z0-9_]{0,39}`, printable values ≤ 200, never a kernel-owned name, never a secret; e.g. Google's `access_type` / `prompt`); `plugins/google` is the reference. This is the template-author follow-up named in core's design §3.7.
- Modify: `.agents/skills/writing-connectors/SKILL.md` (live variables line: the Google MCP live test).
- Modify: `docs/superpowers/specs/2026-11-22-google-plugin-design.md`. Add a dated erratum note under §2.3 pointing at this plan's re-verification. In §5.1, remove `include_granted_scopes` from the example (Open question 4). In §5.3, use a separate agent-flagged client instead of "add the callback to the sign-in client" (Open question 2). Phase 1's guide does not mention the connector callback, so it needs no change.
- Create: `.changeset/google-workspace-connectors.md` (`"@capybara-hq/plugin-google": minor`, "Google Workspace (Gmail, Drive, Calendar, Sheets, Docs, Slides) and BigQuery connector templates on connector-mcp, each with a setup guide; needs kernel 0.1.0-rc.68 or newer"). In pre mode this publishes `0.1.0-rc.1`.

- [ ] **Step 1: Write the docs and the changeset.**
- [ ] **Step 2: Run** `pnpm verify` (lint, typecheck, checks, tests of the touched packages) → PASS. `pnpm check:marketplace` must still pass: the feature PR does not touch `marketplace.json`.
- [ ] **Step 3: Commit** `docs(google): Workspace connector templates in the README and skills (#139)`; open the PR (`Refs #139`, links core#552 / core#608) per the `contributing` skill. The PR body names the Review Focus items and that the BigQuery redirect URI is verified on acceptance.

## Release and acceptance

- After the merge, the Version Packages PR (changesets) bumps `plugins/google` to `0.1.0-rc.1`, runs `capybara-plugin sync-versions` (package, `plugin.json`, the extension's `version`) and `capybara-plugin marketplace --write`. **That PR is where the `google` marketplace entry changes**, never by hand. Merging it publishes through `release --auto` (the npm name is already published, so no staging step).
- **Live acceptance** on a dev deployment at kernel ≥ 0.1.0-rc.68, with the maintainer's Internal agent-flagged client:
  1. Import `google@0.1.0-rc.1`; the seven templates appear switched off in an org; the import review shows each template's auth with `authorizationParams`.
  2. Switch on Gmail, create the connector, enter the client: all three admin checks are green.
  3. A member connects: Google's consent lists the three Gmail scopes; `list_labels` runs; a draft asks first.
  4. More than an hour later (or after revoking the access token at Google), a call still works (refresh). Reconnecting shows consent again (`prompt=consent`).
  5. Repeat steps 2–3 for the other five Workspace templates with the same client.
  6. **BigQuery** (Open question 3): create, connect and run `execute_sql_readonly` on a project where the member has the three roles. Note whether Google accepted the redirect URI.
  7. Untick one scope at consent: the matching tool fails with Google's insufficient-scope error, and the member guide's advice fixes it.
- Upgrade prod only after acceptance (standing grant: official releases only).

---

## Open questions (with recommendations)

**Resolved 2026-11-22 by the maintainer:** every recommendation below is accepted. No Google test
OAuth client exists for now, so live acceptance (enrolment, BigQuery redirect URI, logged-in tool
lists) is deferred; the live test skips until credentials exist.

1. **Developer Preview enrolment (R1).** Google's pages disagree on whether enrolment is required.
   *Recommendation:* the Workspace guides state enrolment (Workspace account and Cloud project)
   as Google's prerequisite and quote the terms that matter (no access for users outside the
   company), and the README says the same. Live acceptance records whether an unenrolled project
   works; if it does, a later patch softens the wording. Keep D10.
2. **One client for sign-in and connectors?** The spec (§5.3) and phase 1 assumed one Web client.
   Google now blocks clients without the agent flag from the Workspace servers and says to split a
   client that also serves non-agent features (R4). *Recommendation:* a separate agent-flagged
   client for the connectors, in the same project; one such client for all seven connectors. Amend
   spec §5.3 in this PR (Task 6).
3. **BigQuery and "Custom redirect URIs aren't supported" (R4).** We read it as "register the
   redirect URI your application documents". It is unproven for a third-party Web client.
   *Recommendation:* keep the `bigquery` template (`defaultEnabled: false`) and verify on live
   acceptance before the Version Packages PR merges. If Google refuses the redirect URI, remove
   `bigquery` (template, guide, fixture, icon) in a follow-up patch before the release, and record
   it in the spec.
4. **`include_granted_scopes`.** Spec §5.1's example sends it; D14 as accepted does not.
   *Recommendation:* do not send it. All seven connectors share one client, so incremental
   authorization would give each connector's token the union of every scope the member granted
   to the client, for example a Docs connector token that can read Gmail. Without it, each token
   carries only its template's scopes. Spec erratum in Task 6.
5. **Authenticated tool lists (R6).** Unauthenticated `tools/list` is what we can record; a token
   may see a different list during the preview. *Recommendation:* fixtures from the
   unauthenticated list; the authenticated live part fails on any difference so the fixture and
   policies are updated together. Unlisted tools fall back to the kernel's annotation default
   (`readOnlyHint` → allow, otherwise ask), which matches the template rule.
6. **Keeping older deployments from importing templates they cannot parse.** A kernel before
   rc.68 refuses `authorizationParams` (the `oauth_code` schema is strict), but only deep in the
   import review. The marketplace entry has a `minKernel` field that `capybara-plugin marketplace`
   does not write. *Recommendation:* raise the extension's `sdk` range to `^0.1.0-rc.52` (Task 1).
   The import then refuses the plugin with the host-SDK check's clear message, and the README states
   the kernel minimum. A toolchain follow-up for `minKernel` is optional.
7. **Quota and billing project (R3).** Undocumented. *Recommendation:* the guides require the
   client and the enabled services in one project, and the templates send no
   `x-goog-user-project` header (the endpoint is not org-editable). Revisit only if acceptance
   shows quota errors naming another project.
8. **[SEC]'s "You must screen prompts and responses".** It addresses the integrator's MCP traffic
   (Model Armor floor settings in the customer's project). *Recommendation:* no product change in
   phase 2. The README tells Workspace admins about Model Armor floor settings as a project-level
   option, and that tool results are model input. A Capybara-wide prompt-injection screening
   design, if wanted, is separate work.
9. **Product icons.** The spec says each template carries its product icon. Google permits
   referring to its products with their marks but has usage rules. *Recommendation:* use Google's
   official, unaltered product icons (as Slack and GitHub plugins use their vendors' marks) and
   record the source in the README. If the maintainer prefers not to, use the G mark
   (`./icon.svg`) for all seven: one path change per template, tests unchanged otherwise.

## AGENTS.md rules touched

None changed. This plan relies on: "no stdio MCP" (remote Streamable HTTP only); "every admin-supplied URL goes through `packages/kernel/src/net`" (template URLs are fixed, not admin-supplied); multi-replica discipline (no extension state added); live API tests gated by `CAPYBARA_TEST_*` with keys outside the repository; "contract changes need a PR in core first" (core#552 / core#608, released); one `plugin-sdk` instance in this repository; `marketplace.json` written only by the Version Packages flow.
