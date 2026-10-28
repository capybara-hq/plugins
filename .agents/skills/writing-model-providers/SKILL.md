---
name: writing-model-providers
description: 'Use when creating or modifying a model provider extension in this repository (provides model-provider@2, e.g. plugins/anthropic, plugins/openai, plugins/openai-compatible): the contract, parameter declarations and standard knobs, dialect presets, the native-protocol principle, append-only request mapping, opaque replay, media blocks (image / document mapping and the vision / documents declarations), usage semantics, the error mapping table, no retries inside the extension, streamIdleTimeoutMs, model patches with removal conditions, and tests with the conformance suite, startFakeModelServer fixtures and the live-API mode (CAPYBARA_TEST_* keys).'
---

# Writing model provider extensions

General extension authoring (manifest, config, ctx, multi-replica rules, dual-replica tests) is in `.agents/skills/writing-extensions`; this skill covers what is specific to `model-provider@2`. Reference implementations: `plugins/anthropic` (Messages API), `plugins/openai` (Responses API), `plugins/openai-compatible` (Chat Completions + dialect presets; a bootstrap plugin every deployment installs). The deterministic scripted model `model-fake` stays in core and is used here from npm as `@capybara-hq/plugin-model-fake` (devDependency, for kernel-level tests). The kernel side (capability gating, media limits and placeholders, append-only history and opaque replay as the runtime enforces them, retries and fallback) is core's: [writing-model-providers in core](https://github.com/capybara-hq/core/tree/main/.agents/skills/writing-model-providers).

## Contract: `model-provider@2`

The types are in `@capybara-hq/plugin-sdk` (`model.ts`). The manifest has `provides: [MODEL_PROVIDER_EXTENSION_POINT_V2]` (`model-provider@2`), and `setup` calls `ctx.provide(MODEL_PROVIDER_EXTENSION_POINT_V2, provider)`:

```ts
interface ModelProvider {
  listModels(): Promise<ModelInfo[]>;
  /** The event sequence must end with exactly one message_complete; on error, throw ModelError. */
  stream(req: ModelRequest, opts: { signal: AbortSignal }): AsyncIterable<ModelStreamEvent>;
}
```

- `ModelRequest`: `model`, `system` (`{ text, cache }[]`, stable content first, a cache breakpoint after blocks with `cache: true`), `messages` (user / assistant / mid-conversation `system`), `tools`, optional `toolChoice` (`"auto"` / `"none"`), `maxOutputTokens`, `params` (already processed by the kernel against the model's declarations: undeclared / invalid entries dropped, defaults filled in).
- `toolChoice: "none"`: in the wrap-up call at the step limit the kernel still sends `tools` (some providers require them when the history has tool calls, and it keeps the cache prefix stable), but the model must not call tools. Map it to the native field (anthropic `tool_choice: {type: "none"}`, OpenAI Responses / Chat Completions `tool_choice: "none"`); `"auto"` / absent is not sent, nor when `tools` is empty; a provider that cannot do this must guarantee no `tool_call`. A model with `capabilities.tools` false gets neither tools nor `toolChoice`, so a model that can call tools must declare `tools: true`.
- `ModelStreamEvent`: `text_delta`, `thinking_delta`, and finally exactly one `message_complete { content, stopReason, usage }`. The deltas concatenated equal the text in `content`. A truncated stream (no provider end event) must throw (usually `network`); it **must not** send `message_complete` with half the content.
- `ContentBlock`: `text`, `thinking`, `tool_call`, `tool_result`, and `image` / `document` (user messages only, see "Media blocks"); `text`, `thinking` and `tool_call` may carry `opaque`.
- `ModelInfo`: `contextWindow`, `maxOutputTokens`, `capabilities` (`tools` / `vision` / `reasoning` / `caching` / `midConversationSystem` / optional `documents`; `effort` is deprecated, `@1` only), optional `streamIdleTimeoutMs`, and required `parameters` (may be empty). The kernel caches `listModels`; on failure it skips that provider and logs.
- Check errors with `isModelError(e)` / `isRetryableKind(kind)` (duck typing), never `instanceof ModelError`: an extension may bundle another copy of the SDK.

No mutable in-process state: caches such as model info go in `ctx.kv` with a TTL (anthropic's `models:v3:<id>`, 3600 seconds; bump the version when the ModelInfo shape changes); accumulators within one call are local variables.

## Parameter declarations (`ModelInfo.parameters`)

A model declares the parameters it supports; agents' `modelParams` / `fallbackParams` are validated against them, the request carries `req.params`, and the extension maps them to the native request. **Adding a parameter changes only the extension**: the web agent form renders controls from the declarations (`label` / `description`).

```ts
interface ModelParameter {
  key: string;                       // a standard knob name, or "<plugin name>.<name>"
  standard?: "effort" | "thinking" | "temperature" | "maxOutputTokens"; // required for standard knobs and equal to key; vendor parameters must not set it
  schema: ParamSchema;               // a restricted JSON Schema subset
  default?: ParamValue;              // must satisfy schema
  label: { zh: string; en: string }; // both required, non-empty
  description?: { zh: string; en: string };
}
```

- **The schema is one of**: `{ type: "string", enum: [...] }`, `{ type: "string", maxLength? }`, `{ type: "boolean" }`, `{ type: "number" | "integer", minimum?, maximum? }`.
- **Keys**: standard knobs are `effort` / `thinking` / `temperature` / `maxOutputTokens`; vendor parameters are `<plugin name>.<name>` with the prefix exactly the extension name (`openai-compatible.xxx`). Violations make the provider unavailable at load (`assertValidDeclarations` throws).
- **Standard knobs** (uniform across the platform, portable across models / fallbacks):

| Knob | schema | Semantics |
|---|---|---|
| `effort` | `string` enum, a subset of `low|medium|high|xhigh|max` | Thinking depth; the levels are the model's |
| `thinking` | `string` enum, a subset of `off|on|summarized` | `off` disables, `on` enables, `summarized` enables and returns a thinking summary |
| `temperature` | `number` (may have a range) | Sampling temperature |
| `maxOutputTokens` | `integer` (may have a range) | Maximum output tokens; overrides `runtime.maxOutputTokens` (capped at the model limit) |

- **Declare a default only when it equals the provider API's own default**, so "unset" and "set to the default" behave the same; when it varies by model or can't be looked up, give none (openai's effort, Qwen's thinking). Exception: anthropic's thinking defaults to `summarized` (the provider returns no thinking text by default; the platform chooses a summary).
- Not every model has every knob: anthropic has no `temperature`; openai declares `thinking` only when `reasoningSummary != "off"`. Never declare or send unsupported parameters.
- SDK pure functions: `assertValidDeclarations(plugin, decls)` (self-tests and the kernel at load), `validateParams`, `sanitizeParams`. The conformance suite has a `declares valid parameters` case.
- Parameter decisions are logged with each model call, so requests can be reconstructed.

The old contract `model-provider@1` (`capabilities.effort` + `req.effort`) still works through a kernel adapter, and `@2` wins when an extension provides both. New extensions always write `@2`.

## Dialect presets (OpenAI-compatible APIs)

`plugins/openai-compatible` uses the official `openai` SDK's `chat.completions` against Chat Completions-compatible services. Their differences (thinking fields, usage fields, replay rules) live in dialects in `src/dialects.ts`: pure data plus stateless mapping functions (`parameters(model)`, `applyParams`, `readDelta`, `replayAssistant`, `usage`).

- Verify every field against the provider's official docs and note the source and verification date in a comment; don't implement fields you can't find.
- A dialect looks only at the message itself and request-level settings (model and its deployment attributes, whether tools are present, the parameters), never at other messages (append-only, below).
- To add a dialect: add a `Dialect` in `dialects.ts`, register it in `DIALECTS` and the config's `dialect` enum, and add fixtures and error mapping cases.
- The external model id is `<endpoint name>/<model id>`; keys go in the top-level `apiKeys` (endpoint name -> key): `secret()` works only on object field paths, and a key inside an `endpoints[]` element makes the extension fail to load.

## Native protocol: the official SDK, not a compatibility layer

- Each provider calls its **native API** with its **own official SDK** (Anthropic -> `@anthropic-ai/sdk` Messages API; OpenAI -> `openai` Responses API). No LangChain chat model wrappers, and no other vendors' models through an "OpenAI-compatible" API (`openai-compatible` is only for services offering nothing but Chat Completions, such as DeepSeek, Qwen, vLLM): compatibility layers lose thinking signatures, encrypted reasoning items and cache breakpoints, and hide real error types.
- Model capabilities follow the native API: from the Models API where it exists (anthropic), else from deployment config (openai's `models[]` carries `contextWindow` / `maxOutputTokens` / `reasoning` / `vision`).

## Request mapping is append-only

The kernel guarantees the history sent to the model is append-only: an earlier request's message sequence is a prefix of a later one's (which is also what makes prompt cache hits possible). The mapping must preserve this:

- **Each message's mapping depends only on itself and request-level settings** (the model and its attributes, the request's `tools` and `params`), **never on other messages**: no lookahead, no reordering, no merging or splitting of sent messages. Write it as a pure `buildRequest(req)` and unit test that "the mapping of request A is a prefix of the mapping of A plus new messages (request-level settings unchanged)". Example: with tools and thinking enabled, the DeepSeek dialect fills an empty `reasoning_content` into history turns without thinking from this model; that depends on request-level tools / thinking only.
  - Cost: when request-level settings change between requests (tools appear, thinking switches), earlier turns serialize differently, the provider's prefix cache is invalidated before the change and input is billed again; correctness is unaffected.
- Mid-conversation `system` messages: use a native representation that needs no surrounding context (openai: an in-place `developer` input item, `midConversationSystem: true`); if the native form has placement rules needing lookahead, **don't use it**: convert in place to a user text block `"[system] " + text` and report `midConversationSystem: false` (anthropic).
- Provider-private blocks (thinking, reasoning items) are replayed as they are; ones that can't be replayed are dropped whole.
- Never put the history cache breakpoint on "the last block of the last message" (it moves next turn and changes sent bytes). anthropic uses the automatic top-level `cache_control` (not added when system already used all 4 breakpoints); openai's cache is automatically prefix-based.
- Parameters the model doesn't support are neither declared nor sent: anthropic declares `thinking` only for models the Models API reports as supporting adaptive thinking, and takes `effort` levels from the per-level `supported`.

## Opaque replay: only to the same provider and model

`opaque = { provider, model, data }` is provider-private data (Anthropic thinking blocks and signatures, OpenAI reasoning items with `encrypted_content`, the output item ids of function_call and message).

- When producing it, `data` stores the native block as is, `provider` is the extension name, and `model` is **the model id the next turn will accept it under**:
  - openai uses the **request's** model id (the response's `model` is a dated snapshot name that would never match);
  - anthropic uses the response's `model`; when **server-side refusal fallback** (`fallbacks: "default"`) produces a `fallback` block, the thinking / tool opaque of the whole message is relabeled with `fallback.to.model`, or replaying to the original model fails signature validation.
- On replay, put it back only when `opaque.provider === this extension && opaque.model === req.model && data != null`; otherwise a thinking block is dropped whole and a tool call degrades to a plain call without private fields (openai drops the output item id). Blocks from other models after a model switch or fallback are normal.
- openai reasoning models require a replayed reasoning item to **immediately precede the output item it produced**: a text block's opaque stores the message item's `id` (and `phase`); when a reasoning item was replayed in the same assistant message, the text is replayed as the original message item (`{ type: "message", id, role: "assistant", status, content: [output_text] }`); otherwise no id (a lone msg_ id is rejected). Fixtures enforce this, but **it has not yet been verified against the real API**; see "Run the live API before releasing".

## Media blocks (`image` / `document`)

User messages may contain `image` (png / jpeg / gif / webp) and `document` (`application/pdf`, `text/plain` / `text/markdown` / `text/csv`), with `source` `{ kind: "base64", data }` and an optional `name`.

- **The gate is the kernel's**: a model gets `image` only with `vision: true` and `document` only with `documents: true` (then `text/*` also arrives as documents); otherwise the kernel substitutes a placeholder or inline text. So **declarations must be accurate**: per the official docs or the Models API, with source and date in a comment. anthropic: the Models API's `image_input` / `pdf_input`; openai: deployment config `models[].vision` / `documents` (default false); openai-compatible: the endpoint model's `vision` / `documents` (default false), and `documents` only on dialects whose Chat Completions accepts PDF (`pdfInput`: generic, qwen; deepseek / ark config validation rejects it).
- **Media limits are the kernel's too**: at most 20 images per request, PDFs over 100 pages, `text/*` over 50 000 characters, a block over `MEDIA_LIMITS` (images 5 MiB, documents 32 MiB decoded), or the request's media over `attachments.requestMediaBytes` are replaced or truncated before you see them. If the provider still rejects a media request with `invalid_request` / `context_overflow`, map it faithfully: the kernel then excludes those attachments in later requests. Never drop blocks or retry yourself.
- **`ref` never reaches the extension**: the kernel resolves stored references into `base64` when building the request. Receiving a `ref` is a kernel bug: throw `ModelError("invalid_request", …)` (not retryable), never drop it silently.
- **Mapping** (looks only at the block itself):

| Extension | Image | PDF | `text/*` |
|---|---|---|---|
| anthropic | `{type:"image", source:{type:"base64", media_type, data}}` | `{type:"document", source:{type:"base64", media_type:"application/pdf", data}, title?}` | `{type:"document", source:{type:"text", media_type:"text/plain", data:<UTF-8 text>}, title?}` |
| openai (Responses) | `input_image`, `image_url: "data:<type>;base64,…"`, `detail: "auto"` | `input_file`, `file_data` as a data URL, `filename` (with a `.pdf` suffix added) | `input_text`: `[Attached file "<name>" (<type>)]` + newline + text |
| openai-compatible (Chat Completions) | `{type:"image_url", image_url:{url:<data URL>}}` | `{type:"file", file:{filename, file_data}}` (only `pdfInput` dialects) | a text part, written the same as openai |

  When the API accepts only PDF documents, `text/*` is decoded as UTF-8 with a first line giving the file name and type. An openai-compatible user message with only text stays a string joined with `"\n\n"` (byte-identical to before media, compatible with services rejecting content arrays); the parts array is used only with images / PDFs.
- **No media in assistant messages**: model output is only text / thinking / tool calls.
- The conformance suite has "user message with image" (only when the model declares `vision`) and "user message with PDF / text document" (only with `documents`). `@capybara-hq/testing` generates the samples (a 64×64 solid red PNG, a one-page PDF with one word; `MEDIA_SAMPLES`, `isPngBase64`, `pdfSampleWord`), and the fixture server reads the answer from them, so a wrong mapping fails.

## Usage semantics (`ModelUsage`)

The three kinds of input don't overlap; the kernel uses their **sum** for context estimates and compaction:

- `inputTokens`: **uncached** input (neither read from nor written to the cache), not the total;
- `cacheReadTokens`: read from the cache; `cacheWriteTokens`: written to the cache by this call;
- Total input = `inputTokens + cacheReadTokens + cacheWriteTokens`.
- When the provider's input count includes the cached part, **subtract it first**: openai `inputTokens = input_tokens − cached_tokens − cache_write_tokens` (floor 0); anthropic's `input_tokens` already excludes cache reads and writes.

## Error mapping

Always throw `ModelError(kind, message, { retryAfterMs?, cause })`. Decide only by the SDK exception class, the HTTP status and the structured error `type` / `code`; **never match message strings**. When `signal` has aborted, classify as `aborted` whatever was thrown.

| kind | Retryable | Typical source |
|---|---|---|
| `rate_limited` | yes | 429; fill `retryAfterMs` from `retry-after-ms` (ms) or `retry-after` (seconds / HTTP date) |
| `overloaded` | yes | anthropic 529 / `overloaded_error` |
| `server` | yes | 5xx; `api_error` / `server_error`; an unrecognized error event mid-stream |
| `timeout` | yes | SDK connection timeout, 408, `timeout_error` |
| `network` | yes | connection failure, stream cut off before the end event |
| `auth` | no | 401 / 403; `billing_error`; openai `insufficient_quota` (a 429, but retrying is useless) |
| `invalid_request` | no | other 4xx; **malformed tool arguments** (below); a 400 for a too-long prompt (anthropic has no dedicated type) |
| `context_overflow` | no | 413 / anthropic `request_too_large`; openai `context_length_exceeded` |
| `aborted` | no | aborted by the caller |

The kernel handles retryable errors (retry the primary once after `retryAfterMs`, default 1 s, skipped above 10 s, then the agent's fallback model); non-retryable errors fail the run (`model.<kind>`). Misclassifying a request problem as retryable wastes retries and switches to the fallback; a transient failure as non-retryable fails a run that could have succeeded.

**Malformed tool arguments -> `invalid_request`**: when the tool input JSON fails to parse or isn't an object. If the SDK's streaming helper pre-parses tool input and wraps a failure in a generic exception (anthropic's `MessageStream`), don't use it: use the raw event stream (`create({ stream: true })`), accumulate the message yourself and `JSON.parse` it (both anthropic and openai `map-stream.ts` do this).

## No retries inside the extension

SDK clients always use `maxRetries: 0`. Retrying, waiting, degrading and step resets are the kernel's; retrying inside the extension stacks waits, bypasses the 10-second cap and makes the logged model calls disagree with real requests. Don't set your own request timeout to cover idle streams either; that is the kernel watchdog's job.

## `streamIdleTimeoutMs`

When more than the threshold passes between two stream events, the kernel's watchdog aborts and treats it as `timeout` (retryable). The threshold is `ModelInfo.streamIdleTimeoutMs`, else the kernel's `runtime.streamIdleMs` (default 60000).

- Ordinary chat models can leave it unset.
- Models whose reasoning phase may go long without events set it large: anthropic 300000 (5 minutes); openai per model from `models[].streamIdleTimeoutMs`.
- Too small treats long thinking as hung and retries; too large delays degradation on a real hang.

## Tests: fixture mode and live-API mode

Every provider runs `@capybara-hq/testing`'s conformance suite `describeModelProviderConformance(name, setup)` (streaming text, tool round trip, thinking replay, caching, usage, mid-conversation system, abort). Both modes live in `test/conformance.test.ts`:

```ts
import { describeModelProviderConformance, startFakeModelServer } from "@capybara-hq/testing";
import { describe } from "vitest";
import { createMyProvider } from "../src/index.js";
import { myRoutes } from "./fixtures.js";

// Fixture mode: a local fake server replays the native protocol; CI runs this by default
describeModelProviderConformance("my (fixtures)", async () => {
  const server = await startFakeModelServer(myRoutes());
  return {
    provider: createMyProvider({ apiKey: "sk-fixture", baseUrl: server.url, /* … */ }),
    model: "my-model",
    expect: { thinking: true, caching: true },
    teardown: () => server.stop(),
  };
});

// Live-API mode: runs only when a key is set
const LIVE_KEY = process.env.CAPYBARA_TEST_MY_API_KEY;
describe.skipIf(!LIVE_KEY)("live", () => {
  describeModelProviderConformance("my (live)", async () => ({
    provider: createMyProvider({ apiKey: LIVE_KEY ?? "" }),
    model: "my-cheap-model",
    expect: { thinking: true, caching: true },
    cachePrefixTokens: 6000, // the stable prefix must exceed the model's minimum cacheable length
    teardown: async () => {},
  }));
});
```

- `startFakeModelServer(routes)`: `routes(req)` gets `{ path, body, headers }` and returns `{ status, json, headers? }` (normal / error), `{ status: 200, sse: [{ event?, data }], delayMs? }` (SSE) or `{ stall: true }` (headers only, for abort and the watchdog). `server.requests` records every request, so assert on the native body sent. Fixtures are handwritten in the provider's native format in `test/fixtures.ts` (see `sseMessage`, `errorJson` in `plugins/anthropic/test/fixtures.ts`); never record keys from real responses.
- The extension constructor must accept `baseUrl` so fixture mode can point at the fake server.
- Beyond the suite, write a case per row of the error mapping table (429 with `retry-after`, 529, 5xx, 401/403, 400, 413, a mid-stream error event, stream truncation, malformed tool arguments, network failure, abort, stalled-stream abort), and prefix unit tests for the request mapping (`test/map.test.ts`).
- Live-API mode: anthropic `CAPYBARA_TEST_ANTHROPIC_API_KEY` (runs `claude-haiku-5-5`); openai `CAPYBARA_TEST_OPENAI_API_KEY` and `CAPYBARA_TEST_OPENAI_MODEL`; openai-compatible `CAPYBARA_TEST_OAICOMPAT_BASE_URL` / `_API_KEY` / `_MODEL` / `_DIALECT` (`generic` / `deepseek` / `qwen` / `ark`; runs only when all four are set; optional `_VISION=1` / `_DOCUMENTS=1` enable the media cases). Verified against real APIs so far: anthropic (`claude-haiku-5-5`), DeepSeek (`deepseek-flash`, dialect `deepseek`), openai (`gpt-5-nano`); media on anthropic `claude-haiku-5-5` and openai `gpt-5-nano`; the ark dialect's image mapping is **not yet verified**. When unset, the test prints one "skipped" line. Keep keys in an env file outside the repository, load it only in the test command, never print it.
- **Run the live API before releasing**: CI has no keys, and fixtures only approximate the docs. Before every provider release, pass the conformance suite against the real API (especially thinking replay: openai reasoning items + message items with ids, anthropic signed thinking blocks, cache hits with top-level `cache_control`), and state the models in the release notes. Also after changing the request mapping or upgrading an SDK.
- Kernel-level tests drive runs with model-fake (`@capybara-hq/plugin-model-fake`); its script syntax (`echo:`, `slow:<ms>:`, `stall`, `fail:<kind>`, `tool:<name>:<json>`, `long:<n>`, else `You said: …`) is documented in its package source (`src/script.ts`, [in core](https://github.com/capybara-hq/core/tree/main/plugins/model-fake)).
- Run from the repository root: `pnpm exec vitest run plugins/anthropic`.

## Model or gateway patches live only in the extension, with a removal condition

Special handling for one model or gateway (a parameter that 400s on some models, a field needing a special value, an unsupported header) goes **only in that extension**, keeping the kernel and SDK provider-neutral. Comment every patch in place with:

1. What it patches (which model / gateway, what symptom);
2. **When it can be removed** (provider fix, model retirement, an SDK version).

Examples: anthropic sends only `tool_choice: {type: "none"}`, not `any` / `tool` (these 400 on current models; remove once supported); thinking uses `display: "summarized"` (current models default to `omitted`). A patch that says only "workaround" stays forever.

## New provider extension checklist

1. Create the plugin (`@capybara-hq/plugin-<name>`) per `.agents/skills/writing-extensions` and `.agents/skills/writing-plugins`, depending on the official SDK and `@capybara-hq/plugin-sdk`, with devDependency `@capybara-hq/testing`.
2. Deployment config: `apiKey` with `secret(...)`, optional `baseUrl`, the model list; SDK client `maxRetries: 0`. Every model from `listModels` carries `parameters`, run through `assertValidDeclarations` in tests.
3. `map-request.ts` (pure, append-only), `map-stream.ts` (raw event accumulation, opaque, usage), `errors.ts` (per the table).
4. Fixture-mode conformance + error mapping cases + mapping prefix tests; live-API mode passing locally.
5. A README with a config example; `pnpm changeset` (new plugin: minor).
