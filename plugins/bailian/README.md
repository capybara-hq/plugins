# Alibaba Cloud Model Studio (Bailian) models

Model provider (`model-provider@2`) for Alibaba Cloud Model Studio (Bailian) on DashScope's native
API (plain `fetch`, no vendor SDK).

## Config

| Field | Notes |
|---|---|
| `apiKey` | secret; required; overridable per organization |
| `region` | default `cn-beijing`; overridable per organization |
| `workspaceId` | overridable per organization; required outside `us-east-1`, optional in `cn-beijing` (which then uses the shared domain `dashscope.aliyuncs.com`) |

The key is required, so a deployment without one shows the provider as needing configuration
rather than as failing to list its models. The platform may leave it empty for the organizations
to fill in (the kernel loads the extension with required overridable fields optional): each
organization following the platform then needs configuration and is never called, and an
organization copy brings its own key.

An organization that sets its own copy is resolved as a whole; the platform's key is never mixed
into it.

## Models

- Listing: the platform list `GET /api/v1/models` with page size 200 (the maximum), all pages, grouped
  by kind: chat, embedding, rerank, image / video generation, speech to text, text to speech. Only
  chat and embedding are callable.
- Only models served by the `aliyun-bailian` inference provider are listed. Third-party providers
  (MiniMax, Zhipu, Moonshot and others) were not activated on the test account, so they could not be
  verified and are left out.
- Embedding models come from a bundled table (the list carries no dimensions or batch sizes):
  `text-embedding-v4` (dimensions 2048 to 64, batch 10), `text-embedding-v3` (1024 to 64, batch 10),
  `text-embedding-v2` (fixed 1536, batch 25), `qwen3.7-text-embedding` (2560 to 256, batch 20) and
  `qwen3.7-text-embedding-flash` (1024 to 256, batch 25). An embedding model missing from the table
  is skipped with one warning.
- Chat uses text-generation for text models and multimodal-generation for vision models, with SSE;
  the endpoint is looked up per model and cached in `ctx.kv` for 24 hours. Parameters: `thinking`,
  `temperature`, `maxOutputTokens`. Explicit prompt caching marks the system prompt; usage
  `input_tokens` includes cached and cache-written tokens.

## Verified live (2026-11-08, cn-beijing)

Conformance suite (text, tools, parameters, thinking replay, caching, usage, image, abort) on
`qwen3.8-max` and `qwen3.7-max`, and embeddings on `qwen3.7-text-embedding`: 21 passed, 5 skipped
(documents, and image on the text model). Listing returned 373 models in two pages.

## Known limits

- Only `cn-beijing` was verified live; the other regions are unverified (no key).
- `max_tokens` does not cap thinking tokens on some models.
- The list route is rate limited (429); the endpoint cache keeps `stream` from calling it every time,
  and a cached endpoint is not invalidated if a model changes modality within 24 hours.
- `Throttling.AllocationQuota` is classified as `rate_limited`; a context overflow is recognised by
  the error message (a patch with a removal condition in `errors.ts`).
- Models are not checked for activation: a listed model the account has not activated fails on call.
