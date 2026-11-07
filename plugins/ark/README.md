# Volcengine Ark models

Model provider (`model-provider@2`) for Volcengine Ark chat and embedding models on the data plane
(`https://ark.<region>.volces.com/api/v3`). Chat uses the official `openai` SDK (Chat Completions);
the model list, endpoints and embeddings use plain `fetch`.

## Config

| Field | Notes |
|---|---|
| `apiKey` | secret; required per call (may be absent at load); overridable per organization |
| `region` | `cn-beijing` (default) or `cn-shanghai`; overridable per organization |
| `management.accessKeyId`, `management.secretAccessKey` | optional, advanced; both secret, so an organization's copy starts without the pair; overridable per organization; list custom `ep-` endpoints |

An organization that sets its own copy is resolved as a whole: only its values count, so the
platform's key and management keys never sign an organization's call. A copy without a key fails
with `auth` before any request.

## Models

- Listing: `GET /api/v3/models` with the API key returns limits, effort levels, thinking support
  and modalities; models are not activation-aware, so a listed model the account has not activated
  fails with `invalid_request` when called.
- With the optional management keys the control plane `ListEndpoints` call (signed V4 HMAC-SHA256)
  adds each running chat inference endpoint as a model with id `ep-...`; kind, limits and
  parameters come from its foundation model. The keys need `ArkReadOnlyAccess`. Stopped, embedding
  and custom-model endpoints are skipped.
- `ep-` endpoint ids skip the DeepSeek-only `reasoning_content` replay rule, since a call has no
  endpoint-to-model mapping without a signed request per stream. Ark accepted the absence live;
  multi-turn tool use through a DeepSeek endpoint may still be refused with a 400.
- Chat uses `max_completion_tokens`; encrypted reasoning content (`encrypted_content`) is replayed
  opaquely. Automatic caching is declared only for `deepseek-*` models.
- Embeddings use `/embeddings/multimodal`, which fuses all inputs of a request into one vector, so
  the provider sends one input per call (batch 1, sequential). Dimensions are 1024 or 2048
  (default 2048) for `doubao-embedding-vision-250615` and `-251215`.

## Verified live (2026-11-08, cn-beijing)

Conformance suite on `doubao-seed-2-1-pro-260915` with embeddings on `doubao-embedding-vision-251215`
(`encrypted_content` replay included), and on `deepseek-v4-flash-ga-260731` (caching included). With
the management keys, three endpoints were listed and a chat call to one answered.

## Known limits

- The 429 and 403 structured code names come from Ark's published list and were not reproduced
  live; a prompt over the context window maps to `invalid_request`.
- An endpoint over an embedding model not in `/models` is skipped with a warning.
- A stream that ends without a usage chunk completes with zero usage and a warning.
