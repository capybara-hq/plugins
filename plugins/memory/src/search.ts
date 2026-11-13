import type { ExtensionContext } from "@capybara-hq/plugin-sdk";
import { sql } from "kysely";
import { EMBED_PURPOSE, enqueueEmbed, type MemoryDeps, modelKey, nearest } from "./embed.js";
import { segment } from "./segment.js";
import { getByIds, type MemoryRow, type Owner, touch } from "./store.js";

/**
 * Hybrid search over one owner's memories. Keyword: the query's tokens (the same segmentation as
 * the stored `tokens`), any of them matching, ranked by `ts_rank`. Semantic, when the org maps a
 * model to `memory.embed`: cosine similarity to the query's vector among vectors of that model.
 * The two rankings are merged by reciprocal rank fusion; ties go to the more recently updated.
 * Each returned hit counts as a recall.
 */

type Db = ExtensionContext["db"];

/** Most hits one search returns. */
export const MAX_SEARCH_LIMIT = 20;
/** Candidates taken from each ranking before fusion. */
const CANDIDATES = 50;
/** Reciprocal rank fusion constant. */
const RRF_K = 60;
/**
 * Least cosine similarity for a vector-only candidate: below it a memory is unrelated, and listing
 * it would only fill the hits with noise.
 */
export const MIN_SIMILARITY = 0.3;
/** Most stale memories one search enqueues for re-embedding. */
const STALE_BATCH = 20;
/** Longest snippet, in characters. */
export const SNIPPET_LENGTH = 200;

export interface SearchHit {
  row: MemoryRow;
  snippet: string;
  score: number;
}

async function keywordRank(db: Db, owner: Owner, tokens: string[]): Promise<string[]> {
  if (tokens.length === 0) return [];
  // any token may match: OR of one plain query per token (plainto_tsquery treats text as text)
  const q = sql.join(
    tokens.map((t) => sql`plainto_tsquery('simple', ${t})`),
    sql` || `,
  );
  const rows = await db
    .selectFrom("memories")
    .select(["id", sql<number>`ts_rank(tokens, ${q})`.as("rank")])
    .where("org_id", "=", owner.orgId)
    .where("agent_id", "=", owner.agentId)
    .where("account_id", "=", owner.accountId)
    .where(sql<boolean>`tokens @@ (${q})`)
    .orderBy("rank", "desc")
    .orderBy("updated_at", "desc")
    .orderBy("id")
    .limit(CANDIDATES)
    .execute();
  return rows.map((r) => r.id as string);
}

/** Enqueues re-embedding of the owner's memories without a vector of `model` (a few per search). */
async function enqueueStale(ctx: MemoryDeps, owner: Owner, model: string): Promise<void> {
  const stale = await ctx.db
    .selectFrom("memories")
    .select("id")
    .where("org_id", "=", owner.orgId)
    .where("agent_id", "=", owner.agentId)
    .where("account_id", "=", owner.accountId)
    .where((eb) =>
      eb.or([eb("embedding", "is", null), eb("embedding_model", "is distinct from", model)]),
    )
    .orderBy("updated_at", "desc")
    .orderBy("id")
    .limit(STALE_BATCH)
    .execute();
  for (const { id } of stale) await enqueueEmbed(ctx.queue, owner, id as string);
}

async function semanticRank(
  ctx: MemoryDeps,
  owner: Owner,
  query: string,
  signal?: AbortSignal,
): Promise<string[]> {
  let vector: number[] | undefined;
  let model: string;
  try {
    const res = await ctx.models.embed({
      orgId: owner.orgId,
      purpose: EMBED_PURPOSE,
      input: [query],
      inputType: "query",
      ...(signal === undefined ? {} : { signal }),
    });
    vector = res.vectors[0];
    model = modelKey(res.model);
  } catch {
    // no model mapped, or the model failed: keyword search alone still answers
    return [];
  }
  if (vector === undefined || vector.length === 0) return [];
  await enqueueStale(ctx, owner, model);
  const near = await nearest(ctx.db, owner, vector, model, CANDIDATES);
  return near.filter((n) => n.score >= MIN_SIMILARITY).map((n) => n.id);
}

/** About {@link SNIPPET_LENGTH} characters of the body around the first query token, on one line. */
function snippetOf(row: MemoryRow, tokens: string[]): string {
  const text = row.body.replace(/\s+/g, " ").trim() || row.description;
  if (text.length <= SNIPPET_LENGTH) return text;
  const lower = text.toLowerCase();
  let at = -1;
  for (const t of tokens) {
    const i = lower.indexOf(t);
    if (i !== -1 && (at === -1 || i < at)) at = i;
  }
  const start = at === -1 ? 0 : Math.max(0, at - Math.floor(SNIPPET_LENGTH / 3));
  const end = Math.min(text.length, start + SNIPPET_LENGTH);
  let s = text.slice(start, end);
  if (start > 0) s = `…${s.slice(1)}`;
  if (end < text.length) s = `${s.slice(0, -1)}…`;
  return s;
}

/**
 * Searches the owner's memories for `query`; at most `limit` hits (1 to {@link MAX_SEARCH_LIMIT}),
 * best first. Never errors for lack of a model: keyword search alone answers then.
 */
export async function search(
  ctx: MemoryDeps,
  db: Db,
  owner: Owner,
  query: string,
  limit: number,
  opts: { signal?: AbortSignal } = {},
): Promise<SearchHit[]> {
  const n = Math.max(1, Math.min(MAX_SEARCH_LIMIT, Math.floor(limit) || 1));
  const tokens = [...new Set(segment(query))];
  const [keyword, semantic] = await Promise.all([
    keywordRank(db, owner, tokens),
    query.trim() === ""
      ? Promise.resolve([])
      : semanticRank({ ...ctx, db }, owner, query, opts.signal),
  ]);
  const scores = new Map<string, number>();
  for (const ranking of [keyword, semantic]) {
    for (const [i, id] of ranking.entries()) {
      scores.set(id, (scores.get(id) ?? 0) + 1 / (RRF_K + i + 1));
    }
  }
  if (scores.size === 0) return [];
  const rows = await getByIds(db, owner, [...scores.keys()]);
  const hits = rows
    .map((row) => ({ row, score: scores.get(row.id) ?? 0 }))
    .sort(
      (a, b) =>
        b.score - a.score ||
        b.row.updatedAt.getTime() - a.row.updatedAt.getTime() ||
        a.row.path.localeCompare(b.row.path),
    )
    .slice(0, n)
    .map((h) => ({ ...h, snippet: snippetOf(h.row, tokens) }));
  await touch(
    db,
    owner,
    hits.map((h) => h.row.id),
  );
  return hits;
}
