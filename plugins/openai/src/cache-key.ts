import { createHash } from "node:crypto";

/**
 * `prompt_cache_key` (https://developers.openai.com/api/docs/guides/prompt-caching, read
 * 2026-11-27). Before GPT-5.6 it helps route related requests to the same cache and separates
 * cache reuse between groups of requests; from GPT-5.6 routing is automatic and separate keys
 * keep cache accounting apart and prevent cache-hit probing across users. The key is a hash of
 * the org and the system prompt (`instructions`): every conversation of one agent in one org
 * shares the system and tools prefix, so they stay one group and keep reusing it, while orgs
 * that share an API key never share or probe each other's entries. A per-conversation key would
 * split that shared prefix into one cache write per conversation. The request carries nothing
 * identifying in clear. Pure.
 */
export function promptCacheKey(orgId: string | undefined, instructions: string): string {
  const head = JSON.stringify([orgId ?? "", instructions]);
  return `cap-${createHash("sha256").update(head).digest("hex").slice(0, 32)}`;
}
