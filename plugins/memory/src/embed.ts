import type { ExtensionContext } from "@capybara-hq/plugin-sdk";
import { sql } from "kysely";
import { getByIds, type MemoryRow, type Owner } from "./store.js";

/**
 * Memory vectors. A memory is embedded with the org's model for the purpose `memory.embed` (mapped
 * by org admins; no model = keyword search only). The `embedding` column is `vector` (pgvector) or
 * `real[]`, fixed when the migration ran; which one is read from the column itself, never from
 * whether pgvector is installed now. Vectors have no fixed dimension, so only vectors of the
 * current model are ever compared; older ones are re-embedded by the `memory-embed` queue.
 */

type Db = ExtensionContext["db"];

/** What the embedding and search code uses of `ctx`. */
export type MemoryDeps = Pick<ExtensionContext, "db" | "models" | "queue">;

/** The model purpose the plugin declares (`permissions.models`). */
export const EMBED_PURPOSE = "memory.embed";
/** The queue that (re-)embeds one memory. */
export const EMBED_QUEUE = "memory-embed";
/** Delay before a failed embedding is retried through the queue. */
export const EMBED_RETRY_DELAY_MS = 30_000;
/** Semantic neighbours kept per memory, and the cosine similarity they need. */
export const NEIGHBOR_COUNT = 3;
export const NEIGHBOR_MIN_SCORE = 0.75;

/** A `memory-embed` job: the owner (every query filters on it) and the memory. */
export interface EmbedJob extends Owner {
  memoryId: string;
}

/** `provider/id`, as stored in `embedding_model`. */
export const modelKey = (m: { provider: string; id: string }): string => `${m.provider}/${m.id}`;

/** The job id of a memory's embedding job (no `:`; one pending job per memory). */
export const embedJobId = (memoryId: string): string => `memory-embed-${memoryId}`;

/** The text a memory's vector is made from. */
export const documentText = (row: Pick<MemoryRow, "description" | "body">): string =>
  `${row.description}\n${row.body}`;

function errorCode(e: unknown): string | undefined {
  if (typeof e !== "object" || e === null || !("code" in e)) return undefined;
  return typeof e.code === "string" ? e.code : undefined;
}

/**
 * Errors a retry cannot fix: no model mapped for the org, or a policy hook refused the text. The
 * memory stays without a vector (keyword search still finds it); a later search re-embeds it once
 * a model is mapped.
 */
export const isPermanentEmbedError = (e: unknown): boolean => {
  const code = errorCode(e);
  return code === "model.unconfigured" || code === "model.hook_denied";
};

/** Enqueues (re-)embedding a memory; one job per memory at a time (deterministic job id). */
export async function enqueueEmbed(
  queue: MemoryDeps["queue"],
  owner: Owner,
  memoryId: string,
  delayMs?: number,
): Promise<void> {
  const data: EmbedJob = {
    orgId: owner.orgId,
    agentId: owner.agentId,
    accountId: owner.accountId,
    memoryId,
  };
  await queue.add(EMBED_QUEUE, data, {
    jobId: embedJobId(memoryId),
    ...(delayMs === undefined ? {} : { delayMs }),
  });
}

/** The embedding column's type: `vector` or `array` (`real[]`); null when the owner has no rows. */
export async function embeddingColumn(db: Db, owner: Owner): Promise<"vector" | "array" | null> {
  // pg_typeof reports the declared column type for any row, a null embedding included
  const row = await db
    .selectFrom("memories")
    .select(sql<string>`pg_typeof(embedding)::text`.as("t"))
    .where("org_id", "=", owner.orgId)
    .where("agent_id", "=", owner.agentId)
    .where("account_id", "=", owner.accountId)
    .limit(1)
    .executeTakeFirst();
  if (row === undefined) return null;
  return row.t.endsWith("[]") ? "array" : "vector";
}

function literal(vector: number[], column: "vector" | "array") {
  const values = vector.map((x) => (Number.isFinite(x) ? x : 0)).join(",");
  return column === "vector" ? sql`${`[${values}]`}::vector` : sql`${`{${values}}`}::real[]`;
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}

/**
 * The owner's memories nearest to `vector` among those embedded with `model` (same dimension), by
 * cosine similarity, best first, at most `k`, excluding `exceptId`. With pgvector the database
 * ranks (`<=>`); with `real[]` the plugin does, over the owner's rows (at most 1,000).
 */
export async function nearest(
  db: Db,
  owner: Owner,
  vector: number[],
  model: string,
  k: number,
  exceptId?: string,
): Promise<{ id: string; score: number }[]> {
  const column = await embeddingColumn(db, owner);
  if (column === null) return [];
  let q = db
    .selectFrom("memories")
    .where("org_id", "=", owner.orgId)
    .where("agent_id", "=", owner.agentId)
    .where("account_id", "=", owner.accountId)
    .where("embedding_model", "=", model)
    .where("embedding", "is not", null);
  if (exceptId !== undefined) q = q.where("id", "!=", exceptId);
  if (column === "vector") {
    const v = literal(vector, "vector");
    const rows = await q
      .where(sql<boolean>`vector_dims(embedding) = ${vector.length}`)
      .select(["id", sql<number>`1 - (embedding <=> ${v})`.as("score")])
      .orderBy(sql`embedding <=> ${v}`)
      .orderBy("id")
      .limit(k)
      .execute();
    return rows.map((r) => ({ id: r.id as string, score: Number(r.score) }));
  }
  const rows = await q
    .where(sql<boolean>`cardinality(embedding) = ${vector.length}`)
    .select(["id", sql<number[]>`embedding`.as("embedding")])
    .execute();
  return rows
    .map((r) => ({
      id: r.id as string,
      score: cosine(vector, (r.embedding as number[]).map(Number)),
    }))
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .slice(0, k);
}

/** Recomputes the semantic neighbours of one memory (both directions) from its vector. */
async function updateNeighbors(
  db: Db,
  owner: Owner,
  memoryId: string,
  vector: number[],
  model: string,
): Promise<void> {
  const near = (await nearest(db, owner, vector, model, NEIGHBOR_COUNT, memoryId)).filter(
    (n) => n.score >= NEIGHBOR_MIN_SCORE,
  );
  await db.transaction().execute(async (trx) => {
    await trx
      .deleteFrom("memory_neighbors")
      .where((eb) => eb.or([eb("memory_id", "=", memoryId), eb("neighbor_id", "=", memoryId)]))
      .execute();
    if (near.length === 0) return;
    await trx
      .insertInto("memory_neighbors")
      .values(
        near.flatMap((n) => [
          { memory_id: memoryId, neighbor_id: n.id, score: n.score },
          { memory_id: n.id, neighbor_id: memoryId, score: n.score },
        ]),
      )
      .onConflict((oc) =>
        oc.columns(["memory_id", "neighbor_id"]).doUpdateSet((eb) => ({
          score: eb.ref("excluded.score"),
        })),
      )
      .execute();
  });
}

/**
 * Embeds `row` now and stores the vector and its neighbours. The vector is stored only while the
 * memory's text is still the text that was embedded (a concurrent write re-embeds on its own).
 * Throws what `ctx.models.embed` throws.
 */
export async function computeEmbedding(
  ctx: MemoryDeps,
  owner: Owner,
  row: MemoryRow,
  signal?: AbortSignal,
): Promise<void> {
  const res = await ctx.models.embed({
    orgId: owner.orgId,
    purpose: EMBED_PURPOSE,
    input: [documentText(row)],
    inputType: "document",
    ...(signal === undefined ? {} : { signal }),
  });
  const vector = res.vectors[0];
  if (vector === undefined || vector.length === 0) return;
  const model = modelKey(res.model);
  const column = await embeddingColumn(ctx.db, owner);
  if (column === null) return;
  const updated = await ctx.db
    .updateTable("memories")
    .set({ embedding: literal(vector, column), embedding_model: model })
    .where("org_id", "=", owner.orgId)
    .where("agent_id", "=", owner.agentId)
    .where("account_id", "=", owner.accountId)
    .where("id", "=", row.id)
    .where("description", "=", row.description)
    .where("body", "=", row.body)
    .executeTakeFirst();
  if (Number(updated.numUpdatedRows) === 0) return;
  await updateNeighbors(ctx.db, owner, row.id, vector, model);
}

/**
 * Embeds a memory after a write. No model mapped (or a policy refusal) leaves it without a vector,
 * silently; any other failure enqueues a retry in {@link EMBED_RETRY_DELAY_MS}.
 */
export async function embedMemory(
  ctx: MemoryDeps,
  owner: Owner,
  row: MemoryRow,
  opts: { signal?: AbortSignal } = {},
): Promise<void> {
  try {
    await computeEmbedding(ctx, owner, row, opts.signal);
  } catch (e) {
    if (isPermanentEmbedError(e)) return;
    await enqueueEmbed(ctx.queue, owner, row.id, EMBED_RETRY_DELAY_MS);
  }
}

/**
 * The `memory-embed` job: (re-)embeds the memory unless it is gone or already has a vector of the
 * org's current model. Idempotent. A provider failure throws, so the queue retries the job.
 */
export async function runEmbedJob(ctx: MemoryDeps, job: EmbedJob): Promise<void> {
  const owner: Owner = { orgId: job.orgId, agentId: job.agentId, accountId: job.accountId };
  const [row] = await getByIds(ctx.db, owner, [job.memoryId]);
  if (row === undefined) return;
  const target = await ctx.models.describe({ orgId: owner.orgId, purpose: EMBED_PURPOSE });
  if (target === null) return;
  if (row.embedding !== null && row.embeddingModel === modelKey(target)) return;
  try {
    await computeEmbedding(ctx, owner, row);
  } catch (e) {
    if (isPermanentEmbedError(e)) return;
    throw e;
  }
}
