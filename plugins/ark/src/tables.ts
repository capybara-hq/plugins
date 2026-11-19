import type {
  ImageSize,
  ModelEmbeddingInfo,
  ModelImageGenerationInfo,
} from "@capybara-hq/plugin-sdk";

/*
 * Facts the data plane's `GET /api/v3/models` does not give, checked live on cn-beijing on
 * 2026-11-08. Everything else (limits, modalities, thinking types, effort levels, tools) comes from
 * the list itself.
 */

/**
 * Embedding models served by `POST /api/v3/embeddings/multimodal`, by model id. Ark fuses every
 * input of one call into a single vector, so one call carries one text (`maxBatch` 1). Dimensions
 * accepted live for 251215: 1024 and 2048 (256 / 512 / 3072 / 4096 refused), default 2048;
 * 250615 per https://docs.volcengine.com/docs/ark/vectorization (1024 / 2048; retiring 2026-11-24,
 * ListFoundationModelVersions live).
 * The text-only `/api/v3/embeddings` models (doubao-embedding, -large) are all retiring and answered
 * "does not exist or you do not have access" live, so they are not listed.
 */
const EMBEDDING_MODELS: Record<string, ModelEmbeddingInfo> = {
  "doubao-embedding-vision-251215": {
    dimensions: [1024, 2048],
    defaultDimensions: 2048,
    maxInputTokens: 131_072,
    maxBatch: 1,
  },
  "doubao-embedding-vision-250615": {
    dimensions: [1024, 2048],
    defaultDimensions: 2048,
    maxInputTokens: 131_072,
    maxBatch: 1,
  },
};

/** The bundled embedding facts of a model id (own keys only, never a prototype member). */
export function embeddingInfo(id: string): ModelEmbeddingInfo | undefined {
  return Object.hasOwn(EMBEDDING_MODELS, id) ? EMBEDDING_MODELS[id] : undefined;
}

/**
 * Models whose own `reasoning_content` is replayed on later turns when no `encrypted_content`
 * came with it. DeepSeek's API wants every assistant turn's reasoning back in thinking mode with
 * tools (https://api-docs.deepseek.com/guides/thinking_mode); on Ark the same models accepted it
 * live (it counts in prompt_tokens) and did not refuse its absence. Seed models send
 * `encrypted_content` instead, and other vendors' replay rules are not documented: dropped.
 */
export const replaysReasoning = (model: string): boolean => model.startsWith("deepseek-");

/**
 * Automatic prefix caching on the Chat API: live, deepseek-v4-flash-ga reported cached_tokens on
 * a repeated 10k-token prefix, doubao-seed-2-0-lite never did (its `features.cache` means the
 * explicit context cache, which this plugin does not use). Unverified vendors: false.
 */
export const cachesAutomatically = (model: string): boolean => model.startsWith("deepseek-");

/** The model's vendor by its name (display only; the list has no vendor field). */
export function publisherOf(name: string): string | undefined {
  const prefixes: [string, string][] = [
    ["doubao-", "ByteDance"],
    ["deepseek-", "DeepSeek"],
    ["kimi-", "Moonshot AI"],
    ["glm-", "Zhipu AI"],
    ["qwen", "Qwen"],
  ];
  return prefixes.find(([p]) => name.startsWith(p))?.[1];
}

/** Conservative limits for a chat model the list gives none for (plan, Global Constraints). */
export const DEFAULT_CONTEXT_WINDOW = 32_768;
export const DEFAULT_MAX_OUTPUT = 4_096;

/*
 * Seedream image facts by model family (the list gives none: no sizes, no reference limit; some
 * entries even lack `modalities`). Sources: the image generation API page
 * https://docs.volcengine.com/docs/82379/1541523 (read 2026-11-18) and live checks on cn-beijing on
 * 2026-11-18: an out-of-range size answers 400 "image area must be at least 921600 / at most
 * 4624220 pixels" (5.5, 5.0 pro, 5.0 flash) and "at least 921600 / at most 16777216" (4.0);
 * "1024*1024" and "4K" (not a preset there) are refused, `WxH` is accepted.
 *
 * - Sizes are pixel `WxH` strings, a fixed list per family (the API takes any size inside a pixel
 *   range; the kernel needs a list): the 2K set fits every family's range (3,686,400 to
 *   4,624,220 pixels); the 1K set (1024x1024 and six 1K ratios, 921,600 pixels or more) is added
 *   where the minimum is 921,600 (5.5, 5.0 flash, 5.0 pro, 4.0), so a small image can be asked for
 *   to keep a conversation's image history light. Default 2048x2048, the documented 2K 1:1
 *   default.
 * - One image per call (`maxImages` 1): Ark has no `n`; group generation's `max_images` is only an
 *   upper bound and may return fewer, so the kernel never asks for more than one.
 * - Reference images (`image`): 10 on 5.5 / 5.0 pro / 5.0 flash, 14 on 4.5 / 4.0. The id
 *   `doubao-seedream-5-0-` (no suffix) is taken to be 5.0 lite (not activated on the test account,
 *   so not checked live): sizes from the 4.5 / lite range, and deliberately the conservative 10
 *   references of the 5.x family rather than the documented 14 (unverified; a lower limit only
 *   refuses requests the vendor might have taken).
 * - Output: JPEG by default (live), PNG on request (5.5 returns PNG); the provider sniffs the bytes.
 */
// capybara:allow-module-state read-only size list
const TWO_K: ImageSize[] = [
  { width: 2048, height: 2048 },
  { width: 2304, height: 1728 },
  { width: 1728, height: 2304 },
  { width: 2496, height: 1664 },
  { width: 1664, height: 2496 },
  { width: 2816, height: 1584 },
  { width: 1584, height: 2816 },
];
// capybara:allow-module-state read-only size list
const ONE_K: ImageSize[] = [
  { width: 1024, height: 1024 },
  { width: 1152, height: 864 },
  { width: 864, height: 1152 },
  { width: 1248, height: 832 },
  { width: 832, height: 1248 },
  { width: 1280, height: 720 },
  { width: 720, height: 1280 },
];
// capybara:allow-module-state read-only size list
const WITH_1K: ImageSize[] = [...ONE_K, ...TWO_K];

const seedream = (sizes: ImageSize[], maxReferenceImages: number): ModelImageGenerationInfo => ({
  sizes,
  defaultSize: { width: 2048, height: 2048 },
  maxImages: 1,
  maxReferenceImages,
  outputMediaTypes: ["image/jpeg", "image/png"],
});

/** Families by id prefix; longer prefixes first (`5-0-flash` before `5-0`). */
// capybara:allow-module-state read-only family table; callers get copies
const IMAGE_FAMILIES: [string, ModelImageGenerationInfo][] = [
  ["doubao-seedream-5-5-", seedream(WITH_1K, 10)],
  ["doubao-seedream-5-0-flash-", seedream(WITH_1K, 10)],
  ["doubao-seedream-5-0-pro-", seedream(WITH_1K, 10)],
  ["doubao-seedream-5-0-", seedream(TWO_K, 10)],
  ["doubao-seedream-4-5-", seedream(TWO_K, 14)],
  ["doubao-seedream-4-0-", seedream(WITH_1K, 14)],
];

/** The bundled image facts of a model id (a copy), or undefined for an unknown model. */
export function imageGenerationInfo(id: string): ModelImageGenerationInfo | undefined {
  const info = IMAGE_FAMILIES.find(([prefix]) => id.startsWith(prefix))?.[1];
  return info === undefined ? undefined : structuredClone(info);
}
