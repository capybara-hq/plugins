import type { CacheWriteByTtl, ModelCacheInfo } from "@capybara-hq/plugin-sdk";

/** Seconds of the two `prompt_cache_options.ttl` values GPT-5.6+ accepts. */
const TTL_30M = 1800;
const TTL_12H = 43200;

/**
 * Whether a model id is GPT-5.6 or later (`gpt-<major>[.<minor>]…` with a numeric version of at
 * least 5.6). Only these models accept `prompt_cache_options` (gpt-5.5 answers 400) and report
 * the write split by tier (https://developers.openai.com/api/docs/guides/prompt-caching, read
 * 2026-11-28). `gpt-5-nano` and `gpt-5-mini` are version 5.0.
 */
export function acceptsCacheOptions(modelId: string): boolean {
  const m = /^gpt-(\d+)(?:\.(\d+))?(?!\d)/.exec(modelId);
  if (m?.[1] === undefined) return false;
  const major = Number(m[1]);
  const minor = Number(m[2] ?? 0);
  return major > 5 || (major === 5 && minor >= 6);
}

/**
 * The prompt cache a chat model declares. GPT-5.6+ caches implicitly with a lifetime floor of 30
 * minutes (a read keeps that tier alive) or 12 hours (a read does not restart it, and the kernel
 * never selects it); earlier models cache by prefix with no lifetime to rely on.
 */
export function cacheInfo(modelId: string): ModelCacheInfo {
  if (acceptsCacheOptions(modelId)) {
    return {
      mechanism: "implicit",
      ttlOptions: [TTL_30M, TTL_12H],
      defaultTtl: TTL_30M,
      ttlIsMinimum: true,
      refreshOnHit: true,
      ttlClock: "unknown",
      minTokens: 1024,
      guaranteed: true,
    };
  }
  return {
    mechanism: "implicit",
    ttlOptions: [],
    ttlIsMinimum: false,
    refreshOnHit: false,
    ttlClock: "unknown",
    minTokens: 1024,
    guaranteed: false,
  };
}

/** `cacheTtl` -> the request's `prompt_cache_options`; none for an unknown ttl or an older model. */
export function cacheOptions(
  modelId: string,
  cacheTtl: number | undefined,
): { ttl: "30m" | "12h" } | undefined {
  if (cacheTtl === undefined || !acceptsCacheOptions(modelId)) return undefined;
  if (cacheTtl === TTL_30M) return { ttl: "30m" };
  if (cacheTtl === TTL_12H) return { ttl: "12h" };
  return undefined;
}

/** The usage's `cache_write_tokens_details` -> `cacheWriteByTtl` (zero entries left out). */
export function cacheWriteByTtl(
  details: { ttl_30m_tokens?: number; ttl_12h_tokens?: number } | null | undefined,
): CacheWriteByTtl[] | undefined {
  if (details == null) return undefined;
  const out: CacheWriteByTtl[] = [];
  if ((details.ttl_30m_tokens ?? 0) > 0)
    out.push({ ttl: TTL_30M, tokens: details.ttl_30m_tokens ?? 0 });
  if ((details.ttl_12h_tokens ?? 0) > 0)
    out.push({ ttl: TTL_12H, tokens: details.ttl_12h_tokens ?? 0 });
  return out.length > 0 ? out : undefined;
}
