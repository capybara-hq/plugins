# DeepSeek, Alibaba Bailian and Volcengine Ark provider plugins — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended)
> or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`)
> syntax for tracking.

**Goal:** three native `model-provider@2` plugins — `deepseek`, `bailian`, `ark` — that list their
platform's models (grouped by kind), stream chat, embed where the platform can, and take org keys
through overridable config fields.

**Architecture:** each plugin is self-contained under `plugins/<name>/` (no shared package):
`src/index.ts` (config, `create<X>Provider(opts)`, `defineExtension`), `src/list.ts` (platform list →
`ModelInfo[]`), `src/map-request.ts`, `src/map-stream.ts`, `src/errors.ts`, `src/embed.ts` (bailian,
ark). Config fields for credentials and endpoints are `orgAccess(..., "override")`; every call reads
the org's effective config from `opts.config`. DeepSeek and Ark are Chat-Completions shaped (the
`openai` SDK with `maxRetries: 0`, as `openai-compatible` does); Bailian uses DashScope's native API
with `fetch` and its own SSE parser.

**Tech Stack:** TypeScript, zod 4, `@capybara-hq/plugin-sdk` `^0.1.0-rc.4` (kinds, `embed`,
`ModelCallOptions`, `orgAccess`, `validateEmbedResult`), `@capybara-hq/testing` `^0.1.0-rc.7`
(`startFakeModelServer`, `describeModelProviderConformance` with `expect.embedding`), vitest.

**Spec:** design B, `docs/superpowers/specs/2026-11-06-model-platform-providers-design.md` in
`capybara-hq/core` (local: `/Users/grant/Capybara/core/docs/superpowers/specs/…` once core main is
pulled; core PR #95), §4 (platform facts), §5.1-§5.5 (contract), §6 (the plugins). Research with URLs
and the corrections to §4: `.superpowers/sdd/plugins-research.md` (cited "R").

## Global Constraints

- Prerequisite: the core release carrying SDK `0.1.0-rc.4` / testing `0.1.0-rc.7` / plugin-tools
  `0.1.0-rc.6` / model-fake `0.1.0-rc.4` is on npm (core PR #97). Task 0 upgrades the repo to it.
- New plugins ship at `0.1.0-rc.0` with **no changeset**; their marketplace entries are written with
  `capybara-plugin marketplace --write` in this PR (jina precedent, R §1.1). `defineExtension.sdk` and
  the package deps use `^0.1.0-rc.4`.
- Plugin names `deepseek`, `bailian`, `ark`; npm `@capybara-hq/plugin-<name>`; `displayName` zh / en:
  DeepSeek / DeepSeek, 阿里云百炼 / Alibaba Cloud Model Studio, 火山方舟 / Volcengine Ark.
- Credentials and endpoint fields are overridable (design B §5.5): `apiKey`, `baseUrl` / `region`,
  `workspaceId`, Ark `management`. `setup` never strictly parses a required field (it may be absent
  from `ctx.config` when the platform leaves it empty); each `listModels` / `stream` / `embed`
  `safeParse`s `opts.config ?? <setup defaults>` and throws `ModelError("auth", …)` for a missing key,
  `ModelError("invalid_request", …)` for an invalid config. The factory takes default options so the
  conformance suite (which passes no config) works. Never sign or send a credential to a host taken
  from a field of a different level (all of them are overridable here, so they move together).
- Every rendered config field has `label { zh, en }` (`ui()`); secrets via `secret()`;
  `permissions.network` lists the default hosts (Bailian workspace hosts cannot be listed exactly:
  list the regional and legacy hosts and say so in a comment).
- Provider rules (`.agents/skills/writing-model-providers`): append-only per-message mapping,
  `[system] ` user turns unless position-safe mid-conversation system is proven live, opaque thinking
  replay only when `provider === <plugin> && model === req.model`, usage `inputTokens` uncached only,
  errors by status / structured code (aborted signal wins), truncated stream → `ModelError("network")`,
  **no retries**, `streamIdleTimeoutMs: 300000` for reasoning models, declare a parameter default only
  when equal to the API default, `vision` / `documents` accurate with a source + date comment.
- Kinds (design B §5.1): a platform model that maps to no SDK kind is **skipped** (not listed as
  `other`); a model whose limits the platform omits gets a bundled per-model table entry or
  conservative defaults documented in the code (`contextWindow` 32768, `maxOutputTokens` 4096).
- No plugin-level list cache (the kernel caches `listModels` per effective config); no module-level
  mutable state.
- Live tests are gated by these env names (in `~/.capybara-test.env`, never printed):
  `CAPYBARA_TEST_DEEPSEEK_API_KEY`; `CAPYBARA_TEST_BAILIAN_API_KEY`, `_REGION`, `_WORKSPACE_ID`,
  `_CHAT_MODEL`, `_EMBED_MODEL`; `CAPYBARA_TEST_ARK_API_KEY`, `_REGION`, `_ACCESS_KEY_ID`,
  `_SECRET_ACCESS_KEY`, `_CHAT_MODEL`, `_EMBED_MODEL`. Load with
  `set -a; . ~/.capybara-test.env; set +a` inside the test command only.
  `CAPYBARA_TEST_DEEPSEEK_API_KEY` falls back to `CAPYBARA_TEST_OAICOMPAT_API_KEY`. The `_CHAT_MODEL` /
  `_EMBED_MODEL` variables are optional (decided with the maintainer, 2026-11-08): unset, the live test
  lists the platform's models (Ark through AK/SK, which the maintainer provides — listing is the
  plugin's core feature) and picks the first chat / embedding model; a call failing with an
  access / not-activated error moves to the next candidate (at most 5), then the case is skipped with
  one printed reason.
- Local only until the maintainer asks: no push, PR or publish. Single test: `pnpm exec vitest run
  <path>` from the worktree root.

## Review Focus

1. **A huge Bailian list.** Hundreds of models over several pages with unknown capability codes,
   missing limits, retired models and third-party inference providers: one `listModels` call pages to
   the end within the kernel's list timeout (page size as large as the API allows), skips what it
   cannot map, and never fails as a whole for one odd entry. Tests in Task 2.
2. **Org key vs platform key.** The platform config leaves `apiKey` empty and an org supplies its
   own: every call uses `opts.config`; with neither, `ModelError("auth")` before any request. Tests in
   Tasks 1-3.
3. **Thinking replay across turns.** DeepSeek with tools requires every assistant turn's
   `reasoning_content`; Ark's newer seed models require `encrypted_content` back verbatim; a turn
   produced by another model or provider drops its thinking whole. The append-only prefix test holds.
   Tests in Tasks 1 and 3.
4. **Embedding batches and order.** Bailian returns `text_index` possibly out of order; Ark's
   multimodal endpoint may take one input per call: vectors come back in input order, one per input,
   of the requested dimension (`validateEmbedResult`); `maxBatch` declared to match the platform.
   Tests in Tasks 2 and 3.
5. **Mid-stream errors.** An SSE error event or a stream cut after some text: `ModelError` with the
   right kind, never a half `message_complete`. Tests in Tasks 1-3.

---

### Task 0: Upgrade to the core rc; scaffold the three packages; skill update

**Files:** root `package.json`, `pnpm-lock.yaml`, every `plugins/*/package.json` dep range on core
packages, existing plugins' test ctx fakes if typecheck needs a `models` stub; new
`plugins/{deepseek,bailian,ark}/{package.json,tsconfig.json,.capybara-plugin/plugin.json,README.md,src/index.ts}`
(skeleton: `defineExtension` with name, version `0.1.0-rc.0`, `sdk: "^0.1.0-rc.4"`, `provides:
[MODEL_PROVIDER_EXTENSION_POINT_V2]`, `displayName`, a provider whose `listModels` returns `[]` and
`stream` throws `ModelError("invalid_request", "not implemented")`), root `tsconfig.json` references,
`.agents/skills/writing-model-providers/SKILL.md` (kinds, `embed`, `ModelCallOptions` and the
overridable-config pattern, `expect.embedding`).

- [ ] **Step 1:** `pnpm update -r @capybara-hq/plugin-sdk@^0.1.0-rc.4 @capybara-hq/testing@^0.1.0-rc.7 @capybara-hq/plugin-tools@^0.1.0-rc.6 @capybara-hq/plugin-model-fake@^0.1.0-rc.4` (then `pnpm install`).
- [ ] **Step 2:** `pnpm typecheck && pnpm test` on the existing plugins; fix only what the upgrade
  breaks (ctx fakes, renamed types), each in its own commit `fix(<plugin>): …`.
- [ ] **Step 3:** scaffold the three packages (copy `plugins/jina` layout for metadata; tsconfig from
  `openai-compatible`), add root tsconfig references, `pnpm install`.
- [ ] **Step 4:** update the skill.
- [ ] **Step 5:** `pnpm lint && pnpm typecheck && pnpm check` pass. Commits
  `chore: upgrade to core 0.1.0-rc.4 packages`, `feat: scaffold deepseek, bailian and ark plugins`,
  `docs(skills): model kinds, embeddings and org-bound config for providers`.

### Task 1: `deepseek`

**Files:** `plugins/deepseek/src/{index,list,map-request,map-stream,errors}.ts`,
`plugins/deepseek/test/{fixtures,map,conformance,list}.test.ts`, `plugins/deepseek/test/live/*.live.test.ts`

**Interfaces — produces:**
- Config: `apiKey: orgAccess(ui(secret(z.string().min(1)), { label: { zh: "API 密钥", en: "API key" } }), "override")`
  (optional in the schema; required per call), `baseUrl: orgAccess(ui(z.string().url().default("https://api.deepseek.com"), …), "override")`.
  `permissions.network: ["api.deepseek.com"]`.
- `createDeepSeekProvider(defaults: { apiKey?: string; baseUrl?: string }): ModelProvider` (no `embed`).
- `listModels`: `GET {baseUrl}/models`; per model: `displayName` = `name` ?? id; `contextWindow` /
  `maxOutputTokens` from the response, else the bundled table (`deepseek-flash`, `deepseek-v4-pro`
  with today's live values, R Part 2), else the conservative defaults; `vision` = `input_modalities`
  contains `image`; `documents: false`; `reasoning: true` when `effort` is present; parameters
  `thinking` (`off|on`, default `on`) and `effort` (levels = `effort.supported_levels`, default
  `effort.default_level`) only for reasoning models, `temperature` 0-2 default 1;
  `midConversationSystem: false` (`[system]` turns; the `system_prompt_update` field describes the
  Anthropic endpoint, R Part 2); `kind: "chat"`; `streamIdleTimeoutMs: 300000` for reasoning models.
- `stream`: Chat Completions with `stream_options.include_usage`; `thinking: { type }`,
  `reasoning_effort` (omitted when thinking off); reads `delta.reasoning_content`; replay: own
  thinking (opaque `{ provider: "deepseek", model, data: { field: "reasoning_content" } }`) → assistant
  `reasoning_content`, and with tools and thinking not off every other assistant turn gets
  `reasoning_content: ""`; usage `inputTokens = prompt_tokens − prompt_cache_hit_tokens`,
  `cacheReadTokens = prompt_cache_hit_tokens`; `finish_reason` `insufficient_system_resource` and
  `aborted` → `ModelError("server")`; `tool_choice` `required` / named while thinking is on →
  `ModelError("invalid_request", "DeepSeek does not allow a forced tool choice in thinking mode")`.
- Errors: 400 / 422 invalid_request, 401 auth, 402 auth (balance), 429 rate_limited (retry-after),
  500 server, 503 overloaded; context-length codes → context_overflow.

- [ ] **Step 1: Write the failing tests**: list mapping from a recorded `/models` body (the two live
  models plus one with only `id`); request mapping and the append-only prefix test; replay rules;
  usage math; one test per error-table row and the two `finish_reason` rows; a missing key in both
  `opts.config` and defaults → `auth` before any request; an org key in `opts.config` is the one sent
  (fake server asserts the `Authorization` header); fixture conformance; live conformance with
  `CAPYBARA_TEST_DEEPSEEK_API_KEY` (model from the live list, `deepseek-flash`).
- [ ] **Step 2: Run** `pnpm exec vitest run plugins/deepseek`; expected FAIL.
- [ ] **Step 3: Implement** (ideas from `openai-compatible`'s deepseek dialect and stream accumulator,
  copied and adapted, no import).
- [ ] **Step 4: Run** the tests, then the live tests (`set -a; . ~/.capybara-test.env; set +a; pnpm exec vitest run plugins/deepseek -t live`), `pnpm check`; expected PASS.
- [ ] **Step 5: Commit** `feat(deepseek): native DeepSeek provider`.

### Task 2: `bailian`

**Files:** `plugins/bailian/src/{index,list,map-request,map-stream,embed,errors,tables}.ts`, tests and live tests as in Task 1.

**Interfaces — produces:**
- Config: `apiKey` (override, secret), `region` (override, enum `cn-beijing` | `ap-southeast-1` |
  `cn-hongkong` | `ap-northeast-1` | `eu-central-1` | `us-east-1`, default `cn-beijing`), `workspaceId`
  (override, optional string; required by the list URL outside `us-east-1` → missing → `ModelError(
  "invalid_request", "workspaceId is required for <region>")` on list). Base URL:
  `https://{workspaceId}.{region}.maas.aliyuncs.com`; `us-east-1` → `https://dashscope-us.aliyuncs.com`.
- `createBailianProvider(defaults)` with `listModels`, `stream`, `embed`.
- `listModels`: all pages (`page_size` = the largest the API accepts, found in Step 0; `supports=inference`;
  `language` = `zh-CN`); kind by capabilities: `TG`/`VU` → chat (vision when `VU` or
  `request_modality` has `Image`), `TR` → embedding, `IG` image_generation, `VG` video_generation,
  `ASR` speech_to_text, `TTS` text_to_speech; anything else (`ME`, realtime, omni, 3D) skipped;
  `publisher` = `provider`; `description`; `retiresAt` = `offline_time`; limits from `model_info`
  (null → table / defaults); `tools` = `function-calling`, `caching` = `cache`; `Reasoning` →
  `reasoning: true` with a `thinking` parameter (`enable_thinking`, no default declared);
  `inference_provider` ∉ the set verified in Step 0 → skipped (design B §6.2 "left out of the list,
  documented"); an embedding model missing from the bundled embedding table → skipped with one warn.
- Embedding table (R Part 2): `text-embedding-v4` dims `[2048,1536,1024,768,512,256,128,64]` default
  1024, maxBatch 10, maxInputTokens 8192; `text-embedding-v3` `[1024,768,512]` default 1024, 10, 8192;
  `qwen3.7-text-embedding` `[2560,2048,1536,1024,768,512,256]` default 1024, 20, 131072 (confirm in
  Step 0).
- `stream`: native `text-generation` (or `multimodal-generation` for vision models) with
  `X-DashScope-SSE: enable`, `result_format: "message"`, `incremental_output: true`; own SSE parser;
  `reasoning_content`; tool calls by index; usage: `inputTokens = input_tokens − cached_tokens −
  cache_creation_input_tokens` if Step 0 confirms `input_tokens` includes them, else as returned;
  `cacheReadTokens`, `cacheWriteTokens`. No thinking replay (drop thinking) unless Step 0 proves
  `preserve_thinking` works.
- `embed`: `text-embedding/text-embedding` with `parameters.dimension`, `text_type` from `inputType`
  (default `document`); results sorted by `text_index`; `usage.inputTokens = usage.total_tokens`.
- Errors: 400 `InvalidParameter` invalid_request; `InternalError.Algo.InvalidParameter` with the
  input-length message → context_overflow; 401 `InvalidApiKey`, 403 `AccessDenied` / `Arrearage` →
  auth; 404 `ModelNotFound` → invalid_request; 429 `Throttling.*` → rate_limited
  (`Throttling.AllocationQuota` → rate_limited, comment the ambiguity); `DataInspectionFailed` →
  refusal-equivalent per the SDK's kinds (`invalid_request` if none fits); 5xx server / 503
  overloaded; mid-stream error events by their `code`.

- [ ] **Step 0: Live check** (keys required; record findings in the task report and as comments with
  the date): max `page_size`; the `inference_provider` values that work on the native endpoint
  (try one DeepSeek, one Kimi, one GLM, one MiniMax, one SiliconFlow-served model); whether
  `input_tokens` includes cached tokens; `preserve_thinking` replay; the mid-stream error event shape;
  the embedding table values. If a value cannot be confirmed, keep the conservative choice above.
- [ ] **Step 1: Write the failing tests** from recorded fixtures (a two-page list with every kind, an
  unknown code, a retired model, a third-party inference provider, null limits); request / stream
  mapping, append-only prefix, usage, error rows, mid-stream error; embed order by `text_index`,
  dimension, batch; conformance with `expect.embedding`; live tests.
- [ ] **Step 2: Run** `pnpm exec vitest run plugins/bailian`; expected FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** tests, live tests, `pnpm check`; expected PASS.
- [ ] **Step 5: Commit** `feat(bailian): native Alibaba Cloud Model Studio provider`.

### Task 3: `ark`

**Files:** `plugins/ark/src/{index,list,sign,map-request,map-stream,embed,errors,tables}.ts`, tests and live tests.

**Interfaces — produces:**
- Config: `apiKey` (override, secret), `region` (override, enum `cn-beijing` | `cn-shanghai`,
  default `cn-beijing`), `management` (override, optional object `{ accessKeyId: string;
  secretAccessKey: secret }`). Hosts: data plane `https://ark.{region}.volces.com/api/v3`; control plane
  `https://ark.{region}.volcengineapi.com`.
- `createArkProvider(defaults)` with `listModels`, `stream`, `embed`.
- `listModels`: with `management`, `ListFoundationModels` (`Version=2024-01-01`, all pages, V4
  HMAC-SHA256 signing in `sign.ts` with `node:crypto`, service `ark`) and, if accessible,
  `ListEndpoints` (the account's `ep-…` endpoints, listed by endpoint id with the foundation model's
  info); limits and kinds from the bundled table keyed by model name; without `management`, the
  bundled table alone (models of today's Ark model list page, R Part 2, with a dated comment). If Step 0
  shows the inference key can list models, use that and drop `management`.
- `stream`: `/chat/completions`; `thinking: { type }` parameter (no default declared),
  `reasoning_effort` parameter where the table says the model supports it; reads `reasoning_content`
  and `encrypted_content`; **opaque replay**: thinking block data `{ encrypted_content?, field:
  "reasoning_content" }`; on replay for the same provider + model, send `encrypted_content` back on
  the assistant message when present (it takes priority), else `reasoning_content` when the model
  needs it, else drop; usage `inputTokens = prompt_tokens − cached_tokens`, `cacheReadTokens`;
  `max_tokens` vs `max_completion_tokens` per Step 0.
- `embed`: the endpoint Step 0 confirms (text `/embeddings` if live, else `/embeddings/multimodal`
  with one `{ type: "text", text }` input per request); `maxBatch` = what the endpoint accepts (1 for
  the multimodal fused case); `inputType` → the Query / Corpus instruction templates.
- Errors: OpenAI-shaped bodies; 400 invalid_request (context-length codes → context_overflow;
  "Invalid signature" on replay → invalid_request), 401 auth, 403 auth, 429 rate_limited, 5xx server.

- [ ] **Step 0: Live check** (keys required; record with dates): whether `/api/v3/models` or any
  inference-key route lists models; the `ListFoundationModels` / `ListEndpoints` item fields with
  AK/SK; `encrypted_content` presence and replay on the configured seed model (two-turn tool call);
  `max_tokens` vs `max_completion_tokens` behaviour with thinking; the embedding endpoint, dimensions
  and batch behaviour.
- [ ] **Step 1: Write the failing tests**: signing against a known test vector (compute one with the
  algorithm and assert canonical request / string-to-sign / signature pieces); list with and without
  management (fake control-plane server); request / stream mapping, encrypted_content replay (same
  model replays, other model drops), append-only prefix, usage, error rows, mid-stream cut; embed
  order and batch; conformance with `expect.embedding`; live tests.
- [ ] **Step 2: Run** `pnpm exec vitest run plugins/ark`; expected FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** tests, live tests, `pnpm check`; expected PASS.
- [ ] **Step 5: Commit** `feat(ark): native Volcengine Ark provider`.

### Task 4: Marketplace, docs, verify

**Files:** `.capybara-plugin/marketplace.json` (`capybara-plugin marketplace --write`, summaries with
`zh`), `AGENTS.md` (plugin list, live test env names), `.agents/skills/writing-model-providers/SKILL.md`
live-mode list, each plugin's `README.md` (config, kinds, what was verified live and when, known
limits: Bailian third-party providers left out, Ark list from the bundled table without AK/SK).

- [ ] **Step 1:** write the docs and marketplace entries.
- [ ] **Step 2:** `pnpm -s verify --json` passes; run all three live suites once and record the
  models and results in the PR notes.
- [ ] **Step 3: Commit** `docs: deepseek, bailian and ark providers in the marketplace`.
