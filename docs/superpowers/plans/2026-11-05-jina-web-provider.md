# Jina Web Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `jina` plugin that gives every org that enables it (with its own Jina API key) the
kernel's builtin `WebSearch` and `WebFetch` tools, by providing `web-search@1` and `web-fetch@1`.

**Architecture:** The kernel owns both tools, their specs, approval, URL rules, result filtering,
the page cache and the extraction call. The plugin only translates the two provider calls into
Jina HTTP requests (`s.jina.ai` search, `r.jina.ai` reader) with the org's key from `orgConfig`
and maps HTTP failures to `WebProviderError` kinds. It registers no tools and keeps no state.

**Tech Stack:** TypeScript, `@capybara-hq/plugin-sdk@^0.1.0-rc.2` (the web points), zod 4, global
`fetch`; tests with vitest, a fake Jina server on `node:http`, and `@capybara-hq/testing@^0.1.0-rc.4`
(a kernel that has the web tools).

**Spec:** core `docs/superpowers/specs/2026-11-04-web-tools-design.md` §11 (the plugin), §4 (the
two points), §7.1 (URL rules) and its "As built" section. Read §11 and §4 in full before Task 2.

## Global Constraints

- Prerequisite (Task 1, its own PR, merged first): this repository on the core release that
  carries the points: `@capybara-hq/plugin-sdk` `^0.1.0-rc.2`, `@capybara-hq/testing`,
  `@capybara-hq/plugin-tools` `^0.1.0-rc.4`, `@capybara-hq/plugin-model-fake` `^0.1.0-rc.2`.
- `plugins/jina`, npm `@capybara-hq/plugin-jina`, extension name `jina`,
  `provides: ["web-search@1", "web-fetch@1"]` (use `WEB_SEARCH_EXTENSION_POINT` /
  `WEB_FETCH_EXTENSION_POINT`), registers no tools.
- `config.org`: `{ apiKey: secret(z.string().min(1)) }`; `configured(orgConfig)` is true iff that
  schema parses `orgConfig`.
- `config.deployment`: `{ searchUrl, readerUrl }`, defaults `https://s.jina.ai` / `https://r.jina.ai`
  (for tests and proxies).
- `permissions.network`: `["s.jina.ai", "r.jina.ai"]`.
- Every config field has `ui(…, { label: { zh, en } })` (`plugin-config-labels`); `plugin.json`
  has `displayName` `{ "zh": "Jina 网页搜索", "en": "Jina web search" }` (`release-display-name`).
- `signal` is passed to every `fetch`. The API key never appears in a log line, an error message
  or a thrown error's fields. Provider error messages are for logs only (the kernel writes the
  model-visible text from `kind`), so they say `Jina search failed: HTTP <status>` /
  `Jina reader failed: HTTP <status>` and never echo a response body.
- English for code, comments, test titles; model-facing text is the kernel's, the plugin writes none.
- Commits: Conventional Commits, body lines ≤ 100 characters; the plugin PR adds a changeset.

## Review Focus

1. A Jina response whose items lack fields (no `description`, empty `title`, a relative or
   non-http `url`, a `date` that does not parse) → the item is kept with what is valid, or dropped
   when its URL is unusable; nothing throws. Test in Task 3.
2. Jina answering 200 with a body that is not the expected JSON (HTML error page, `data: null`)
   → `WebProviderError` `unavailable`, not a `TypeError` the kernel reports as a generic failure.
   Tests in Tasks 3 and 4.
3. The kernel aborting the call (tool timeout, run stopped) → the `fetch` is aborted and the abort
   error propagates unchanged (not rewrapped as `unavailable`). Test in Task 2.
4. A page URL with a query string and a fragment (`https://example.com/a?x=1&y=2#top`) reaches
   Jina byte-for-byte. Test in Task 4.
5. A deployment `searchUrl` / `readerUrl` with a trailing slash or a path prefix (a proxy at
   `https://proxy.example/jina/s/`) → requests go to that prefix without a double slash. Test in
   Task 2.

---

### Task 1: Move the repository to the core release with the web points (own PR)

Trying the upgrade (`pnpm up -r` of the four core packages) showed what it brings: `capybara-plugin
check` fails with 67 `plugin-config-labels` findings and 11 `release-display-name` findings (every
published plugin), and `pnpm typecheck` fails in the slack / lark kernel tests because the kernel
now brings `kysely@0.29.8` while the plugins' devDependency resolves `0.29.6`.

**Files:**
- Modify: root `package.json` and every `plugins/*/package.json` that names a core package or `kysely`
- Modify: `pnpm-lock.yaml`
- Modify: the config schemas of `anthropic`, `connector-mcp`, `connector-openapi`, `lark`,
  `object-store-s3`, `openai`, `openai-compatible`, `sandbox-docker`, `sandbox-e2b`, `slack` (wherever
  `capybara-plugin check` points); `plugins/*/.capybara-plugin/plugin.json` of the 11 published plugins
- Create: `.changeset/core-rc4-labels.md`

- [ ] **Step 1: Branch.** From the main checkout: `pnpm wt:new chore/core-rc4` and work there.
- [ ] **Step 2: Upgrade.** `pnpm up -r "@capybara-hq/plugin-sdk@^0.1.0-rc.2" "@capybara-hq/testing@^0.1.0-rc.4" "@capybara-hq/plugin-tools@^0.1.0-rc.4" "@capybara-hq/plugin-model-fake@^0.1.0-rc.2"`,
  then raise every `kysely` devDependency to the version the kernel brings (`^0.29.8`). Also raise
  each plugin's `defineExtension({ sdk })` range only if `capybara-plugin check` asks for it.
- [ ] **Step 3: Labels.** Run `pnpm -s check`; for every `plugin-config-labels` finding wrap the field
  with `ui(schema, { label: { zh, en } })` from the SDK (outermost, after `.default()` /
  `.optional()`). Labels are short nouns ("API 密钥" / "API key", "接口地址" / "API URL"); add
  `help` only where the field's existing doc comment says something a deployer needs. A secret
  record named by `x-ui.secrets[].path` is exempt (the check says so). Hints never change
  validation: do not touch the zod shape.
- [ ] **Step 4: Display names.** Add `"displayName": { "zh": …, "en": … }` to each finding's
  `plugin.json` (e.g. `anthropic`: "Anthropic" / "Anthropic"; `object-store-s3`: "S3 对象存储" /
  "S3 object storage"; `todo`: "待办清单" / "Todo list"). Keep `capybara-plugin sync-versions` happy
  (versions untouched).
- [ ] **Step 5: Verify.** `pnpm -s check` → no findings; `pnpm typecheck` → exit 0; `pnpm lint`;
  `pnpm test` (Docker running) → green. A failure that comes from core's builtin tool rename (old
  keys `sandbox_*`, `skill_load`, …, issue #4) is fixed here only if it blocks this upgrade, with a
  note on #4; otherwise it stays for #4.
- [ ] **Step 6: Changeset and commit.** One changeset bumping every touched published plugin
  (`patch`): "Run on core 0.1.0-rc.4: bilingual config field labels and a display name." Commit
  `chore: move to core 0.1.0-rc.4 and label every config field`. Open the PR (with the user's
  agreement); the Jina work branches from `main` after it merges.

---

### Task 2: Plugin skeleton, config and the Jina HTTP helper

**Files:**
- Create: `plugins/jina/package.json`, `plugins/jina/tsconfig.json`, `plugins/jina/README.md`,
  `plugins/jina/.capybara-plugin/plugin.json`
- Create: `plugins/jina/src/index.ts`, `plugins/jina/src/config.ts`, `plugins/jina/src/http.ts`
- Create: `plugins/jina/test/fake-jina.ts`, `plugins/jina/test/http.test.ts`, `plugins/jina/test/config.test.ts`
- Modify: root `tsconfig.json` (add `{ "path": "plugins/jina" }` in name order)

Copy `package.json` / `tsconfig.json` from `plugins/openai-compatible` (same `exports` with the
`@capybara-hq/source` condition, `files: ["dist"]`, `repository.directory: "plugins/jina"`,
homepage `…/tree/main/plugins/jina#readme`), version `0.1.0-rc.0`, description
`Web search and page reading (web-search@1, web-fetch@1) through Jina's search and reader APIs`,
dependencies `@capybara-hq/plugin-sdk` and `zod` only, devDependency `@capybara-hq/testing`.

**Interfaces:**
- Produces (`src/config.ts`):
  - `JinaOrgConfig` (zod object `{ apiKey }`), `JinaDeployment` (zod object `{ searchUrl, readerUrl }`
    with the defaults), `type JinaEndpoints = { searchUrl: string; readerUrl: string }`
  - `jinaConfigured(orgConfig: unknown): boolean`
  - `apiKeyOf(orgConfig: unknown): string`: the parsed key; throws `WebProviderError` kind `auth`
    (`"Jina is not configured for this organization"`) when it does not parse
- Produces (`src/http.ts`):
  - `type JinaOp = "search" | "reader"`
  - `jinaErrorKind(op: JinaOp, status: number): WebProviderErrorKind`
  - `jinaRequest(op: JinaOp, url: string, init: { apiKey: string; method: "GET" | "POST"; headers?: Record<string, string>; body?: string; signal: AbortSignal }): Promise<unknown>`:
    sends `Authorization: Bearer <key>` and `Accept: application/json`, returns the parsed JSON body
    on 2xx; throws `WebProviderError` otherwise
  - `joinUrl(base: string, path: string): string`: base without trailing `/` + path starting with `/`
- Produces (`test/fake-jina.ts`): `startFakeJina(): Promise<FakeJina>` with
  `FakeJina = { url: string; requests: FakeJinaRequest[]; respond(fn: (req: FakeJinaRequest) => { status: number; body: string; delayMs?: number }): void; stop(): Promise<void> }`,
  `FakeJinaRequest = { method: string; path: string; headers: Record<string, string>; body: string }`
  (`path` is the raw request target, query included; header names lowercased).

The status mapping (spec §11, refined):

| Status | search | reader |
|---|---|---|
| 401, 403 | `auth` | `auth` |
| 402, 429 | `rate_limited` | `rate_limited` |
| 404 | `not_found` | `not_found` |
| 422 | `invalid` | `not_found` (Jina could not read the target page) |
| 451 | `blocked` | `blocked` |
| 400, other 4xx | `invalid` | `invalid` |
| 5xx | `unavailable` | `unavailable` |

A network error (fetch rejects while `signal` is not aborted) and a 2xx body that is not JSON are
`unavailable`. When `signal.aborted`, rethrow what `fetch` threw, unchanged.

- [ ] **Step 1: Write the failing tests** (`test/http.test.ts`, against `startFakeJina`):
  - `it.each` over the table above for both ops: `jinaErrorKind(op, status)` equals the cell.
  - `"sends the bearer key and Accept: application/json"`: fake answers `200 {"data":[]}`;
    `requests[0].headers.authorization === "Bearer k-123"`, `accept === "application/json"`.
  - `"a 401 is auth and the error carries neither the key nor the body"`: fake answers
    `401 {"message":"bad key k-123"}`; rejects with `WebProviderError` `kind: "auth"`,
    `message === "Jina search failed: HTTP 401"`, and `JSON.stringify(err)` + `err.message` +
    `String(err.stack)` contain no `k-123`.
  - `"a 200 HTML body is unavailable"`: `200 <html>…` → kind `unavailable`.
  - `"a refused connection is unavailable"`: request to a closed port → kind `unavailable`.
  - `"an aborted call rethrows the abort"`: fake delays 5 s; abort after 50 ms with
    `AbortSignal.timeout`-style reason `new Error("stop")` via `AbortController.abort(reason)`;
    the rejection is that same reason object (`toBe`), not a `WebProviderError`.
  - `joinUrl("https://proxy.example/jina/s/", "/?q=x") === "https://proxy.example/jina/s/?q=x"` and
    `joinUrl("https://s.jina.ai", "/") === "https://s.jina.ai/"`.
  - `test/config.test.ts`: `jinaConfigured({ apiKey: "k" })` true; `{}`, `{ apiKey: "" }`, `null`
    false; `JinaDeployment.parse({})` equals `{ searchUrl: "https://s.jina.ai", readerUrl: "https://r.jina.ai" }`;
    `apiKeyOf({})` rejects with kind `auth`.
- [ ] **Step 2: Run them to see them fail.** `pnpm exec vitest run plugins/jina` → FAIL (modules missing).
- [ ] **Step 3: Implement** `config.ts`, `http.ts`, `fake-jina.ts`, `plugin.json` (schemaVersion 1,
  name `jina`, version, publisher `Capybara`, description, homepage, `displayName` from Global
  Constraints) and an `index.ts` that `defineExtension`s `jina` with `sdk: "^0.1.0-rc.2"`,
  `provides`, `permissions.network`, `config: { deployment: JinaDeployment, org: JinaOrgConfig }`
  and, for now, a `setup` that parses the deployment config only. `apiKey` label "API 密钥" /
  "API key" with help "在 jina.ai 的 API 控制台创建。" / "Create one in the Jina API dashboard at jina.ai.";
  `searchUrl` / `readerUrl` labels "搜索接口地址" / "Search API URL", "读取接口地址" / "Reader API URL",
  both `advanced: true`.
- [ ] **Step 4: Run them to see them pass,** plus `pnpm -s check` (Config forms, Plugin pack,
  release metadata clean for `jina`) and `pnpm typecheck`.
- [ ] **Step 5: Commit** `feat(jina): add the plugin skeleton, config and Jina HTTP helper`.

---

### Task 3: `web-search@1` provider

**Files:**
- Create: `plugins/jina/src/search.ts`, `plugins/jina/test/search.test.ts`
- Modify: `plugins/jina/src/index.ts` (provide it)

**Interfaces:**
- Consumes: `jinaRequest`, `joinUrl`, `apiKeyOf`, `jinaConfigured`, `JinaEndpoints` (Task 2)
- Produces: `createJinaSearch(endpoints: Pick<JinaEndpoints, "searchUrl">): WebSearchProvider`

Request: `GET joinUrl(searchUrl, "/?q=" + encodeURIComponent(query))` with
`X-Respond-With: no-content` (snippets only, no page bodies: saves quota). Exactly one
`allowedDomains` entry adds `X-Site: https://<domain>`; zero or several add nothing (the kernel
filters). `blockedDomains` are not sent (the kernel filters). No result-count parameter is sent;
the provider slices to `maxResults`.

Response: `{ data: Array<{ title?, url?, description?, date?, publishedTime? }> }`. Map each item to
`WebSearchResult`: `url` kept only if `new URL(url)` parses with protocol `http:` / `https:` (else
the item is dropped); `title` = trimmed title, or the URL when empty; `snippet` = trimmed
`description` when non-empty; `publishedAt` = `publishedTime ?? date` when `Date.parse` accepts it.
`data` missing or not an array → `WebProviderError` `unavailable` (`"Jina search returned an
unexpected response"`); an empty array is `{ results: [] }`.

- [ ] **Step 1: Write the failing tests** (`test/search.test.ts`, fake Jina):
  - `"maps Jina results"`: fake returns two items (one with all fields, `publishedTime:
    "2026-11-01T08:00:00Z"`); result equals
    `[{ title: "A", url: "https://a.example/x", snippet: "about a", publishedAt: "2026-11-01T08:00:00Z" }, { title: "B", url: "https://b.example/" }]`.
  - `"sends the query, no-content and no site for zero or several domains"`: `requests[0].path`
    `=== "/?q=capybara%20release%20%26%20notes"` for query `capybara release & notes`;
    `x-respond-with === "no-content"`; no `x-site` with `allowedDomains: ["a.com", "b.com"]`.
  - `"one allowed domain becomes X-Site"`: `x-site === "https://docs.jina.ai"`.
  - `"slices to maxResults"`: 12 items, `maxResults: 10` → 10 results, in order.
  - `"drops unusable URLs and fills a missing title"` (Review Focus 1): items with `url:
    "/relative"`, `url: "ftp://x.example/f"`, no `url`, and `{ url: "https://c.example", title: " " ,
    date: "not a date" }` → only `[{ title: "https://c.example", url: "https://c.example" }]`.
  - `"data null is unavailable"` (Review Focus 2) and `"401 is auth"`.
  - `"configured follows the org config"`: `createJinaSearch(…).configured?.({})` false,
    `({ apiKey: "k" })` true.
- [ ] **Step 2: Run to see them fail.** `pnpm exec vitest run plugins/jina/test/search.test.ts`
- [ ] **Step 3: Implement** `createJinaSearch` and `ctx.provide(WEB_SEARCH_EXTENSION_POINT, …)` in `setup`.
- [ ] **Step 4: Run to see them pass.**
- [ ] **Step 5: Commit** `feat(jina): provide web-search@1 through s.jina.ai`.

---

### Task 4: `web-fetch@1` provider

**Files:**
- Create: `plugins/jina/src/reader.ts`, `plugins/jina/test/reader.test.ts`
- Modify: `plugins/jina/src/index.ts` (provide it)

**Interfaces:**
- Consumes: Task 2 helpers
- Produces: `createJinaReader(endpoints: Pick<JinaEndpoints, "readerUrl">): WebFetchProvider`

Request: `POST joinUrl(readerUrl, "/")`, `Content-Type: application/json`, body
`JSON.stringify({ url })`, header `X-Return-Format: markdown`. POST rather than `GET r.jina.ai/<url>`
**(ruling)**: the target URL travels in the body unchanged, so its query string and fragment are
never re-parsed as part of Jina's own URL (Review Focus 4). Task 6 confirms Jina accepts it.

Response: `{ data: { title?, url?, content? } }` → `{ finalUrl: data.url when it is a string that
parses as an absolute URL, else the requested url; title: trimmed title when non-empty; markdown:
data.content when a string, else "" }`. `data` missing or not an object → `unavailable`
(`"Jina reader returned an unexpected response"`). An empty `content` is returned as `""` (the
kernel turns an empty page into its own error). The plugin does not re-check `finalUrl` against
private hosts: Jina fetches from its own network, and the kernel validates `finalUrl` (spec §7.1).

- [ ] **Step 1: Write the failing tests** (`test/reader.test.ts`, fake Jina):
  - `"posts the URL as JSON and asks for markdown"` (Review Focus 4): url
    `https://example.com/a?x=1&y=2#top`; `requests[0]` is `POST /`, `content-type` starts with
    `application/json`, `x-return-format === "markdown"`, `JSON.parse(body)` equals `{ url }`.
  - `"maps the page"`: fake `200 {"data":{"title":" T ","url":"https://example.com/b","content":"# Hi"}}`
    → `{ finalUrl: "https://example.com/b", title: "T", markdown: "# Hi" }`.
  - `"no data.url keeps the requested URL"` and `"content missing is an empty page"`.
  - `"422 is not_found, 451 is blocked, 429 is rate_limited"` (reader column of the table).
  - `"data null is unavailable"` (Review Focus 2).
- [ ] **Step 2: Run to see them fail.**
- [ ] **Step 3: Implement** `createJinaReader` and `ctx.provide(WEB_FETCH_EXTENSION_POINT, …)`.
- [ ] **Step 4: Run to see them pass.**
- [ ] **Step 5: Commit** `feat(jina): provide web-fetch@1 through r.jina.ai`.

---

### Task 5: Through a real kernel

**Files:**
- Create: `plugins/jina/test/kernel.http.test.ts`

Pattern: `plugins/todo/test/kernel.http.test.ts` (one in-process kernel, `startTestKernel` +
`testKernelConfig` with `extensions: [MODEL_FAKE, JINA]`, `roles: ["api", "worker"]`,
`{ resolveFrom: PLUGIN_DIR }`), plus `extensionConfig: { jina: { searchUrl: fake.url, readerUrl: fake.url } }`
as `plugins/slack/test/kernel/m7-segment1.dual.test.ts` passes deployment config. The fake routes
by method: `GET /?q=…` answers a search body, `POST /` a reader body.

- [ ] **Step 1: Write the test** `"WebSearch and WebFetch run through jina with the org's key"`:
  1. Owner, org; `PUT /api/v1/orgs/:orgId/extensions/jina` `{ enabled: true, config: { apiKey: "org-key-1" } }` → 200.
  2. `GET /api/v1/orgs/:orgId/extension-points/available` → `points` contains
     `{ point: "web-search", available: true }` and `{ point: "web-fetch", available: true }`.
  3. `createAgent(owner, orgId, { tools: [{ kind: "builtin", name: "WebSearch" }, { kind: "builtin", name: "WebFetch" }] })`, a conversation.
  4. `postMessage(…, "tool:WebSearch:" + JSON.stringify({ query: "capybara" }))`; `waitForEvent`
     `approval_requested`; `POST /api/v1/orgs/:orgId/approvals/<approvalId>/decision`
     `{ decision: "approve", scope: "always" }`; `waitForTerminal(db, conv, 1, 30_000)`.
     The `tool_result` has `isError: false`, its content starts with `Search date: ` and contains
     the fake's title and URL; the fake's search request carried `authorization: Bearer org-key-1`.
  5. Same for `tool:WebFetch:{"url":"https://example.com/page","prompt":"What is it?"}` (approve
     `always`, `waitForTerminal(…, 2, …)`): `isError: false`, content starts with
     `URL: https://example.com/page`, and the fake got `POST /` with that URL in the body. The
     answer text is whatever model-fake replies to the extraction call; do not assert it.
  6. A second org that enables `jina` without config: `extension-points/available` shows
     `web-search` `available: false` (`configured()` false).
- [ ] **Step 2: Run it.** `pnpm exec vitest run plugins/jina/test/kernel.http.test.ts` (Docker) → PASS.
  If step 2's point names come back as `web-search@1`, assert what the route returns and note it.
- [ ] **Step 3: Commit** `test(jina): run WebSearch and WebFetch through a kernel`.

---

### Task 6: Live test, docs, changeset

**Files:**
- Create: `plugins/jina/test/live/jina.live.test.ts`
- Modify: `plugins/jina/README.md`, `.changeset/jina-plugin.md` (create)
- Modify: `AGENTS.md` (Repository map is generic; add `CAPYBARA_TEST_JINA_API_KEY` to the list in
  "Live API tests")

- [ ] **Step 1: Live test**, skipped unless `CAPYBARA_TEST_JINA_API_KEY` is set
  (`describe.skipIf`), calling the real endpoints with `createJinaSearch` / `createJinaReader`:
  - search `"capybara animal"`, `maxResults: 5` → 1–5 results, each with an https `url` and a
    non-empty `title`; at least one has a `snippet`.
  - search with `allowedDomains: ["wikipedia.org"]` → every result host ends with `wikipedia.org`.
  - read `https://en.wikipedia.org/wiki/Capybara` → `markdown` contains `Capybara`, `finalUrl` is https.
  - a bad key → `WebProviderError` `auth`.
  If a live call shows a field or header named differently than Tasks 3–4 assume (the spec asks
  the builder to check against Jina's docs), fix the mapping and its unit test, and say so in the
  commit body. Run: `set -a; . ~/.capybara-test.env; set +a; pnpm exec vitest run plugins/jina/test/live`
  (never print the key).
- [ ] **Step 2: README**: what it provides, the org key (per org, from the Jina dashboard), the
  deployment URLs, that the kernel's `WebSearch` / `WebFetch` default to "ask", that an org with
  several web providers picks a default in its settings, and the live test command.
- [ ] **Step 3: Changeset** `"@capybara-hq/plugin-jina": minor` — "New plugin: web search and page
  reading for the builtin WebSearch / WebFetch tools through Jina, with a per-org API key."
- [ ] **Step 4: Verify.** `pnpm -s verify --json` → `ok: true`.
- [ ] **Step 5: Commit** `docs(jina): document the plugin and add live tests`.
