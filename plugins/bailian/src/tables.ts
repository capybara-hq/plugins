import type { ModelEmbeddingInfo } from "@capybara-hq/plugin-sdk";

/** The plugin's name: the `provider` of its opaque blocks and the vendor parameter prefix. */
export const PROVIDER = "bailian";

/** Model Studio regions (https://help.aliyun.com/zh/model-studio/list-models, 2026-11-08). */
// capybara:allow-module-state a read-only list of region names
export const REGIONS = [
  "cn-beijing",
  "ap-southeast-1",
  "cn-hongkong",
  "ap-northeast-1",
  "eu-central-1",
  "us-east-1",
] as const;
export type Region = (typeof REGIONS)[number];

/**
 * Largest `page_size` the list API accepts: 200 (live, cn-beijing, 2026-11-08: 201 and above answer
 * HTTP 200 with `code: "10110400"`, "page_size exceeds the length limit"). 373 models then take two
 * requests.
 */
export const LIST_PAGE_SIZE = 200;
/** Stops a misbehaving list from paging forever (200 pages of 200 is far above any real list). */
export const LIST_MAX_PAGES = 200;

/** Limits for a chat model whose `model_info` leaves them null (design B §5.1 conservative defaults). */
export const DEFAULT_CONTEXT_WINDOW = 32_768;
export const DEFAULT_MAX_OUTPUT_TOKENS = 4096;

/** Reasoning models can go quiet for minutes while thinking. */
export const REASONING_STREAM_IDLE_MS = 300_000;

/**
 * How long the generation endpoint of a model stays cached in `ctx.kv`: 24 h. The endpoint is a
 * stable property of the model, and every miss costs a call on the rate-limited list route.
 */
export const ENDPOINT_CACHE_TTL_SECONDS = 86_400;

/**
 * `inference_provider` values whose models are listed (design B §6.2: a model that does not work
 * on the native endpoint is "left out of the list, documented").
 *
 * Live check 2026-11-08 (cn-beijing, native text- / multimodal-generation): `aliyun-bailian` models
 * work, including the hosted vendors Bailian serves itself (deepseek-v4-*, kimi-k2.6, glm-5.1,
 * MiniMax-M2.5). Every third-party server answered on the native endpoint with an activation error
 * (`mini-max`, `zhipu-ai`, `moonshot-ai`, `vanchin`, `siliconflow`, `stepfun`, `xiaomi`: "The
 * product is not activated" / "Aliyun market app does not exist"; `antdigital`, `unisound`: "url
 * error" on text-generation, activation error on multimodal-generation), so none could be verified
 * end to end and they stay out until one is.
 */
// capybara:allow-module-state a read-only list of provider names
export const VERIFIED_INFERENCE_PROVIDERS: readonly string[] = ["aliyun-bailian"];

/**
 * Text embedding models (sync API `text-embedding/text-embedding`). The list carries no dimensions
 * or batch limits, so they are bundled here; a `TR` model missing from this table is skipped.
 * Verified live 2026-11-08 (cn-beijing): accepted `dimension` values (others answer 400), the
 * largest batch (one more answers 400), the default dimension. `maxInputTokens`: the qwen3.7 models
 * from the list's `max_input_tokens`; text-embedding-v4 / v3 8192 and v2 2048 from the docs
 * (https://help.aliyun.com/zh/model-studio/text-embedding-synchronous-api), not probed.
 */
export const EMBEDDING_MODELS: Readonly<Record<string, ModelEmbeddingInfo>> = {
  "text-embedding-v4": {
    dimensions: [2048, 1536, 1024, 768, 512, 256, 128, 64],
    defaultDimensions: 1024,
    maxBatch: 10,
    maxInputTokens: 8192,
  },
  // The docs list 1024 / 768 / 512; the API also accepts 256 / 128 / 64 (live).
  "text-embedding-v3": {
    dimensions: [1024, 768, 512, 256, 128, 64],
    defaultDimensions: 1024,
    maxBatch: 10,
    maxInputTokens: 8192,
  },
  "qwen3.7-text-embedding": {
    dimensions: [2560, 2048, 1536, 1024, 768, 512, 256],
    defaultDimensions: 1024,
    maxBatch: 20,
    maxInputTokens: 131_072,
  },
  // Accepts dimension 1536-2560 but silently returns 1024 numbers, so only up to 1024 is declared.
  "qwen3.7-text-embedding-flash": {
    dimensions: [1024, 768, 512, 256],
    defaultDimensions: 1024,
    maxBatch: 25,
    maxInputTokens: 131_072,
  },
  // Fixed 1536 (the `dimension` parameter is ignored).
  "text-embedding-v2": {
    dimensions: [1536],
    defaultDimensions: 1536,
    maxBatch: 25,
    maxInputTokens: 2048,
  },
};
