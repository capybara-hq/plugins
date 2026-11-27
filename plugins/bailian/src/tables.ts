import type {
  ModelCacheInfo,
  ModelEmbeddingInfo,
  ModelImageGenerationInfo,
} from "@capybara-hq/plugin-sdk";

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

/** How a bundled image model is called. */
export type ImageApi =
  /** Sync `multimodal-generation`: `input.messages`, images in `output.choices[].message.content`. */
  | "multimodal"
  /** Async `text2image/image-synthesis` task: `input.prompt`, images in `output.results[].url`. */
  | "text2image";

export interface ImageModelInfo extends ModelImageGenerationInfo {
  api: ImageApi;
}

const size = (width: number, height: number) => ({ width, height });

/**
 * Qwen-Image 2.0 sizes: any W*H whose area is 512*512 to 2048*2048 (live 2026-11-18: "Image area
 * must be between 262144 (512x512) and 4194304 (2048x2048) pixels"). Declared: the docs'
 * recommended sizes (2048*2048 default, 2688*1536, 1536*2688, 2368*1728, 1728*2368), 1024*1024 and
 * a 3:2 pair inside the range, all multiples of 16 (the API snaps to 16).
 */
const QWEN_IMAGE_2: ImageModelInfo = {
  api: "multimodal",
  sizes: [
    size(2048, 2048),
    size(1024, 1024),
    size(2688, 1536),
    size(1536, 2688),
    size(2368, 1728),
    size(1728, 2368),
    size(2496, 1664),
    size(1664, 2496),
  ],
  defaultSize: size(2048, 2048),
  maxImages: 6,
  // Generation and editing share the endpoint: 1-3 images (URL or base64 data URI) next to the
  // text (https://help.aliyun.com/zh/model-studio/qwen-image-edit-api; one image checked live)
  maxReferenceImages: 3,
  // Documented PNG; PNG live
  outputMediaTypes: ["image/png"],
};

/**
 * wan2.6 / wan2.5 sizes: the docs' recommended list (1280*1280 default, 1104*1472, 1472*1104,
 * 960*1696, 1696*960) plus a 3:2 pair (1632*1088). The docs state an area of 1280*1280 to
 * 1440*1440, but their own recommended 1104*1472 (1,625,088) and 960*1696 (1,628,160) fall just
 * below 1280*1280 (1,638,400); wan2.6 accepts 589824 (768*768) to 2073600 (1440*1440) live
 * 2026-11-18. Every declared size is inside the live range (area 768*768 to 1440*1440, ratio 1:4
 * to 4:1; asserted in test/image.test.ts); wan2.5 was not probed live.
 */
// capybara:allow-module-state a read-only list of documented sizes
const WAN_25_SIZES = [
  size(1280, 1280),
  size(1104, 1472),
  size(1472, 1104),
  size(960, 1696),
  size(1696, 960),
  size(1632, 1088),
  size(1088, 1632),
];

/**
 * wan2.2 and earlier: each side 512-1440, at most 1440*1440 pixels (docs), default 1024*1024
 * (asserted in test/image.test.ts).
 */
// capybara:allow-module-state a read-only list of documented sizes
const WAN_22_SIZES = [
  size(1024, 1024),
  size(1152, 864),
  size(864, 1152),
  size(1248, 832),
  size(832, 1248),
  size(1280, 720),
  size(720, 1280),
];

const wan = (api: ImageApi, sizes: { width: number; height: number }[]): ImageModelInfo => ({
  api,
  sizes,
  defaultSize: sizes[0] as { width: number; height: number },
  // n is 1-4 (default 4: always sent; "parameters.n must be [1,4] integer" live)
  maxImages: 4,
  maxReferenceImages: 0,
  // PNG live (wanx2.0-t2i-turbo); JPEG declared too because the wan docs do not fix the format
  outputMediaTypes: ["image/png", "image/jpeg"],
});

/**
 * Image generation models with a documented API (https://help.aliyun.com/zh/model-studio/
 * qwen-image-api, /qwen-image-edit-api, /text-to-image-v2-api-reference, read 2026-11-18). The list
 * tags them `IG` but carries no sizes or limits, so they are bundled here; an `IG` model missing
 * from this table stays list-only (no `imageGeneration`). Left out until their docs are read:
 * qwen-image-2.1 / 3.0, z-image-turbo, wan2.7-image, wan2.6-image (edit only), the editing and
 * special-purpose models, wanx-v1 (an older request shape).
 */
export const IMAGE_MODELS: Readonly<Record<string, ImageModelInfo>> = {
  "qwen-image-2.0": QWEN_IMAGE_2,
  "qwen-image-2.0-2026-03-03": QWEN_IMAGE_2,
  "qwen-image-2.0-pro": QWEN_IMAGE_2,
  "qwen-image-2.0-pro-2026-03-03": QWEN_IMAGE_2,
  "qwen-image-2.0-pro-2026-04-22": QWEN_IMAGE_2,
  "qwen-image-2.0-pro-2026-06-22": QWEN_IMAGE_2,
  // Sync multimodal-generation (also offered as an async task; the sync call is used)
  "wan2.6-t2i": wan("multimodal", WAN_25_SIZES),
  // Async only
  "wan2.5-t2i-preview": wan("text2image", WAN_25_SIZES),
  "wan2.2-t2i-plus": wan("text2image", WAN_22_SIZES),
  "wan2.2-t2i-flash": wan("text2image", WAN_22_SIZES),
  "wanx2.1-t2i-plus": wan("text2image", WAN_22_SIZES),
  "wanx2.1-t2i-turbo": wan("text2image", WAN_22_SIZES),
  "wanx2.0-t2i-turbo": wan("text2image", WAN_22_SIZES),
};

/** Task polling: the first wait, doubled per poll up to the cap (all inside one call). */
export const IMAGE_POLL_INITIAL_MS = 1000;
export const IMAGE_POLL_MAX_MS = 5000;

/**
 * The explicit prompt cache of a chat model with the list's `cache` feature (live 2026-11-28): a
 * 5-minute entry whose every hit restarts the 5 minutes, created from 1024 tokens, with the
 * written tokens reported.
 */
export const CACHE_5M: Readonly<ModelCacheInfo> = {
  mechanism: "explicit",
  ttlOptions: [300],
  defaultTtl: 300,
  ttlIsMinimum: false,
  refreshOnHit: true,
  ttlClock: "unknown",
  minTokens: 1024,
  guaranteed: true,
};

/**
 * Qwen4 models also take the 1 h option on the native endpoint (live 2026-11-28). Whether a hit
 * within the hour renews the 1 h entry is unverified, so `refreshOnHit` is false.
 */
export const CACHE_5M_1H: Readonly<ModelCacheInfo> = {
  ...CACHE_5M,
  ttlOptions: [300, 3600],
  refreshOnHit: false,
};

/** The 1 h option of a request, as the native `parameters.prompt_cache_options.ttl`. */
export const CACHE_TTL_1H_SECONDS = 3600;
