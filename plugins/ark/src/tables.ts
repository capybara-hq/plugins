import type { ModelEmbeddingInfo } from "@capybara-hq/plugin-sdk";

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
export const EMBEDDING_MODELS: Record<string, ModelEmbeddingInfo> = {
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
