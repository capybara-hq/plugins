---
name: writing-connectors
description: 'Use when creating or changing a connector extension in this repository (provides connector@1, e.g. plugins/connector-mcp, plugins/connector-openapi): the terms connector / connector extension / connector template, no stdio MCP support, endpointSchema, the per-call open / close session lifecycle, auth() before every request and a single onUnauthorized retry, no redirect following and https only (allowInsecureLoopback), ToolError kind and the circuit breaker, connectorData and routing by the reviewed definition (ctx.spec), deterministic listTools, inspect and the install preview, onToolsChanged, onElicit and elicitation resumption, optional resources / prompts methods, what connector templates need from endpointSchema, what the kernel owns (OAuth, redaction), and tests with startFakeMcpServer / startFakeOpenApiServer / startFakeOAuthServer and live tests.'
---

# Writing connectors

A connector extension connects a kind of remote service as a "connector" in an org (a remote service instance: an MCP server, an HTTP API described by OpenAPI, and so on). The extension declares `provides: [CONNECTOR_EXTENSION_POINT]` and calls `ctx.provide(CONNECTOR_EXTENSION_POINT, connector)` in `setup`.

**Terms**:

| Term | Meaning | Example |
|---|---|---|
| connector | A remote service instance installed in an org: endpoint + auth + tool snapshot | the "Docs" MCP server |
| connector extension | An extension implementing one protocol, providing `connector@1`; deployment-level, no per-org enablement | `connector-mcp`, `connector-openapi` |
| connector template | A plugin component (`connectors/<id>.json`): references a connector extension and presets endpoint and auth (no credentials), the endpoint fields an org may edit and default policies; the org supplies credentials | the "Lark Docs" template |
| plugin | The install unit: at most one extension + connector templates + skills, possibly depending on other plugins | Lark extension + docs template + skills |

Some model-visible texts and stored fields still say "app" (the old name); keep them as they are.

For general extension authoring see `.agents/skills/writing-extensions`; for general tool rules (naming, English descriptions and errors, policy) see `.agents/skills/writing-tools`. The kernel side (OAuth, credential storage, the install preview route, drift review, the circuit breaker, redaction, resources and prompts routes, template install) is core's: [writing-connectors in core](https://github.com/capybara-hq/core/tree/main/.agents/skills/writing-connectors).

Reference implementations: `plugins/connector-mcp` (MCP over Streamable HTTP, with elicitation, prompts, resources, list_changed) and `plugins/connector-openapi` (OpenAPI 3.0 / 3.1, one tool per operation, implements `inspect` and `connectorData` routing). The contract is the SDK's `connector.ts`.

The deployment-level config of both official connectors is only `allowInsecureLoopback` (default `false`; development / testing only, allows plain http to `127.0.0.1` / `localhost` / `[::1]`), e.g. `CAPYBARA_EXTENSION_CONFIG='{"connector-mcp":{"allowInsecureLoopback":true}}'`.

**stdio MCP is not supported**: connectors only reach remote services (MCP over Streamable HTTP). The kernel runs as multiple replicas and does not spawn local processes for an org, so never write a connector that spawns child processes; wrap a local MCP server as an HTTP endpoint first.

## Contract

```ts
interface Connector {
  kind: string;                 // stored with the connector, e.g. "mcp", "openapi"
  endpointSchema: ZodTypeAny;   // validates the connector endpoint (called by the kernel on install / preview)
  open(args: ConnectorOpenArgs): Promise<ConnectorSession>;
  inspect?(args: { endpoint; signal }): Promise<{ authHints: AuthHint[]; operations?: ConnectorOperation[] }>;
}
interface ConnectorOpenArgs {
  endpoint: unknown;                        // already validated against endpointSchema
  auth(): Promise<AuthInjection>;           // { headers, query? }
  onUnauthorized(): Promise<void>;
  signal: AbortSignal;
  onToolsChanged?(): void;                  // optional
  onElicit?(req: ElicitationRequest): Promise<ElicitationResponse>;   // optional
}
interface ConnectorSession {
  listTools(): Promise<ToolSpec[]>;
  callTool(name, input, signal, ctx?: { spec: ToolSpec }): Promise<ToolResult>;
  listResources?(); readResource?(uri);     // optional
  listPrompts?(); getPrompt?(name, args);   // optional
  close(): Promise<void>;
}
```

Null-check every optional callback: an older kernel does not provide them.

## `endpointSchema`

- The kernel validates `endpoint` with it on install / preview / create (failure -> 400 `validation_failed`); `open` gets the validated value (call `schema.parse` once for the type).
- URLs accept https only; only with `allowInsecureLoopback` are the three exact loopback http hosts allowed (`localhost.evil.com` does not count). Validation messages are English and state the rule.
- The endpoint is visible to org members and **must not contain credentials**: fixed headers exclude credential headers such as `Authorization` / `Cookie` (credentials go through the auth settings, stored encrypted). The kernel also rejects credential-like header names, query names (`key`, `token`, `access_token`, …) and URL userinfo at install, checking every top-level `url` / `*Url` string field.
- Large fields (such as OpenAPI's `specText`, <= 2 MB): name them `text` / `*Text`; the kernel echoes only their size and hash, and raises the install and preview body limit to 6 MiB.
- **Connector templates** reference paths in your schema (`editableEndpoint`): the kernel finds them by walking object fields, records and union / intersection branches (stripping optional / default wrappers), **never array elements**. Put fields an org may need to change on object paths and keep field names stable: renaming breaks published templates. Template format: `.agents/skills/writing-plugins`.

## Session lifecycle: open per call

For every `listTools` (install, refresh, drift check), every tool call and every resource or prompt read, the kernel does `open` -> use -> `close`. The connector **caches no connections and holds no in-process session** (the next call may land on another replica). `close` returns quickly (the kernel waits at most 5 seconds; an error only logs a warn). Respect `signal` (both `open`'s and `callTool`'s); the timeout is the kernel's `tools.timeoutMs`, so set any SDK request timeout long enough not to fire first.

## Rules for outbound requests

- **Call `auth()` before every request** and merge its `headers` / `query`; never fetch it once per session (credentials refresh). Credentials appear only at that moment: never store, log or echo them.
- **On 401, call `onUnauthorized()` once and retry once with a fresh `auth()`**; still 401 -> `ToolError("Authentication failed for this app; ask the user to reconnect it.")`. No loops, and no retries of other errors inside the extension: retries and the circuit breaker are the kernel's.
- **Never follow redirects** (`fetch(…, { redirect: "manual" })`, any 3xx is an error): following would carry the body and the injected credentials to another origin. Fetching a remote description (OpenAPI `specUrl`) carries no credentials and follows no redirects either.
- Reject any non-https outbound address (loopback excepted), including server addresses declared in documents.
- Remote content is untrusted. The kernel sanitizes remote `inputSchema`s before validating arguments; the connector limits response size and read time itself (openapi: document 2 MB / 30 seconds, response body 5 MB).

## `ToolError`, `kind` and the circuit breaker

- `ToolError(message)` goes to the model **verbatim**: English and actionable (`tool-error-actionable` of `pnpm check`). A failed preview / install shows the same message (redacted) to the admin in 502 `connector.connect_failed`, so make it understandable to admins too.
- `new ToolError(message, { kind: "unavailable" })` = **remote unavailable** (cannot connect, HTTP 5xx): counts toward the kernel's circuit breaker. The default `kind: "error"` (bad arguments, business errors, still 401 after the retry, redirects, 4xx, JSON-RPC business errors) = remote reachable, and like an `isError` result resets the count.
- The breaker (in the kernel) counts only timeouts, transport errors (non-`ToolError` exceptions) and `kind: "unavailable"`. Just throw / return honestly.
- Any other exception: the model sees only `Tool <key> failed (<ErrorName>)…`. For an upstream HTTP error give the model the status code; truncate the body into a warn log.
- `isError: true` means "the call succeeded but the content is an error" (MCP's `isError`, an OpenAPI non-2xx body).

## `listTools`, `connectorData` and routing by the reviewed definition

- Keep `annotations` (the kernel derives the default policy: `readOnlyHint` -> allow, else ask); without a description fall back to title / name and warn. Pass a remote human title as `ToolSpec.title` (connector-mcp: the MCP `title`, else `annotations.title`, trimmed, cut to 80) and optionally `keyArgs` (up to 3 input names): display only, outside the definition fingerprint, an invalid one is dropped from the snapshot (see "Display metadata" in `.agents/skills/writing-tools`).
- Keys are `<connectorSlug>__<tool>` matching `^[a-zA-Z0-9_-]{1,64}$`; a key that doesn't fit is disabled by the kernel with the reason, never truncated. Normalize remote names to a reasonable length and keep them unique within one connector (openapi replaces illegal characters in operationId with underscores and cuts to 40; duplicates are reported in the preview).
- **`ToolSpec.connectorData`** (security): the routing information a call needs goes in this opaque JSON field (OpenAPI: method, path template, parameter locations / styles, request media type, the resolved server). The kernel stores it, counts it in the definition fingerprint (a change goes to admin review) and **never sends it to the model**.
- On a call the kernel passes the tool's **reviewed** definition as `ctx.spec` (4th argument of `callTool`). A remote description can be changed (rug-pull), so route by `ctx.spec` and **never re-read the remote description**; when `ctx` is missing (older kernel), raise an error telling the admin to refresh. A protocol where the remote routes by name (MCP) may ignore `ctx`.
- The kernel re-runs `listTools` periodically, on `onToolsChanged` and on admin refresh, and sends new or changed tools to review (unusable until approved). So `listTools` output must be **deterministic**: the same remote description gives the same spec every time (stable field order, no timestamps or random values), or it triggers review again and again.
- **Known limitation**: background checks of a personal-credential connector rotate among the credentials of the most recently active members, so a service whose tool list depends on the user makes tools flip between "gone" and "pending review". For such services, use an org credential or make the server return the same list to everyone (say so in the README).

## `inspect` and the install preview

`inspect({ endpoint, signal })` reads the endpoint's description without credentials and returns `authHints` (the auth methods the remote declares, mapped to the kernel's shapes: `bearer` / `basic` / `api_key{in,name}` / `oauth_client{tokenUrl,scopes}` / `oauth_code{authorizationUrl,tokenUrl,scopes}`, with a `scheme` name and optional `description`; only methods the kernel supports) and optional `operations` (`id` used for selection in the endpoint, `method` upper case, `path`, `summary?`). On failure throw an English `ToolError`. The admin install wizard pre-fills from it, and the preview also runs `listTools` when credentials are at hand. A connector that needs no prefill (MCP) doesn't implement `inspect`.

## `onToolsChanged`

When the remote reports a changed tool list (MCP `notifications/tools/list_changed`), call `args.onToolsChanged?.()`: don't wait on it, it may be called many times, and it never affects the current call. The kernel enqueues one deduplicated drift check. The connector never re-fetches the list itself.

## `onElicit`: the remote asks the user mid-call

For MCP `elicitation/create` (form and URL modes), call `args.onElicit?.(request)` and return its `ElicitationResponse` to the remote unchanged. **When the kernel did not provide `onElicit`, don't declare the elicitation capability** to the remote. URL mode may also arrive as error `-32042` (URL elicitation required): pass each to `onElicit`, and once all are `accept`ed retry the call once.

**The connector never waits for the user and never caches answers.** The kernel cannot hold a remote call while a person answers, so it aborts the `callTool` signal and makes `onElicit` reject; let that error end the call as is. After the answer the kernel **re-issues the call with the same input**, and when the remote raises the **same** elicitation again `onElicit` answers at once. Accepted limitations: if the remote doesn't ask again or changes the schema the answer goes unused (at most 3 rounds); side effects before the elicitation happen again; a form beyond the supported subset is declined with an English note in the result.

## Optional: resources and prompts

- With `listResources` / `readResource`, the kernel adds `<slug>__list_resources` / `<slug>__read_resource` tools (read-only, default allow) and `@` references in the web input box, read with the sender's credentials. With `listPrompts` / `getPrompt`, the web input box gets `/<connector>:<prompt name>` commands. Both are started by the person with their own credentials and skip tool policy.
- When `getPrompt` or a resource read fails, throw an English `ToolError` without credentials.

## What the kernel owns

- **OAuth and credentials**: the Bearer from `auth()` is refreshed by the kernel before expiry; `onUnauthorized()` forces a refresh under a cross-replica lock; a rejected refresh deletes the credential and the call gets "connection required". Authorization-code (with MCP discovery and dynamic client registration) and client-credentials flows are entirely the kernel's. The connector only calls `auth()` / `onUnauthorized()`.
- **Redaction**: before writing events and archives, the kernel redacts results and errors with the credential values injected for that call, and logs are redacted too. Still, **never echo request headers**, never put a credentialed URL into an error, never `JSON.stringify` a whole request. Tests use fixtures that echo credentials (`echoKey`, `intercept`) to prove nothing leaks.

## Testing

All from `@capybara-hq/testing` (a devDependency):

- `startFakeMcpServer({ tools, resources?, prompts?, sessions?, requireBearer?, verifyBearer?, protectedResource?, unauthorizedTimes?, onCall?, intercept?, sseResponses? })`: simulates slowness, errors, 401, echoed credentials (`calls[].headers`), oversized output, redirects; `tools` is re-read on every request, so changing it simulates drift; with `sseResponses: true` a handler can call `ctx.notifyToolsChanged()` mid-call; with `sessions: true` a handler can call `ctx.elicit(params)` (recorded in `server.elicitations`).
- `startFakeOpenApiServer({ apiKey?, apiKeyIn?, echoKey?, specRedirect?, spec? })`: `/openapi.json` serves the pet CRUD document `defaultFakeOpenApiSpec`, `/v1/*` implements it (API key check, 404 / 500 / 302, plain text and binary responses); `setSpec` simulates a document update.
- `startFakeOAuthServer({ dcr?, metadata?, accessTokenTtl?, clients?, tokenDelayMs? })`: auto-approving authorization endpoint, PKCE, refresh rotation, client_credentials, DCR switch, `revokeAccessTokens` / `revokeRefreshTokens`; combine with `startFakeMcpServer({ verifyBearer: (t) => as.verify(t), protectedResource: { authorizationServers: [as.issuer], advertise: "header" | "well-known" } })`; the kernel then needs `tools.oauthAllowInsecureLoopback: true` and `http.publicUrl`.

Test checklist (follow `plugins/connector-mcp/test/` and `plugins/connector-openapi/test/`): endpoint validation (non-https, credential headers), `auth()` before every request, 401 retried once and only once, redirects rejected, `ToolError` `kind`, no credentials in errors, no leftover connections after `close`, `signal` abort; with `connectorData`, "the call still goes by `ctx.spec` after the description changes". Through a real kernel: `plugins/connector-mcp/test/kernel/mcp-e2e.test.ts`, `plugins/connector-openapi/test/kernel/openapi-e2e.test.ts` (`startTestKernel` + model-fake); `plugins/connector-mcp/test/claude-template.test.ts` checks a translated Claude Code bearer template against the real connector.

Live acceptance: `plugins/connector-mcp/test/live/m3.live.test.ts` (DeepWiki MCP, GitHub MCP) and `plugins/connector-openapi/test/live/m3.live.test.ts` (Petstore OpenAPI) run only with `CAPYBARA_TEST_LIVE_TOOLS=1` (a plain test run never touches the network); GitHub also needs `CAPYBARA_TEST_GITHUB_MCP_TOKEN` and `CAPYBARA_TEST_GITHUB_REPO` (owner/name) and opens an issue it closes in `finally`. After changing outbound requests or protocol handling, run `CAPYBARA_TEST_LIVE_TOOLS=1 pnpm exec vitest run plugins/connector-mcp/test/live plugins/connector-openapi/test/live -t live` from the repository root. Keep keys in an env file outside the repository and never print them.
