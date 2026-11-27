import type { CacheWriteByTtl, ModelCacheInfo } from "@capybara-hq/plugin-sdk";

/** The 5-minute and 1-hour lifetimes `cache_control.ttl` offers, in seconds. */
export const TTL_5M = 300;
export const TTL_1H = 3600;

/**
 * Minimum cacheable prompt length per model id (tokens), from the prompt caching page's "Cache
 * limitations" and confirmed live at the 512 boundary on 2026-11-28 (idle compaction spec §9.1).
 * Shorter prompts are silently not cached.
 */
export const MinTokens: Readonly<Record<string, number>> = {
  "claude-fable-5-2": 512,
  "claude-fable-5-1": 512,
  "claude-fable-5": 512,
  "claude-opus-5-5": 512,
  "claude-opus-5": 512,
  "claude-sonnet-5-5": 512,
  "claude-haiku-5-5": 512,
  "claude-mythos-5": 512,
  "claude-mythos-5-1": 512,
  "claude-mythos-5-2": 512,
  "claude-opus-4-8": 1024,
  "claude-sonnet-5": 1024,
  "claude-sonnet-4-6": 1024,
  "claude-sonnet-4-5": 1024,
  "claude-opus-4-1": 1024,
  "claude-opus-4": 1024,
  "claude-sonnet-4": 1024,
  "claude-opus-4-7": 2048,
  "claude-mythos-preview": 2048,
  "claude-opus-4-6": 4096,
  "claude-opus-4-5-20251101": 4096,
  "claude-haiku-4-5-20251001": 4096,
};

/** The largest minimum, for an id not in the table: a prompt below it is never assumed cached. */
const UNKNOWN_MIN_TOKENS = 4096;

export const minTokensOf = (id: string): number => MinTokens[id] ?? UNKNOWN_MIN_TOKENS;

/** The prompt cache every model declares: explicit breakpoints, 5 minutes or 1 hour. */
export function cacheInfoOf(id: string): ModelCacheInfo {
  return {
    mechanism: "explicit",
    ttlOptions: [TTL_5M, TTL_1H],
    defaultTtl: TTL_5M,
    ttlIsMinimum: false,
    refreshOnHit: true,
    ttlClock: "request_start",
    minTokens: minTokensOf(id),
    guaranteed: true,
  };
}

/** The `cache_control` marker for a request's ttl: `ttl: "1h"` only for 3600, else the default. */
export function cacheControlOf(cacheTtl: number | undefined): {
  type: "ephemeral";
  ttl?: "1h";
} {
  return cacheTtl === TTL_1H ? { type: "ephemeral", ttl: "1h" } : { type: "ephemeral" };
}

/** `usage.cache_creation` → per-TTL writes, zero entries left out; undefined without a split. */
export function writeByTtlOf(
  split:
    | { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number }
    | null
    | undefined,
): CacheWriteByTtl[] | undefined {
  if (!split) return undefined;
  const out: CacheWriteByTtl[] = [];
  if ((split.ephemeral_5m_input_tokens ?? 0) > 0) {
    out.push({ ttl: TTL_5M, tokens: split.ephemeral_5m_input_tokens as number });
  }
  if ((split.ephemeral_1h_input_tokens ?? 0) > 0) {
    out.push({ ttl: TTL_1H, tokens: split.ephemeral_1h_input_tokens as number });
  }
  return out.length > 0 ? out : undefined;
}
