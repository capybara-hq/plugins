import { createHash } from "node:crypto";
import type { ModelRequest } from "@capybara-hq/plugin-sdk";

/**
 * `prompt_cache_key` of the ark dialect (the same as plugins/ark): routing affinity for Ark's
 * implicit context cache, so requests sharing a prefix tend to reach the same cache; it never
 * switches caching on or off. Volcengine's
 * guidance (https://docs.volcengine.com/docs/ark/context-cache, read 2026-11-27): one value for
 * the requests of one continuous context, different values for different users or parallel
 * sessions, about 15 requests per minute per value at most, and no personal data or raw prompt
 * text in it. The request carries no conversation id, so the key is a hash of what stays fixed
 * for a conversation under append-only history: the org, the model, the system prompt and the
 * first message. Each conversation gets its own value; a compaction that rewrites the head
 * starts a new one, as its prefix is new too. Tools are left out so a tool added mid-conversation
 * keeps the routing. Pure.
 */
export function conversationCacheKey(req: ModelRequest, orgId: string | undefined): string {
  const head = JSON.stringify([
    orgId ?? "",
    req.model,
    req.system.map((s) => s.text),
    req.messages[0] ?? null,
  ]);
  return `cap-${createHash("sha256").update(head).digest("hex").slice(0, 32)}`;
}
