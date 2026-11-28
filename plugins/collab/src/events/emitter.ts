import type {
  ExtensionContext,
  TriggerCause,
  TriggerFactValue,
  TriggerSubject,
} from "@capybara-hq/plugin-sdk";
import { sql } from "kysely";
import { isAgent } from "../domain/internal.js";
import { type CollabDb, collabDb } from "../store/db.js";
import type { Actor, OutboxRow } from "../store/types.js";
import { type StoredDetail, type SummaryNames, summarize } from "./summary.js";

/** The queue whose jobs drain an org's pending outbox rows (registered in `setup`). */
export const DRAIN_QUEUE = "collab-drain";
/** Drain job ids are per org and minute, the same on every replica. */
const BUCKET_MS = 60_000;
/** The first retry of the ladder; each further one doubles, up to an hour. */
const FIRST_RETRY_MS = 60_000;
const MAX_RETRY_MS = 60 * 60 * 1000;
/** Rows one drain run emits; a full batch schedules the next run. */
const DRAIN_BATCH = 100;
/** The request path emits at most this many of its own rows; the rest are the drain's. */
const OWN_ROWS_LIMIT = 50;
/** Cause handles live 24 h; an older row emits with the account as its cause instead. */
const HANDLE_MAX_AGE_MS = 23 * 60 * 60 * 1000;
/** A row not emitted within a day is given up (`failed_at`), never retried forever. */
const ROW_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** Prune per drain run: settled rows kept 7 days (emitted) and 30 days (failed). */
const PRUNE_LIMIT = 500;

/** What the emitter uses of `ctx`. */
export type EmitterCtx = Pick<
  ExtensionContext,
  "db" | "log" | "triggers" | "queue" | "people" | "agents"
>;

/** The payload of a `collab-drain` job (`orgId` gives the job its org scope). */
export interface DrainJob {
  orgId: string;
  /** The ladder step: 0 for a write's own job, +1 for every run that left rows pending. */
  step: number;
}

/** A queue job id is free of `:`; an org id is used as is when it is plain. */
function drainJobId(orgId: string, bucket: number, retry: boolean): string {
  const org = orgId.replace(/[^A-Za-z0-9_-]/g, "_");
  return `${DRAIN_QUEUE}-${org}-${bucket}${retry ? "-retry" : ""}`;
}

/** Defines the `collab-drain` queue (in `setup`). */
export function registerDrainQueue(ctx: EmitterCtx): void {
  ctx.queue.define<DrainJob>(DRAIN_QUEUE, (job) => drainOrg(ctx, job));
}

/**
 * Runs a domain write and emits the events it owes. Intent first: before the write, the org's
 * drain job of this minute is queued (it runs at least a minute after the minute ends, and is a
 * no-op when the write rolled back), so a crash after the commit still gets the events out. After
 * the write, the rows it wrote are emitted at once; failures are logged, never thrown (once
 * committed, the events are owed, not lost; the drain job retries them).
 */
export async function emitting<T>(ctx: EmitterCtx, orgId: string, write: () => Promise<T>) {
  const bucket = Math.floor(Date.now() / BUCKET_MS);
  await ctx.queue.add<DrainJob>(
    DRAIN_QUEUE,
    { orgId, step: 0 },
    { jobId: drainJobId(orgId, bucket, false), delayMs: (bucket + 2) * BUCKET_MS - Date.now() },
  );
  const db = collabDb(ctx.db);
  const start = await dbNow(db);
  const result = await write();
  await emitOwn(ctx, orgId, start);
  return result;
}

/** The database clock: rows of a write that starts later carry a `created_at` at or after it. */
async function dbNow(db: CollabDb): Promise<Date> {
  const { rows } = await sql<{ t: Date }>`SELECT clock_timestamp() AS t`.execute(db);
  const row = rows[0];
  if (!row) throw new Error("clock_timestamp() returned no row");
  return row.t;
}

/** Emits the pending rows written since `start` (this write's; a concurrent one's too, harmlessly). */
async function emitOwn(ctx: EmitterCtx, orgId: string, start: Date): Promise<void> {
  let rows: OutboxRow[];
  try {
    rows = await pending(collabDb(ctx.db), orgId, OWN_ROWS_LIMIT)
      .where("created_at", ">=", start)
      .execute();
  } catch (err) {
    ctx.log.warn("collab outbox read failed; a drain job emits the events", { orgId, err });
    await queueRetry(ctx, orgId);
    return;
  }
  const names = new Map<string, Promise<unknown>>();
  let failed = false;
  for (const row of rows) {
    try {
      await emitRow(ctx, row, names);
    } catch (err) {
      failed = true;
      ctx.log.warn("collab event emit failed; a drain job retries it", {
        orgId,
        outboxId: row.id,
        type: row.type,
        err,
      });
    }
  }
  if (failed) await queueRetry(ctx, orgId);
}

/**
 * Best effort after a failed emit on the request path: a drain job a minute from now, so a write
 * that committed after its bucket job already ran does not wait for the org's next write. Its id
 * names the bucket it runs in (never one a finished job has), shared with the ladder's.
 */
async function queueRetry(ctx: EmitterCtx, orgId: string): Promise<void> {
  try {
    await ctx.queue.add<DrainJob>(
      DRAIN_QUEUE,
      { orgId, step: 0 },
      {
        jobId: drainJobId(orgId, Math.floor((Date.now() + FIRST_RETRY_MS) / BUCKET_MS), true),
        delayMs: FIRST_RETRY_MS,
      },
    );
  } catch (err) {
    ctx.log.warn("collab could not queue a drain retry; the next write rescues the events", {
      orgId,
      err,
    });
  }
}

function pending(db: CollabDb, orgId: string, limit: number) {
  return db
    .selectFrom("event_outbox")
    .selectAll()
    .where("org_id", "=", orgId)
    .where("emitted_at", "is", null)
    .where("failed_at", "is", null)
    .orderBy("created_at")
    .limit(limit);
}

/**
 * The `collab-drain` job: prunes settled rows, emits the org's pending rows (oldest first, one
 * batch), gives up rows older than a day, and while rows stay pending queues itself again on a
 * ladder (1 min, doubling, at most 1 h). The ladder is ours, not the queue's attempts, so an
 * outage of any length is bridged. When queueing the next step fails, the job throws so the queue
 * retries it (rows this run emitted stay emitted); should those retries run out too, the org's
 * next write (its bucket job and its own emit) rescues the rows.
 */
export async function drainOrg(ctx: EmitterCtx, job: DrainJob): Promise<void> {
  const db = collabDb(ctx.db);
  const { orgId } = job;
  let left = false;
  let failing = false;
  try {
    await prune(db, orgId);
    const rows = await pending(db, orgId, DRAIN_BATCH).execute();
    left = rows.length === DRAIN_BATCH;
    const names = new Map<string, Promise<unknown>>();
    for (const row of rows) {
      if (Date.now() - new Date(row.created_at).getTime() > ROW_MAX_AGE_MS) {
        await markFailed(ctx, row, "not emitted within a day");
        continue;
      }
      try {
        await emitRow(ctx, row, names);
      } catch (err) {
        failing = true;
        ctx.log.warn("collab event emit failed; the drain retries it later", {
          orgId,
          outboxId: row.id,
          type: row.type,
          attempts: row.attempts + 1,
          err,
        });
      }
    }
  } catch (err) {
    failing = true;
    ctx.log.warn("collab outbox drain failed; it retries later", { orgId, err });
  }
  if (!left && !failing) return;
  const step = failing ? job.step + 1 : 0;
  const delayMs = Math.min(FIRST_RETRY_MS * 2 ** step, MAX_RETRY_MS);
  await ctx.queue.add<DrainJob>(
    DRAIN_QUEUE,
    { orgId, step },
    {
      jobId: drainJobId(orgId, Math.floor((Date.now() + delayMs) / BUCKET_MS), true),
      delayMs,
    },
  );
}

/** Deletes settled rows past their keep time, a bounded batch per run. */
async function prune(db: CollabDb, orgId: string): Promise<void> {
  await db
    .deleteFrom("event_outbox")
    .where(
      "id",
      "in",
      db
        .selectFrom("event_outbox")
        .select("id")
        .where("org_id", "=", orgId)
        .where("emitted_at", "<", sql<Date>`now() - interval '7 days'`)
        .limit(PRUNE_LIMIT),
    )
    .execute();
  await db
    .deleteFrom("event_outbox")
    .where(
      "id",
      "in",
      db
        .selectFrom("event_outbox")
        .select("id")
        .where("org_id", "=", orgId)
        .where("failed_at", "<", sql<Date>`now() - interval '30 days'`)
        .limit(PRUNE_LIMIT),
    )
    .execute();
}

/** Gives a row up: `failed_at` and a warning, so no event is lost silently. */
async function markFailed(ctx: EmitterCtx, row: OutboxRow, reason: string, err?: unknown) {
  await collabDb(ctx.db)
    .updateTable("event_outbox")
    .set({ failed_at: sql`now()`, attempts: sql`attempts + 1` })
    .where("org_id", "=", row.org_id)
    .where("id", "=", row.id)
    .where("emitted_at", "is", null)
    .execute();
  ctx.log.warn("collab event given up", {
    orgId: row.org_id,
    outboxId: row.id,
    type: row.type,
    dedupeKey: row.dedupe_key,
    reason,
    ...(err ? { err } : {}),
  });
}

/** The kernel's refusal code of a `TriggerError` (compared by code: the SDK may be another copy). */
function refusalOf(err: unknown): string | null {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : null;
}

/**
 * The causes to try, best first: the call's handle while it is valid, the person, then none. A
 * refused cause (`invalid_event`: an expired or foreign handle, an account that left) degrades to
 * the next.
 */
function causesOf(row: OutboxRow): (TriggerCause | undefined)[] {
  const fresh = Date.now() - new Date(row.created_at).getTime() < HANDLE_MAX_AGE_MS;
  const account: TriggerCause = { accountId: row.actor.accountId };
  return row.cause_handle && fresh
    ? [{ handle: row.cause_handle }, account, undefined]
    : [account, undefined];
}

/**
 * Emits one row and marks it emitted. The kernel dedupes on `dedupeKey`, so emitting a row twice
 * (the request and a drain, two drains, a lost result) makes one event. A permanent refusal sets
 * `failed_at`; any other failure counts an attempt and throws.
 */
async function emitRow(
  ctx: EmitterCtx,
  row: OutboxRow,
  names: Map<string, Promise<unknown>>,
): Promise<void> {
  const db = collabDb(ctx.db);
  const detail = row.detail as unknown as StoredDetail;
  const event = {
    orgId: row.org_id,
    type: row.type,
    subject: row.subject as TriggerSubject,
    facts: row.facts as Record<string, TriggerFactValue>,
    summary: summarize(row.type, detail, await namesFor(ctx, row, detail, names)),
    dedupeKey: row.dedupe_key,
    ...(row.audience ? { audience: row.audience as { accountId: string; agentId: string } } : {}),
  };
  const causes = causesOf(row);
  for (const [i, cause] of causes.entries()) {
    try {
      await ctx.triggers.emit(cause ? { ...event, cause } : event);
    } catch (err) {
      const code = refusalOf(err);
      if (code === "invalid_event" && i < causes.length - 1) {
        ctx.log.warn("collab event cause refused; emitting with a weaker cause", {
          orgId: row.org_id,
          outboxId: row.id,
          cause: cause ? Object.keys(cause)[0] : "none",
        });
        continue;
      }
      if (code === "type_not_declared" || code === "invalid_event") {
        await markFailed(ctx, row, code, err);
        return;
      }
      try {
        await db
          .updateTable("event_outbox")
          .set({ attempts: sql`attempts + 1` })
          .where("org_id", "=", row.org_id)
          .where("id", "=", row.id)
          .execute();
      } catch {
        // The emit error is the one that matters.
      }
      throw err;
    }
    await db
      .updateTable("event_outbox")
      .set({ emitted_at: sql`now()` })
      .where("org_id", "=", row.org_id)
      .where("id", "=", row.id)
      .where("emitted_at", "is", null)
      .execute();
    return;
  }
}

/** A lookup memoized for one drain (or one request), never across them. */
function memo<T>(names: Map<string, Promise<unknown>>, key: string, load: () => Promise<T>) {
  let hit = names.get(key) as Promise<T> | undefined;
  if (!hit) {
    hit = load();
    names.set(key, hit);
  }
  return hit;
}

async function personName(
  ctx: EmitterCtx,
  orgId: string,
  accountId: string,
  names: Map<string, Promise<unknown>>,
): Promise<string> {
  return memo(names, `person-${accountId}`, async () => {
    try {
      const [view] = await ctx.people.get({ orgId, accountIds: [accountId] });
      return view?.name || accountId;
    } catch (err) {
      ctx.log.warn("collab could not name a person in an event", { orgId, err });
      return accountId;
    }
  });
}

async function agentName(
  ctx: EmitterCtx,
  orgId: string,
  accountId: string,
  agentId: string,
  names: Map<string, Promise<unknown>>,
): Promise<string> {
  const agents = await memo(names, `agents-${accountId}`, async () => {
    try {
      return await ctx.agents.usableBy({ orgId, accountId });
    } catch (err) {
      ctx.log.warn("collab could not name an agent in an event", { orgId, err });
      return [];
    }
  });
  return agents.find((a) => a.id === agentId)?.name || agentId;
}

/** `Li` or `PM (agent of Li)` for the actor; the assignment pair's names. */
async function namesFor(
  ctx: EmitterCtx,
  row: OutboxRow,
  detail: StoredDetail,
  names: Map<string, Promise<unknown>>,
): Promise<SummaryNames> {
  const orgId = row.org_id;
  const actor: Actor = row.actor;
  const person = await personName(ctx, orgId, actor.accountId, names);
  const out: SummaryNames = {
    actor: isAgent(actor)
      ? `${await agentName(ctx, orgId, actor.accountId, actor.agentId, names)} (agent of ${person})`
      : person,
  };
  const responsible = detail.responsibleAccountId;
  if (responsible) out.responsible = await personName(ctx, orgId, responsible, names);
  if (detail.executingAgentId) {
    out.agent = await agentName(
      ctx,
      orgId,
      responsible ?? actor.accountId,
      detail.executingAgentId,
      names,
    );
  }
  return out;
}
