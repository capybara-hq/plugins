---
name: writing-extensions
description: 'Use when creating or changing an extension under plugins/* in this repository: defineExtension manifest fields, the permission manifest and what triggers re-approval, the trust model (in-process, full trust), ctx.extensionPoints and orgScoped, deployment-level / org-level / channel-connection config and secret() fields, each ctx item, patterns forbidden under multiple replicas (timers, module-level state), the no-restart lifecycle as an author sees it (dispose, ctx.signal, drain, expand-only migrations), hooks (ctx.hooks, observe vs policy, permissions.policyHooks, fail-closed, usage.report idempotent by eventId), packing with capybara-plugin, publishing to npm with provenance, and dual-replica and real-kernel tests with @capybara-hq/testing. For UI see writing-extension-ui; for plugin bundles (plugin.json, skills, connector templates, dependencies) see writing-plugins.'
---

# Writing extensions

Terms: an **extension** is the in-process code (`defineExtension`, `ctx`, the permission manifest, approval); it **provides** or **consumes** **extension points** (versioned contracts such as `channel@1`). A **plugin** is the install and distribution unit (a bundle that may hold one extension, connector templates and skills; see `.agents/skills/writing-plugins`). Each package under `plugins/*` (`@capybara-hq/plugin-<name>`) holds one extension of the same name, so the extension's name is its plugin's name.

This skill is the author half. The kernel half (the extension host, reconcile, permission review and approval, name ownership, bootstrap plugins, the hook dispatcher) lives in core: [writing-extensions in core](https://github.com/capybara-hq/core/tree/main/.agents/skills/writing-extensions). Core packages (`@capybara-hq/plugin-sdk`, `@capybara-hq/testing`, `@capybara-hq/plugin-tools`, `@capybara-hq/plugin-model-fake`) come from npm. A contract change (SDK, kernel) needs a PR in `capybara-hq/core` first.

Reference implementation: `plugins/example-counter` (db transaction + idempotent queue job + provide; copy it to get started). See also `.agents/skills/writing-model-providers`, `.agents/skills/writing-tools` (`ctx.tools`, reference `plugins/todo`), `.agents/skills/writing-connectors`, `.agents/skills/writing-channels` (`plugins/slack`, `plugins/lark`), `.agents/skills/writing-extension-ui` (`plugins/todo`, `plugins/example-board`), `.agents/skills/writing-sandbox-providers`, `.agents/skills/writing-object-store-providers`.

## Hard constraints (read this first)

| Rule | Rule id (`pnpm check` = `capybara-plugin check`) |
|---|---|
| May only import `@capybara-hq/plugin-sdk`, `zod` and other third-party npm packages; **may not** import `@capybara-hq/kernel` or files outside the plugin directory. Tests may use the devDependencies `@capybara-hq/testing` and `@capybara-hq/plugin-model-fake` | `plugin-imports-kernel`, `plugin-imports-outside` |
| Must not use `setTimeout` / `setInterval` / `setImmediate` / `node:timers` | `plugin-timer` |
| No top-level `let` / `var` / `new Map/Set/WeakMap/WeakSet` / array literals at module level | `plugin-module-state` |
| `ctx.secrets` / `ctx.storage` / `ctx.http.route` / `ctx.tools.register` / `ctx.extensionPoints` / `ctx.ui.view` / `ctx.ui.action` / `ctx.hooks.on` used in `setup(ctx)` must be declared in the manifest; `ctx.models` is not provided yet | `perm-secrets`, `perm-storage`, `perm-http`, `perm-tools`, `perm-extension-point`, `perm-ui`, `perm-hooks`, `perm-reserved` |
| `ctx.kv` writes must carry `ttlSeconds` (enforced at the type level) | `pnpm typecheck` |
| Queue names and job ids contain no `:` (a BullMQ limit) | Runtime: `ctx.queue.define` / `add` throw `TypeError` |

### Why timers and module-level state are banned

Production runs multiple replicas, and the writer and the reader may not be in the same process. An in-process Map / timer exists only in the process that created it: other replicas cannot read it or stop it. A single-process dev setup cannot expose this, so avoid it while writing the code.

| What you want | Not this | This |
|---|---|---|
| Share state across requests | A module-level `Map` | Durable data in `ctx.db`; temporary / expiring state in `ctx.kv` (with TTL) |
| Delayed / periodic work | `setTimeout` / `setInterval` | `ctx.queue.add(name, data, { delayMs })` |
| An abortable wait within a single request (backoff, streaming interval, timeout) | A Promise wrapping `setTimeout` | `AbortSignal.timeout(ms)`, listened to together with the caller's `signal` |
| Notify other replicas | In-process events / callback tables | `ctx.bus.publish` / `subscribe` |
| "Whoever opens closes" pairing | The opener holds a handle in memory | The opener expires itself (TTL) + the closer broadcasts |

`AbortSignal.timeout(ms)` is only for waits **within this request** that end when the request ends. Any need of the form "do something after a while / at intervals", however short, goes through `ctx.queue` (`delayMs`), because when the time comes another replica may be the one handling it.

Only truly read-only constants (regex tables, fixed lookup tables) are exempt: write `// capybara:allow-module-state <reason>` at the **end of the same line** as the declaration or on the **line immediately above**; the reason cannot be empty.

## Trust model

- **An extension runs in the kernel process with full trust**, and its migration SQL runs over the kernel's database connection. So only an enterprise admin installs an extension into a deployment; untrusted integrations are built as external apps calling the kernel over HTTP.
- **The permission manifest and approval are governance, not a sandbox**: what the manifest really blocks is the resources the kernel holds (`ctx.secrets`, `ctx.storage`, tools, routes, extension point consumption, UI, hooks); the rest (network domains) is transparency and audit.
- Review looks only at the static manifest and migration SQL and does not execute extension code. Migration statements that write outside the extension's own schema, change permissions / roles, create functions / triggers or control transactions, destructive statements and `DO` blocks are shown to the deployer as sensitive warnings; **a change in those warnings also needs re-approval**.
- **Do not pack untrusted source**: `capybara-plugin pack` bundles with esbuild and then `import`s the bundled entry to generate the static manifest, so the module's top-level code runs on your machine.

## Manifest (defineExtension)

```ts
import { defineExtension } from "@capybara-hq/plugin-sdk";
import { z } from "zod";

export default defineExtension({
  name: "my-plugin",          // ^[a-z][a-z0-9-]{1,40}$, the name kernel is reserved; the PG schema is plugin_my_plugin
  version: "0.1.0",           // semver, equal to package.json and plugin.json
  sdk: "^0.1.0-rc.0",         // compatible SDK version range (a plain ^0.1.0 refuses rc kernels)
  provides: ["counter@1"],    // extension points provided, of the form name@major, must be registered in the SDK
  requires: [],               // extension points of other extensions depended on (optional; cannot duplicate provides)
  optional: [],               // optional dependencies: loads even when the provider is missing, list is empty on use
  permissions: {              // permission manifest: what is not declared is forbidden, see below
    http: [{ method: "POST", path: "/inc" }],
  },
  config: {
    deployment: z.object({ step: z.number().int().positive().default(1) }), // deployment level
    // org: z.object({...}),                                                // org level
  },
  migrations: "../migrations", // relative to the entry file's directory; under both src/ and dist/ it points to the plugin root migrations/
  setup(ctx) { /* see below */ },
  // dispose(ctx) { /* optional: close resources you built outside ctx */ },
});
```

`defineExtension` validates the manifest at load time and throws if it is invalid.

**Permission manifest (`permissions`)**: the kernel builds `ctx` from the manifest; access to a platform API that is not declared throws `ExtensionPermissionError` (the message names the manifest item) and is audited. Granted without declaration: `kv`, `lock`, `bus`, `queue`, `log`, `db`, `config`, `provide`.

| Item | Form | Description |
|---|---|---|
| `secrets` | `secrets: true` | Required to use `ctx.secrets` |
| `http` | `[{ method, path, public? }]` | Every `ctx.http.route` must be listed; `method` GET / POST / PUT / DELETE, `path` starts with `/`; `public: true` is highlighted at review. **For now `public` is only a declaration**: extension routes bypass kernel authentication either way (see "Extension routes") |
| `tools` | `["write"]` | The local name of each `ctx.tools.register` tool (without the `<extension name>__` prefix); tools see conversation content and are highlighted |
| `network` | `["api.example.com"]` | Fixed domains accessed; display only, not enforced; omit when endpoints come from config; no wildcards |
| `ui` | `{ views: ["tasks"], embeds: ["board"] }` | One-to-one with the manifest's top-level `ui`: views do not block loading, embeds need approval and are sensitive. See `.agents/skills/writing-extension-ui` |
| `storage` | `storage: true` | Required to use `ctx.storage`; without an `object-store@1` provider in the deployment the extension does not load (pending, dependency). See "When to use each ctx item" |
| `hooks` | `["model.request", "usage.report"]` | Mount points of `ctx.hooks.on`; sensitive at review. See "Hooks" |
| `policyHooks` | `["model.request"]` | Mount points with `mode: "policy"` hooks: only `model.request` / `tool.preExecute`, each also listed in `hooks` |
| `models` | — | Reserved (`ctx.models` is not provided yet; using it reports `perm-reserved`) |

**Extension point consumption (`requires` / `optional`)**: `ctx.extensionPoints.get / list(ref)` only takes refs declared in `requires` / `optional` (or the extension's own `provides`); any other ref reports `perm-extension-point`. Only pass-through extension points (`channel`, `directory`, `identity-source` and so on) can be taken; brokered ones (model providers, connectors, sandboxes, secret stores, object stores) are used only through platform APIs, and taking one directly throws. If a `requires` provider is missing, this extension does not load; if an `optional` is missing it loads, `list` is empty and `get` throws `ExtensionPointUnavailableError`. For a multi-select extension point, `get` takes the provider name.

**`orgScoped` extension points**: for an extension point registered as `orgScoped` (`channel`, `directory`; see the registry in the SDK's `extension-point.ts`), availability depends on whether the org enabled the provider. `identity-source` is not org-scoped (login is deployment-level, enabled by the kernel config `auth.loginSources`). An org can only enable your extension when every `orgScoped` extension point it `requires` has an enabled provider in that org. Without `orgId` the call is the deployment-level view (synchronous, unfiltered); with `{ orgId }` it is async and filtered by that org's enablement (queried each time):

```ts
// Deployment level (in setup): synchronous
const providers = ctx.extensionPoints.list<Directory>("directory@1");
// One org's view (at the call site): async; rejects with ExtensionPointUnavailableError when that org has not enabled the provider
const dir = await ctx.extensionPoints.get<Directory>("directory@1", "lark", { orgId });
const enabled = await ctx.extensionPoints.list<Directory>("directory@1", { orgId });
```

**Call context principle**: `setup(ctx)` receives the **deployment-level** context, which cannot see any org, account or conversation. The kernel passes the context of each call in the call parameters, decided by the extension point: tool execution carries org, account, agent and conversation (`ToolCallContext`); a channel carries the `connectionId` and that connection's config; a directory carries that org's config; login carries the deployment config and the authentication request; a queue job has only what you put in its data (usually `orgId`; the kernel checks the extension is enabled in that org). So **never keep org / conversation / identity in module variables or the ctx closure between calls**; take them from the call parameters, and keep cross-call data in your own `ctx.db`.

**Static check (`perm-*` of `pnpm check`)**: scans the `ctx` parameter of `setup` (including local aliases and a ctx passed by position to functions **in the same file**) and compares `ctx.secrets`, `ctx.http.route(method, path)`, `ctx.tools.register({ name })`, `ctx.extensionPoints.get|list(ref)`, `ctx.ui.view|action(id)`, `ctx.hooks.on(mount)`, `ctx.storage` and `ctx.models` with the manifest. Route paths, tool names, refs, UI ids and hook mounts must be string literals (or a const in the same file); a dynamic value reports "cannot statically confirm"; for one truly known only at runtime (and reviewed), write `// capybara:allow-dynamic-permission <reason>` at the end of that line or on the line above (reason required; it only waives "cannot statically confirm"). The check cannot follow ctx into another file (the runtime `ExtensionPermissionError` is the backstop), so keep the code that uses platform APIs in the same file as `setup`.

**Approval as an author sees it**: the deployment records an approved permission snapshot (the items above, provides / requires / optional, config fields, the tables created by migrations, the migration warnings digest). A new extension, or an upgrade with **any item beyond the snapshot**, does not load until an enterprise admin approves (extensions that `requires` it wait too); a shrunk or equal set loads directly. Per-entry comparison: a route turning from `public` to non-public or a config field from secret to ordinary is a new entry too. So **every extra item you add in a release makes the deployer stop and approve**; do not declare extra items casually. An unapproved extension's migrations do not run. Development and tests use the kernel config `extensionPermissions.autoApprove: true` (the dual-replica harness sets it); never in production. Extensions that provide `sandbox@1`, `object-store@1`, `channel@1`, `directory@1` or `identity-source@1` are shown as sensitive at review.

**`setup` must return**: setup runs serially in dependency order and is time-limited for installed extensions (`extensionHost.reloadSetupTimeoutSeconds`, default 60 s; a timeout is `setup_failed` and retried on the next reconcile); migrations are limited by `extensionHost.migrationTimeoutSeconds` (default 300 s). Extensions declared in the startup config are not time-limited, so a setup that never resolves hangs the kernel start. When you need to wait for an external dependency, set your own timeout in setup and throw, or move the wait into a queue job.

**Revocation and reloading (no restart)**: an instance can be revoked while the process runs (disabled, uninstalled, replaced on upgrade, or a provider it `requires` / `optional`s got a new instance). The kernel keeps a ledger per instance: every registration made through ctx (tools, routes, queue workers, bus subscriptions, `ctx.lock` leases, UI views / actions, hooks, `provide`) is revoked for you, so **the extension does not unsubscribe or release anything itself**. Order: stop accepting new calls -> wait for in-flight tool calls, provider calls and queue jobs (at most `extensionHost.drainSeconds`, default 30 s; unfinished tool calls become an English error result for the model, unfinished queue jobs **run again** on the new instance, so handlers must be idempotent) -> abort `ctx.signal` -> revoke the ledger -> call the optional `dispose(ctx)` (at most `extensionHost.disposeTimeoutSeconds`, default 10 s). So:

- Long-running work you start yourself (polling, long connections) listens to `ctx.signal` and wraps up; clients or pools you `new` yourself are closed in `dispose`; never register through ctx inside `dispose`. When setup throws, `dispose` is not called.
- Provider calls the kernel makes (connector sessions, sandbox calls, every model call and stream) count as in flight too and are aborted at the drain limit through the `AbortSignal` in their parameters: honor it.
- After revocation the `req.signal` of in-progress requests on your routes aborts and `/plugins/<name>/*` returns 503 `extension.unavailable`.
- The old module stays in memory until the process restarts, so **module-level state is not reset**, yet another reason it is banned.
- **Dependents are reloaded** when a provider's instance is replaced, and unloaded when a required provider is gone. So **do not cache another extension's extension point implementation in setup**; look it up at the call site.

The `sdk` range is validated by the kernel against the SDK package version. A plain `^0.1.0` does not accept `0.1.0-rc.N`, so ranges are written `^0.1.0-rc.0` while the SDK is an rc. In 0.x a caret only matches the same minor: **when the SDK bumps minor (such as 0.2.0), every extension's `sdk` range must change in sync**, or the kernel refuses to load it.

## Two-level config

- **Deployment level** (`config.deployment`): operators supply it under `extensionConfig.<extension name>` in the kernel config (JSON through `CAPYBARA_EXTENSION_CONFIG`, or per field with `CAPYBARA_EXTENSION_CONFIG__<EXTENSION NAME UPPER-CASED, - AS _>__<FIELD>`, e.g. `CAPYBARA_EXTENSION_CONFIG__EXAMPLE_COUNTER__POOL_SIZE=3` for `poolSize` of `example-counter`), or an enterprise admin fills it in the admin console (stored in PG; precedence env > file / Nacos > PG > schema default, per field). `ctx.config` is the validated value typed `unknown`: `parse` it once with the same schema in `setup` to get the type. Values of `secret()` fields are added to the log redaction set, but redaction is only a backstop: **never write secrets into logs**.
  - **Invalid = pending configuration, not a startup failure**: when the deployment config lacks a required field or is invalid, the extension does not load (pending configuration) and the kernel starts as usual; once configured it loads without a restart. Dependents wait with it.
  - **`hot` fields**: a field marked `.meta({ hot: true })` is replaced in place on save; `ctx.config` is a getter, so **read hot fields at the point of use**, never copy them into a closure in setup. A change to a non-hot field reloads the instance (new setup, drain, see above).
- **Org level** (`config.org`): each org's own enablement and config, set by the org admin through the kernel API and validated against your schema.
- **Channel connection config** (`connectionSchema` of `channel@1`) is a third kind: an org can create several channel connections, each with its own config (bot credentials); the kernel passes the validated value as `config` to `verify` / `connect` / `send`.
- Secrets the extension produces itself while running (an OAuth token) go through `ctx.secrets`, never ordinary config. When all credentials come through config, the extension needs no `permissions.secrets` (Slack and Lark declare none).
- Which level: what only the deployer decides and the whole deployment shares (login client id / secret, platform addresses) is deployment level; what each org has (directory credentials) is org level; what each bot has is the channel connection config.
- **When an extension point's org-level fields are optional** (one extension provides several extension points and an org uses only some), use the "is it configured" hook that extension point provides (e.g. a pure `Directory.configured(orgConfig)`) instead of returning empty results at call time (see `.agents/skills/writing-channels`).

### `secret()` fields

- Mark sensitive fields with `secret(schema)` (`import { secret } from "@capybara-hq/plugin-sdk"`). Leaves whose `meta.secret` is true are secret fields by dot path (such as `webhook.token`); marking an object `secret` covers all its leaves.
- **Only object paths are supported**: `secret()` may only sit on nodes reachable from the root through object fields (and `default` / `prefault` / `optional` / `nullable` / `readonly` / `catch` wrappers). A `secret()` inside a union / intersection / transform / pipe / lazy / array element / record value / tuple makes the **extension fail to load**, naming the path. Mark the enclosing object (or the whole array field) `secret` instead.
- The kernel stores each secret field encrypted, never echoes it (only "set"), and on update keeps an omitted secret field, clears it on `null`. The merged object is validated again against the schema.
- **When upgrading, changes to the org schema must accept old stored values** (new fields get a default or are optional): a stored config that no longer satisfies the schema fails on read until the org admin saves it again.

## When to use each ctx item

| Item | Purpose | Notes |
|---|---|---|
| `ctx.kv` | **Temporary, expiring** state: rate-limit counters, short caches, idempotency keys | `set` / `incr` must carry `{ ttlSeconds }`; `incr` adds only 1, there is no `incrBy`. **No durable data in kv** (business counters, accounting): it is gone when the TTL is up |
| `ctx.db` | Durable data | Kysely, already on this extension's schema; table names **without** a schema prefix; tables come from `migrations/` (`.agents/skills/writing-migrations`). Raw `` sql`...`.execute(ctx.db) `` does not go through `withSchema` and lands on `public`: use the query builder, or write `plugin_<name>.<table>` in the SQL |
| `ctx.queue` | Delayed / asynchronous / periodic jobs | `define(name, handler)` in `setup`; `add(name, data, { delayMs, jobId })`; a job may run on any replica, delivery is **at-least-once** (retried, at most 3 times), so handlers are idempotent; names and jobId contain no `:` |
| `ctx.lock` | Mutual exclusion | `acquire(key, { ttlMs })` returns a lease or `null`; long jobs `renew()`, and `release()` when done |
| `ctx.bus` | Cross-replica broadcast | `publish` / `subscribe` (returns a cancel function); messages can be lost, so never the only end signal |
| `ctx.http.route` | External interface | Mounted at `/plugins/<name><path>`; see "Extension routes"; bypasses kernel authentication |
| `ctx.provide` | Expose an extension point implementation | Must match `provides` |
| `ctx.tools` | Tools for agents | `register(spec, handler)` only in `setup`; model-visible name `<extension name>__<spec.name>`; **only available in orgs that enabled this extension**. See `.agents/skills/writing-tools`, reference `plugins/todo` |
| `ctx.ui` | Conversation-page panels / sections / inline cards, file previewers, org pages under "Extensions" | `view` / `action` (only in `setup`; honor `signal`, 5 s timeout), `invalidate` (across replicas), `verifyEmbedToken`. See `.agents/skills/writing-extension-ui` |
| `ctx.storage` | Files, large objects (isolated per org) | Needs `permissions.storage`; every method's first parameter is `orgId` (a UUID); keys land under `plugins/<plugin name>/<orgId>/`, invisible to other extensions and the kernel; a key must not be empty, start with `/`, have `.` / `..` segments, `\`, control characters or `${`, and is at most 1024 bytes with the prefix, else `StorageKeyError`; presigned `ttlSeconds` is clamped to 1..604800; `presignPut` returns `{ method, url, headers, fields? }` (send a PUT or a POST form by `method`; the store limits the size); `presignGet` for downloads (user-uploaded content `inline` only for images / PDF); the kernel purges a deleted org's objects. See `.agents/skills/writing-object-store-providers` |
| `ctx.secrets` | Store and fetch secrets per org | Stored encrypted |
| `ctx.config` / `ctx.log` | Deployment config / logs | `ctx.config` is a getter (read hot fields at the point of use); no secrets in logs |

### Brokered and pass-through providers

- **Connectors (`connector@1`)**: `ctx.provide(CONNECTOR_EXTENSION_POINT, connector)`; deployment-level, the kernel manages tool snapshots, credentials and approval. Open a session per use and close it; call `auth()` before every outbound request; on 401 retry once after `onUnauthorized()`; never follow redirects; no credentials in errors or logs. See `.agents/skills/writing-connectors` (`plugins/connector-mcp`, `plugins/connector-openapi`).
- **Sandboxes and object storage (`sandbox@1` / `object-store@1`)**: single-select, brokered; a deployment installs one provider, other extensions cannot `requires` them. A provider implements only the primitives; lifecycle, locks, prefix isolation and cleanup are the kernel's. See `.agents/skills/writing-sandbox-providers` (`plugins/sandbox-docker`, `plugins/sandbox-e2b`) and `.agents/skills/writing-object-store-providers` (`plugins/object-store-s3`).
- **Channels, login, directory (`channel@1` / `identity-source@1` / `directory@1`)**: an IM extension usually provides all three. Long connections and leader election, inbound dedupe and durable queueing, outbound redelivery and card-action authorization are the kernel's; the extension only converts protocols. The identity key `<plugin name>:<tenant id>` + platform user id must agree in all three; acknowledge only after `onEvent` resolves; escape model text against @everyone; a directory that cannot be listed completely must throw. See `.agents/skills/writing-channels` (`plugins/slack`, `plugins/lark`).

### Extension routes (`ctx.http.route`)

`ctx.http.route(method, path, (req: Request) => Promise<Response>)`; extensions do not depend on Nest.

- **Path syntax is Fastify's** (find-my-way), relative to the extension prefix: `route("GET", "/items/:id", …)` matches `/plugins/<name>/items/42`; `*` works; matching ignores the query string. Trailing slashes matter (`/count` and `/count/` differ).
- **The handler gets only a Web `Request`, no parsed parameters**: read `new URL(req.url).pathname` / `searchParams` yourself.
- **The body is raw bytes** (no JSON / form parsing; webhook signatures can use them directly); GET / HEAD carry no body. **Body limit 1 MiB**: beyond it the kernel answers 413 `payload_too_large` and the handler is never reached.
- **HEAD is treated as GET** when there is no HEAD route (`req.method` stays `"HEAD"`, no body is returned).
- Unmatched -> 404 `not_found`; the handler throws -> 500 `internal` (logged, not echoed).
- **Routes bypass kernel authentication**: no auth guard, no CSRF check, no caller identity. An externally exposed webhook must verify signatures itself. The kernel session cookies (`cap_at` / `cap_rt`) are stripped before forwarding.
- Response status and headers (including several `set-cookie`) pass through; the body may stream.
- `req.signal` aborts when the client disconnects early, on revocation and **on shutdown** (all in-progress requests abort together): a long connection (SSE) unsubscribes and ends on it; put work that must finish into a queue.
- Embed routes live under `/ui/` and are reached through the web app's `/plugin-ui/<plugin>/...` proxy; see `.agents/skills/writing-extension-ui`.

### Hooks (`ctx.hooks`)

`ctx.hooks.on(mount, handler, { mode })`, only during `setup`, on mounts declared in `permissions.hooks` (and, for `mode: "policy"`, in `permissions.policyHooks`). Hooks observe or deny; they never rewrite a request or a result. They fire only for orgs that enabled the extension, in chat and sub-agent conversations, never in eval replays (except `usage.report`, below). Payloads are deep-frozen copies.

- **Registration.** The mounts are `model.request`, `model.response`, `tool.preExecute`, `tool.postExecute` and `usage.report` (`HOOKS_AVAILABLE`). `ctx.hooks.on` throws after `setup`, for an unavailable mount, a non-function handler, a `mode` other than `"observe"` / `"policy"`, or `mode: "policy"` outside `model.request` / `tool.preExecute`. An undeclared mount or policy hook throws `ExtensionPermissionError` and reports `perm-hooks`. Hooks are sensitive at review.
- **Policy hooks** (`model.request`, `tool.preExecute`) run serially by extension name (registration order within one) before the call; `{ deny: reason }`, an error or a timeout (`hooks.timeoutMs`, which limits every hook call) blocks it and stops the chain. The model sees your reason (sanitized, at most 500 characters) or a generic sentence for an error or timeout; the raw error goes only to the `hook.denied` audit row.
- **Policy hooks fail closed.** While your extension is enabled and approved with a mount in `permissions.policyHooks`, a replica where it is not loaded (setup failed, pending configuration, dependency missing) denies every call on that mount for orgs that enabled it (`The <plugin> policy check is unavailable`). So declare `policyHooks` exactly for the mounts you register policy hooks on.
- **Observe hooks** are fire-and-forget, capped at 64 in flight per extension and replica (extra calls are dropped), also run for denied calls; their verdicts, errors and timeouts are ignored.
- **Denials are logged** (`hook.denied` audit row; a `hook_denied` event on a tool call or model step) and sticky: a resumed or retried step is denied again without rerunning hooks. A user abort is never a denial.
- **`model.request`** fires once per attempt of a step (`purpose: "step"`), once per compaction call (`"compaction"`) and once per title call (`"title"`, `runId` "", `step` 0). A denied compaction only skips compaction; a denied title call skips the title. The payload carries **no media bytes and no attachment ids**: every image or document block is `{ type: "media_omitted", kind, mediaType, size }`.
- **`model.response`** fires after a sent call finished or failed; not for a call the user aborted mid-stream, nor one never sent (denied, failed before sending).
- **`usage.report`** gets every logged `usage` event **at least once** (retries on any replica), so the handler is **idempotent by `eventId`**; `purpose` tells step, compaction and title calls apart; full-run eval replays are reported with `conversationKind: "eval"`. Declare `usage.report` only when you always register the handler: a loaded extension without one is dropped as a target.
- **`tool.preExecute`** runs after the tool policy and approval, before the call starts; a denial becomes the call's result (`Tool call blocked by the "<plugin>" policy hook: ...`). **`tool.postExecute`** gets the result as the model sees it (after output spilling) and is observe-only.
- **Sub-agents** fire hooks like a chat, with the running agent's `agentId` / `agentVersion` and `parent: { conversationId, runId, callId }`; their `usage.report` payloads carry the same `parent` so a meter can attribute tokens to the parent run. The parent's `agent` call fires `tool.preExecute` (deny it to refuse a dispatch; the input includes `subagent_type`) and `tool.postExecute`. A person's forked skill (`/name` with `context: fork`) is not a tool call: `tool.preExecute` does not see the dispatch (`callId` is `skill-<seq>`), though the child's own calls are hooked.
- Hooks live on the extension instance: upgrade or disable drains in-flight hook calls, and a policy hook revoked mid-call reruns once on the new instance.

### Durable counters and idempotency (reference example-counter)

- Durable counters go in `ctx.db`; multi-step changes in one request are one transaction: `ctx.db.transaction().execute(async (trx) => { ... })`. "Add N at once" uses SQL (`n = n + N`), never a loop of `kv.incr`.
- A reasonable use of kv (with TTL): `await ctx.kv.set(`seen:${eventId}`, "1", { ttlSeconds: 600 });` (short-lived idempotency key / rate limit / short cache).
- Idempotent queue handlers: generate a `jobId` when enqueuing (`crypto.randomUUID()`, no `:`) and put it in both the data and `opts.jobId`; give `job_id` a unique constraint; the handler does `INSERT ... ON CONFLICT (job_id) DO NOTHING RETURNING id` in one transaction and **only performs side effects if the row was really inserted**.

Any lasting side effect that "ends by relying on some signal" must have a maximum lifetime (TTL) and end itself.

## Test template (dual-replica)

Use `createDualReplicaHarness` from `@capybara-hq/testing`: two **independent child-process** replicas, with requests strictly alternating (the 1st, 3rd, 5th… go to replica 0). Anything that keeps state in process memory fails here.

```ts
import { fileURLToPath } from "node:url";
import { createDualReplicaHarness, type Harness, startTestPostgres } from "@capybara-hq/testing";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";

const PLUGIN = fileURLToPath(new URL("../src/index.ts", import.meta.url));
let pgc: Awaited<ReturnType<typeof startTestPostgres>>;
const harnesses: Harness[] = [];

beforeAll(async () => { pgc = await startTestPostgres(); });
afterEach(async () => { await Promise.all(harnesses.splice(0).map((h) => h.stop())); });
afterAll(async () => { await pgc?.stop(); });

it("alternating requests to the two replicas give a consistent result", async () => {
  const h = await createDualReplicaHarness({
    extensions: [PLUGIN],
    pgUrl: pgc.url,
    extensionConfig: { "my-plugin": { step: 2 } }, // optional: deployment-level config
  });
  harnesses.push(h);
  for (let i = 0; i < 5; i++) await h.request("/plugins/my-plugin/inc", { method: "POST" });
  const r = await h.request("/plugins/my-plugin/count");
  expect(((await r.json()) as { count: number }).count).toBe(10);
});
```

- `h.request` results carry `replica` (0 / 1, from the `x-capybara-replica` header); when you `fetch` a replica directly by `h.replicas[i].port`, use `replicaOf(res)` to confirm where it landed (e.g. an SSE connection). `h.kill(i)` SIGKILLs replica i to test takeover. The `config` option deep-merges extra kernel config into both replicas (e.g. `config: { auth: { cookieSecure: false } }`). Each harness has its own Redis; `stop()` when done; `pgUrl` lets several harnesses share one PG container.
- Queue jobs run asynchronously: poll until the expected value arrives (`waitFor`), never `sleep` a fixed time.
- Tests go in `plugins/<name>/test/`. **Run a single test from the repository root**: `pnpm exec vitest run plugins/<name>/test/<file>`. The root vitest config inlines the core packages from `node_modules` (`server.deps.inline: [/\/node_modules\/@capybara-hq\//]`) so the in-process kernel can load the plugin from `src/index.ts` and resolve its relative `./x.js` imports, and sets `NODE_OPTIONS=--import tsx` in the test environment so the replicas dual-replica tests start as child processes can do the same (and load the TypeScript fake extensions of `@capybara-hq/testing`); running from a package directory skips that and the replicas fail to load.

**Through a real kernel** (sign-in, orgs, agents, conversations driven by model-fake): `@capybara-hq/testing` also has `startTestKernel(testKernelConfig(urls, { extensions }), { resolveFrom })` for one in-process kernel (`k.http.inject`), `createLocalAccount`, `login`, `joinOrg`, `createOrg` / `createAgent` / `createConversation` / `postMessage`, `eventsOf` / `waitForEvent` / `waitForTerminal` / `waitFor`, `cardRecorded`, `truncateTables`, `openSse`, `pidOwningLocalPort`, `createDb` + `kernelDb` (the kernel's tables, typed) and kernel texts to assert on (`UNKNOWN_RESULT_TEXT`, the sandbox notices, queue names). Load model-fake by package name (`"@capybara-hq/plugin-model-fake"`, a devDependency of the plugin) with `resolveFrom` set to the plugin directory; model-fake's `tool:<key>:<json>` message makes the model call a tool. A plugin test imports only the SDK, `@capybara-hq/testing`, model-fake and the plugin's own files (rule `plugin-test-imports`); a missing kernel facility is exported by `@capybara-hq/testing` (ask in core). Examples: `plugins/example-board/test/board-events.dual.test.ts`, `plugins/slack/test/kernel/`.

**Shared test containers**: with `@capybara-hq/testing/global-setup` as the vitest `globalSetup`, one PostgreSQL and one Valkey start per run; `startTestPostgres()` then returns a fresh database on the shared server (`stop()` drops it), and a harness without `pgUrl` uses it too. Redis stays one container per caller by default (bus channels ignore the database number); `startTestRedis({ shared: true })` only in files where nothing subscribes to the bus. Never query cluster-wide views (`pg_stat_activity`, `pg_locks`) without filtering to `current_database()`. `CAPYBARA_TEST_NO_SHARED=1` restores per-file containers; `CAPYBARA_TEST_CONTAINER_STARTS` changes the cap of 4 concurrent container starts.

## Extension packages (npm-pack tgz)

An extension ships in a plugin package: an npm-pack tgz whose `.capybara-plugin/plugin.json` carries an `extension` section (layout and fields: `.agents/skills/writing-plugins`). The plugin directory **must have a source `.capybara-plugin/plugin.json`** (`schemaVersion`, `name` equal to the extension name, `version`, `publisher`, `description`, …; without `extension`, which the packer writes). `capybara-plugin pack <dir> [--out <dir>]` packs one, `pnpm pack-plugins` (`capybara-plugin pack --all .`) packs all (output `artifacts/plugins/`); `pnpm check` requires every plugin to pack and pass the kernel's package readers (`plugin-pack`). A tgz in the pre-0.1.0 format (a `capybara` section in `package.json`) is refused by kernels (`extension.legacy_format`); repack it.

- esbuild bundles `src/index.ts` into single-file ESM `dist/index.mjs` with all third-party dependencies inside; only `@capybara-hq/plugin-sdk` and `zod` (including subpaths) are provided by the host; Node built-ins become `node:*`. A dependency that cannot be bundled (not installed, a native `*.node`) fails packing.
- **Dynamic `import()` only takes literals**; `import(variable)` is rejected by packing and installation.
- The manifest `version` equals `package.json` and `plugin.json` (`capybara-plugin sync-versions` copies it after `changeset version`); the manifest `name` equals the plugin name; `migrations` must resolve to the plugin root's `migrations/` (`"../migrations"`); a root `ui/` is carried as is. The generated `package.json` has `peerDependencies` equal to the manifest `sdk` range (which needs an upper bound).
- `extension.manifest` in `plugin.json` is the static manifest: review reads only it and the migration SQL, and at load time it is compared with the real module (`manifest_mismatch`). So the manifest (permissions, `secret` / `hot` of config fields) **cannot depend on the runtime environment**.
- The package carries `README.md`, `LICENSE` (the plugin's own, else the repository's), a `NOTICE` next to that `LICENSE`, every plain root file listed in `package.json` `files` (e.g. slack's `app-manifest.yaml`), and `THIRD-PARTY-NOTICES.txt` for bundled dependencies. Other `files` entries (directories, globs) are not shipped and are reported (`plugin-pack-dropped`). `description` / `repository` / `homepage` / `keywords` pass through.
- The generated package has no install scripts, `dependencies` or `node_modules/`; kernels reject those, path escapes, links and oversize packages at install.
- **Publishing to npm**: this repository publishes every `plugins/*` package except `example-*` (private) with `capybara-plugin release`, as the packed tgz, with npm provenance. Each `package.json` needs `repository` `{ type: "git", url: "git+https://github.com/capybara-hq/plugins.git", directory: "plugins/<name>" }` (equal to the root `package.json`'s `repository.url`; provenance rejects a mismatch), `description`, `license` and an https `homepage` (`plugin-release-metadata`). A version bump goes through a changeset.

### Lifecycle as an author sees it

Deployments install, enable, disable, upgrade and uninstall extensions without restarting (desired state in PG, each replica converges). What that means for your code:

- When switching versions **the new version loads first and the old one is revoked after**; a replica that fails to load the new version keeps the old one and retries. If the new version's permissions exceed the snapshot it waits for approval while the old one runs.
- **Migrations are expand-only** (add tables, columns, indexes; drops and changes take two releases, see `.agents/skills/writing-migrations`): old and new versions run at the same time on different replicas. Touch only the `plugin_<name>` schema and avoid `DO` blocks (both show as review warnings). One replica runs a migration under an advisory lock; others wait for it.
- **Downgrade** only goes back to a version whose migration files have all been run unchanged.
- Disabling / uninstalling keeps data (schema, secrets, org config, permission snapshot) for a reinstall.
- **An extension name belongs to the npm package that first installed it**; another package with the same extension name is refused (`extension.name_conflict`). Changing the npm package name means changing the extension name.
- Bootstrap plugins (`openai-compatible`, `object-store-s3`) are pinned by version and sha512 in core's `packages/kernel/bootstrap.json` and installed offline by every deployment; `required` ones are enabled in every org and cannot be disabled. A release of one needs core's pin updated: see [core AGENTS.md](https://github.com/capybara-hq/core/tree/main/AGENTS.md).

## New extension checklist

1. Copy `plugins/example-counter`; change the package name `@capybara-hq/plugin-<name>`, `name` (in the manifest and in `.capybara-plugin/plugin.json`) and the PG tables.
2. Add the plugin to the root `tsconfig.json` `references` if the repository lists plugins there.
3. Write migrations per `.agents/skills/writing-migrations`.
4. `pnpm lint && pnpm typecheck && pnpm check && pnpm exec vitest run plugins/<name>` (or `pnpm verify`).
5. Changes that affect a release get a changeset (`pnpm changeset`).
