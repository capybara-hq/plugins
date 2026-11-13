import { type ExtensionContext, ToolError } from "@capybara-hq/plugin-sdk";
import { sql } from "kysely";
import { MEMORY_TYPES, type MemoryType, parseLinks, parsePath } from "./paths.js";
import { segmentMemory } from "./segment.js";

/**
 * Memory rows. Every function takes the owner first and filters on all three of its ids: a memory
 * is never read, changed or linked across (org, agent, member). Callers take the owner from the
 * call context, never from model input.
 */

type Db = ExtensionContext["db"];

/** Whose memories: one agent and one member in one org. */
export interface Owner {
  orgId: string;
  agentId: string;
  accountId: string;
}

/** A memory as the plugin uses it (the row without its search tokens). */
export interface MemoryRow {
  id: string;
  orgId: string;
  agentId: string;
  accountId: string;
  path: string;
  type: MemoryType;
  description: string;
  body: string;
  embedding: number[] | null;
  embeddingModel: string | null;
  recallCount: number;
  lastRecalledAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  /** The conversation the memory was first written in. */
  createdIn: string | null;
}

/** Longest description, in characters. */
export const MAX_DESCRIPTION_LENGTH = 200;
/** Largest body, in UTF-8 bytes. */
export const MAX_BODY_BYTES = 8 * 1024;
/** Most memories one (org, agent, member) keeps. */
export const MAX_MEMORIES_PER_OWNER = 1000;

/**
 * A store refusal whose message is written for the model (English, says what to do). It is a
 * {@link ToolError}, so a tool handler lets it through and the model gets the message as is.
 */
export class MemoryError extends ToolError {}

/** The path is not a valid memory path. */
export class MemoryPathError extends MemoryError {}

/** A limit was exceeded: description, body or the per-owner count. */
export class MemoryLimitError extends MemoryError {}

/** No memory at that path for this owner. */
export class MemoryNotFoundError extends MemoryError {
  constructor(path: string) {
    super(
      `No memory at "${path}". Use plugin__memory__view with "/" to list memories or plugin__memory__search to find one.`,
    );
  }
}

/** `old` did not occur exactly once in the body. */
export class MemoryEditError extends MemoryError {
  constructor(
    path: string,
    readonly count: number,
  ) {
    super(
      count === 0
        ? `The text to replace was not found in "${path}". View the memory and copy the exact text, including whitespace.`
        : `The text to replace occurs ${count} times in "${path}"; it must occur exactly once. Include more surrounding text to make it unique.`,
    );
  }
}

function normalisePath(path: string): { path: string; type: MemoryType } {
  const p = parsePath(path);
  if (!p.ok) throw new MemoryPathError(p.error);
  return { path: p.path, type: p.type };
}

function checkDescription(description: string): string {
  const d = description.trim();
  if (d === "") {
    throw new MemoryLimitError(
      "The description is empty; give a one-line summary that tells when this memory is relevant.",
    );
  }
  if (/[\r\n]/.test(d)) {
    throw new MemoryLimitError(
      "The description must be one line; put details in the body and keep the description a short summary.",
    );
  }
  if (d.length > MAX_DESCRIPTION_LENGTH) {
    throw new MemoryLimitError(
      `The description is ${d.length} characters; keep it under ${MAX_DESCRIPTION_LENGTH} and move details into the body.`,
    );
  }
  return d;
}

function checkBody(body: string): void {
  const bytes = Buffer.byteLength(body, "utf8");
  if (bytes > MAX_BODY_BYTES) {
    throw new MemoryLimitError(
      `The body is ${bytes} bytes; a memory holds at most ${MAX_BODY_BYTES} bytes (UTF-8). Keep one fact per memory: split it into several memories or shorten it.`,
    );
  }
}

/** Parses an embedding read as text: pgvector prints `[1,2]`, a `real[]` prints `{1,2}`. */
function parseEmbedding(text: string | null): number[] | null {
  if (text === null) return null;
  const inner = text.slice(1, -1).trim();
  return inner === "" ? [] : inner.split(",").map(Number);
}

/** The selected columns of a {@link MemoryRow}, with the owner filter applied by the caller. */
// capybara:allow-module-state read-only column list
const COLUMNS = [
  "id",
  "org_id",
  "agent_id",
  "account_id",
  "path",
  "type",
  "description",
  "body",
  "embedding_model",
  "recall_count",
  "last_recalled_at",
  "created_at",
  "updated_at",
  "created_in",
] as const;

// biome-ignore lint/suspicious/noExplicitAny: the plugin's tables have no Kysely schema type
type Raw = Record<string, any>;

function toRow(r: Raw): MemoryRow {
  return {
    id: r.id,
    orgId: r.org_id,
    agentId: r.agent_id,
    accountId: r.account_id,
    path: r.path,
    type: r.type,
    description: r.description,
    body: r.body,
    embedding: parseEmbedding(r.embedding_text ?? null),
    embeddingModel: r.embedding_model,
    recallCount: r.recall_count,
    lastRecalledAt: r.last_recalled_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    createdIn: r.created_in,
  };
}

/** Selects memories of one owner (all three ids), with the embedding as text. */
function selectOwned(db: Db, owner: Owner) {
  return db
    .selectFrom("memories")
    .select([...COLUMNS, sql<string | null>`embedding::text`.as("embedding_text")])
    .where("org_id", "=", owner.orgId)
    .where("agent_id", "=", owner.agentId)
    .where("account_id", "=", owner.accountId);
}

/** The keyword search tokens of a memory, as a `simple` tsvector expression. */
function tokensOf(m: { path: string; description: string; body: string }) {
  return sql`to_tsvector('simple', ${segmentMemory(m).join(" ")})`;
}

/** Serialises writes of one owner (the per-owner cap and the link rows) within a transaction. */
async function lockOwner(trx: Db, owner: Owner): Promise<void> {
  const key = JSON.stringify(["memory", owner.orgId, owner.agentId, owner.accountId]);
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`.execute(trx);
}

async function replaceLinks(trx: Db, memoryId: string, body: string): Promise<void> {
  await trx.deleteFrom("memory_links").where("memory_id", "=", memoryId).execute();
  const links = parseLinks(body);
  if (links.length === 0) return;
  await trx
    .insertInto("memory_links")
    .values(links.map((to_path) => ({ memory_id: memoryId, to_path })))
    .onConflict((oc) => oc.doNothing())
    .execute();
}

/** A changed text makes the vector and the neighbours derived from it stale. */
async function dropDerived(trx: Db, memoryId: string): Promise<void> {
  await trx
    .deleteFrom("memory_neighbors")
    .where((eb) => eb.or([eb("memory_id", "=", memoryId), eb("neighbor_id", "=", memoryId)]))
    .execute();
}

/**
 * The owner's memories, by path; with `dir`, only those under that directory (`/` or empty = all).
 * The directory is compared as a literal prefix, so `%` or `_` match only themselves.
 */
export async function list(db: Db, owner: Owner, dir?: string): Promise<MemoryRow[]> {
  let q = selectOwned(db, owner);
  const d = (dir ?? "")
    .trim()
    .replace(/[A-Z]/g, (c) => c.toLowerCase())
    .replace(/^\/+|\/+$/g, "");
  if (d !== "") {
    const prefix = `${d}/`;
    q = q.where(sql<boolean>`left(path, ${prefix.length}) = ${prefix}`);
  }
  const rows = await q.orderBy("path").execute();
  return rows.map(toRow);
}

/** The owner's memory at `path` (normalised like {@link parsePath}), or null. */
export async function get(db: Db, owner: Owner, path: string): Promise<MemoryRow | null> {
  const p = parsePath(path);
  if (!p.ok) return null;
  const row = await selectOwned(db, owner).where("path", "=", p.path).executeTakeFirst();
  return row === undefined ? null : toRow(row);
}

/**
 * Creates or replaces the owner's memory at `path`. A replacement keeps the id, the recall
 * statistics and `created_in`, and drops the vector (the text changed). Links are re-parsed.
 * Throws {@link MemoryPathError} / {@link MemoryLimitError}.
 */
export async function put(
  db: Db,
  owner: Owner,
  input: { path: string; description: string; body: string; conversationId: string | null },
): Promise<{ row: MemoryRow; created: boolean }> {
  const { path, type } = normalisePath(input.path);
  const description = checkDescription(input.description);
  checkBody(input.body);
  return db.transaction().execute(async (trx) => {
    await lockOwner(trx, owner);
    const existing = await trx
      .selectFrom("memories")
      .select("id")
      .where("org_id", "=", owner.orgId)
      .where("agent_id", "=", owner.agentId)
      .where("account_id", "=", owner.accountId)
      .where("path", "=", path)
      .executeTakeFirst();
    if (existing === undefined) {
      const { n } = await trx
        .selectFrom("memories")
        .select((eb) => eb.fn.countAll<string>().as("n"))
        .where("org_id", "=", owner.orgId)
        .where("agent_id", "=", owner.agentId)
        .where("account_id", "=", owner.accountId)
        .executeTakeFirstOrThrow();
      if (Number(n) >= MAX_MEMORIES_PER_OWNER) {
        throw new MemoryLimitError(
          `There are already ${MAX_MEMORIES_PER_OWNER} memories, the limit for this agent and member. Consolidate before writing a new one: merge related memories into one with plugin__memory__edit and delete outdated ones with plugin__memory__delete, or update an existing memory instead.`,
        );
      }
      const { id } = await trx
        .insertInto("memories")
        .values({
          org_id: owner.orgId,
          agent_id: owner.agentId,
          account_id: owner.accountId,
          path,
          type,
          description,
          body: input.body,
          tokens: tokensOf({ path, description, body: input.body }),
          created_in: input.conversationId,
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      await replaceLinks(trx, id, input.body);
      const row = await selectOwned(trx, owner).where("id", "=", id).executeTakeFirstOrThrow();
      return { row: toRow(row), created: true };
    }
    await trx
      .updateTable("memories")
      .set({
        description,
        body: input.body,
        tokens: tokensOf({ path, description, body: input.body }),
        embedding: null,
        embedding_model: null,
        updated_at: sql`now()`,
      })
      .where("id", "=", existing.id)
      .execute();
    await dropDerived(trx, existing.id);
    await replaceLinks(trx, existing.id, input.body);
    const row = await selectOwned(trx, owner)
      .where("id", "=", existing.id)
      .executeTakeFirstOrThrow();
    return { row: toRow(row), created: false };
  });
}

/**
 * Replaces the one occurrence of `old` in the body of the owner's memory at `path` with `next`, and
 * the description when given. Throws {@link MemoryNotFoundError}, {@link MemoryEditError} (with the
 * number of occurrences), {@link MemoryPathError} or {@link MemoryLimitError}.
 */
export async function edit(
  db: Db,
  owner: Owner,
  path: string,
  old: string,
  next: string,
  description?: string,
): Promise<MemoryRow> {
  const p = normalisePath(path);
  const newDescription = description === undefined ? undefined : checkDescription(description);
  return db.transaction().execute(async (trx) => {
    await lockOwner(trx, owner);
    const row = await selectOwned(trx, owner).where("path", "=", p.path).executeTakeFirst();
    if (row === undefined) throw new MemoryNotFoundError(p.path);
    const body: string = row.body;
    const count = old === "" ? 0 : body.split(old).length - 1;
    if (count !== 1) throw new MemoryEditError(p.path, count);
    const at = body.indexOf(old);
    const nextBody = body.slice(0, at) + next + body.slice(at + old.length);
    checkBody(nextBody);
    await trx
      .updateTable("memories")
      .set({
        body: nextBody,
        ...(newDescription === undefined ? {} : { description: newDescription }),
        tokens: tokensOf({
          path: p.path,
          description: newDescription ?? row.description,
          body: nextBody,
        }),
        embedding: null,
        embedding_model: null,
        updated_at: sql`now()`,
      })
      .where("id", "=", row.id)
      .execute();
    await dropDerived(trx, row.id);
    await replaceLinks(trx, row.id, nextBody);
    const updated = await selectOwned(trx, owner)
      .where("id", "=", row.id)
      .executeTakeFirstOrThrow();
    return toRow(updated);
  });
}

/** One line of the memory index. */
export interface IndexEntry {
  path: string;
  type: MemoryType;
  description: string;
}

/**
 * The owner's memories for the index, in index order: by type (user, feedback, project,
 * reference), then most recalled first, then by path. Only stable fields: no timestamps.
 */
export async function indexEntries(db: Db, owner: Owner): Promise<IndexEntry[]> {
  const rows = await db
    .selectFrom("memories")
    .select(["path", "type", "description"])
    .where("org_id", "=", owner.orgId)
    .where("agent_id", "=", owner.agentId)
    .where("account_id", "=", owner.accountId)
    .orderBy(sql`array_position(${sql.val([...MEMORY_TYPES])}::text[], type)`)
    .orderBy("recall_count", "desc")
    .orderBy(sql`path COLLATE "C"`)
    .execute();
  return rows.map((r) => ({ path: r.path, type: r.type, description: r.description }));
}

/** The owner's memories with these ids (others' ids are ignored), in no particular order. */
export async function getByIds(db: Db, owner: Owner, ids: string[]): Promise<MemoryRow[]> {
  if (ids.length === 0) return [];
  const rows = await selectOwned(db, owner).where("id", "in", ids).execute();
  return rows.map(toRow);
}

/** Deletes the owner's memory at `path`; false when there was none. Links to it become dangling. */
export async function remove(db: Db, owner: Owner, path: string): Promise<boolean> {
  const p = parsePath(path);
  if (!p.ok) return false;
  const res = await db
    .deleteFrom("memories")
    .where("org_id", "=", owner.orgId)
    .where("agent_id", "=", owner.agentId)
    .where("account_id", "=", owner.accountId)
    .where("path", "=", p.path)
    .executeTakeFirst();
  return Number(res.numDeletedRows) > 0;
}

/** Counts a recall of the owner's memories `ids` (a read or a search hit). */
export async function touch(db: Db, owner: Owner, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await db
    .updateTable("memories")
    .set({ recall_count: sql`recall_count + 1`, last_recalled_at: sql`now()` })
    .where("org_id", "=", owner.orgId)
    .where("agent_id", "=", owner.agentId)
    .where("account_id", "=", owner.accountId)
    .where("id", "in", ids)
    .execute();
}

/**
 * The links of the owner's memory `id`, by target: a path resolves to the owner's memory at that
 * path; a bare name to the owner's only memory with that file name. Otherwise `target` is null
 * (dangling: not written yet, or the name is ambiguous).
 */
export async function linksOf(
  db: Db,
  owner: Owner,
  id: string,
): Promise<{ path: string; target: MemoryRow | null }[]> {
  const links = await db
    .selectFrom("memory_links as l")
    .innerJoin("memories as m", "m.id", "l.memory_id")
    .select("l.to_path")
    .where("m.org_id", "=", owner.orgId)
    .where("m.agent_id", "=", owner.agentId)
    .where("m.account_id", "=", owner.accountId)
    .where("m.id", "=", id)
    .orderBy("l.to_path")
    .execute();
  if (links.length === 0) return [];
  const paths = links.map((l) => l.to_path as string).filter((p) => p.includes("/"));
  const names = links.map((l) => l.to_path as string).filter((p) => !p.includes("/"));
  const candidates = await selectOwned(db, owner)
    .where((eb) => {
      const ors = [];
      if (paths.length > 0) ors.push(eb("path", "in", paths));
      if (names.length > 0) {
        ors.push(
          eb(
            sql<string>`regexp_replace(path, '^.*/', '')`,
            "in",
            names.map((n) => `${n}.md`),
          ),
        );
      }
      return eb.or(ors);
    })
    .execute();
  const rows = candidates.map(toRow);
  return links.map((l) => {
    const to: string = l.to_path;
    if (to.includes("/")) {
      return { path: to, target: rows.find((r) => r.path === to) ?? null };
    }
    const matches = rows.filter((r) => r.path.endsWith(`/${to}.md`));
    return { path: to, target: matches.length === 1 ? (matches[0] ?? null) : null };
  });
}

/**
 * Deletes memories and remembered owners of an org, optionally only one agent's or one member's
 * (lifecycle cleanup; idempotent). The whole org's purge also drops its admin access log. Returns
 * the number of memories deleted.
 */
export async function purge(
  db: Db,
  filter: { orgId: string; agentId?: string; accountId?: string },
): Promise<number> {
  return db.transaction().execute(async (trx) => {
    let mem = trx.deleteFrom("memories").where("org_id", "=", filter.orgId);
    let own = trx.deleteFrom("owners").where("org_id", "=", filter.orgId);
    if (filter.agentId !== undefined) {
      mem = mem.where("agent_id", "=", filter.agentId);
      own = own.where("agent_id", "=", filter.agentId);
    }
    if (filter.accountId !== undefined) {
      mem = mem.where("account_id", "=", filter.accountId);
      own = own.where("account_id", "=", filter.accountId);
    }
    const res = await mem.executeTakeFirst();
    await own.execute();
    if (filter.agentId === undefined && filter.accountId === undefined) {
      await trx.deleteFrom("admin_access_log").where("org_id", "=", filter.orgId).execute();
    }
    return Number(res.numDeletedRows);
  });
}

/** Records the display names of an owner pair for the memory page (upsert). */
export async function rememberOwner(
  db: Db,
  owner: Owner,
  names: { agentName: string; ownerName: string },
): Promise<void> {
  await db
    .insertInto("owners")
    .values({
      org_id: owner.orgId,
      agent_id: owner.agentId,
      account_id: owner.accountId,
      agent_name: names.agentName,
      owner_name: names.ownerName,
    })
    .onConflict((oc) =>
      oc.columns(["org_id", "agent_id", "account_id"]).doUpdateSet({
        agent_name: names.agentName,
        owner_name: names.ownerName,
        seen_at: sql`now()`,
      }),
    )
    .execute();
}
