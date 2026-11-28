import type {
  ExtensionContext,
  ToolCallContext,
  TriggerCause,
  TriggerFactValue,
  TriggerSubject,
} from "@capybara-hq/plugin-sdk";
import { sql } from "kysely";
import { isAgent } from "../domain/internal.js";
import { collabDb } from "../store/db.js";
import type { Actor, OutboxRow } from "../store/types.js";
import { withActor } from "./summary.js";

/** The queue that emits outbox rows the request path could not (registered in `setup`). */
export const EMIT_QUEUE = "collab-emit";
/** How long a row's job waits: long enough for the request path's own emit to win. */
const RETRY_DELAY_MS = 15_000;
/** Cause handles live 24 h; an older row emits with the account as its cause instead. */
const HANDLE_MAX_AGE_MS = 23 * 60 * 60 * 1000;
/** Rows one drain emits; the rest wait for their jobs or the org's next write. */
const DRAIN_LIMIT = 50;
/** A row refused this often is left to its queue job only (a permanent refusal, e.g. org off). */
const DRAIN_MAX_ATTEMPTS = 10;

/** What the emitter uses of `ctx`. */
export type EmitterCtx = Pick<
  ExtensionContext,
  "db" | "log" | "triggers" | "queue" | "people" | "agents"
>;

/** The payload of a `collab-emit` job (`orgId` gives the job its org scope). */
export interface EmitJob {
  orgId: string;
  outboxId: string;
}

/**
 * The actor of a tool call that writes: the conversation's owner (the run's trigger account can
 * differ), the agent and the conversation, plus the
 * kernel's cause handle so the events the write owes keep the call's chain depth and self-trigger
 * check, also when a queue job emits them later.
 */
export async function toolActor(ctx: Pick<EmitterCtx, "triggers">, call: ToolCallContext) {
  return {
    accountId: call.ownerAccountId ?? call.accountId,
    agentId: call.agentId,
    conversationId: call.conversationId,
    causeHandle: await ctx.triggers.causeOf(call),
  } satisfies Actor;
}

/** Defines the `collab-emit` queue (in `setup`). */
export function registerEmitQueue(ctx: EmitterCtx): void {
  ctx.queue.define<EmitJob>(EMIT_QUEUE, (job) => emitQueued(ctx, job));
}

/**
 * Runs a domain write, then emits the events it owes (see {@link emitPending}). The write's
 * result is returned whatever the emit does: once committed, the events are owed, not lost.
 */
export async function emitting<T>(ctx: EmitterCtx, orgId: string, write: () => Promise<T>) {
  const result = await write();
  await emitPending(ctx, orgId);
  return result;
}

/**
 * After a write commits: every outbox row of the org still without `emitted_at` (the write's own,
 * and any an earlier process left behind) first owes a `collab-emit-<id>` job, then is emitted at
 * once. Failures are logged, never thrown: the job retries them.
 */
export async function emitPending(ctx: EmitterCtx, orgId: string): Promise<void> {
  const db = collabDb(ctx.db);
  let rows: OutboxRow[];
  try {
    rows = await db
      .selectFrom("event_outbox")
      .selectAll()
      .where("org_id", "=", orgId)
      .where("emitted_at", "is", null)
      .where("attempts", "<", DRAIN_MAX_ATTEMPTS)
      .orderBy("created_at")
      .limit(DRAIN_LIMIT)
      .execute();
  } catch (err) {
    ctx.log.error("collab outbox read failed", { orgId, err });
    return;
  }
  for (const row of rows) {
    try {
      await ctx.queue.add<EmitJob>(
        EMIT_QUEUE,
        { orgId, outboxId: row.id },
        { jobId: `${EMIT_QUEUE}-${row.id}`, delayMs: RETRY_DELAY_MS },
      );
      await emitRow(ctx, row);
    } catch (err) {
      ctx.log.warn("collab event emit failed; its queue job retries it", {
        orgId,
        outboxId: row.id,
        type: row.type,
        err,
      });
    }
  }
}

/** The `collab-emit` job: emits the row unless already emitted; a failure rethrows for a retry. */
export async function emitQueued(ctx: EmitterCtx, job: EmitJob): Promise<void> {
  const row = await collabDb(ctx.db)
    .selectFrom("event_outbox")
    .selectAll()
    .where("org_id", "=", job.orgId)
    .where("id", "=", job.outboxId)
    .executeTakeFirst();
  if (!row || row.emitted_at) return;
  await emitRow(ctx, row);
}

/** The kernel's cause for a row: the call's handle while it is valid, else the person. */
function causeOf(row: OutboxRow): TriggerCause {
  const fresh = Date.now() - new Date(row.created_at).getTime() < HANDLE_MAX_AGE_MS;
  if (row.cause_handle && fresh) return { handle: row.cause_handle };
  return { accountId: row.actor.accountId };
}

/** `Li`, or `PM (agent of Li)`; ids when the kernel cannot name them. */
async function actorName(ctx: EmitterCtx, orgId: string, actor: Actor): Promise<string> {
  let person = actor.accountId;
  try {
    const [view] = await ctx.people.get({ orgId, accountIds: [actor.accountId] });
    if (view?.name) person = view.name;
  } catch (err) {
    ctx.log.warn("collab could not name the actor of an event", { orgId, err });
  }
  if (!isAgent(actor)) return person;
  let agent = actor.agentId;
  try {
    const agents = await ctx.agents.usableBy({ orgId, accountId: actor.accountId });
    const found = agents.find((a) => a.id === actor.agentId);
    if (found?.name) agent = found.name;
  } catch (err) {
    ctx.log.warn("collab could not name the agent of an event", { orgId, err });
  }
  return `${agent} (agent of ${person})`;
}

/**
 * Emits one row and marks it emitted. The kernel dedupes on `dedupeKey`, so emitting a row twice
 * (two drains, a drain and its job, a lost result) makes one event.
 */
async function emitRow(ctx: EmitterCtx, row: OutboxRow): Promise<void> {
  const db = collabDb(ctx.db);
  try {
    await ctx.triggers.emit({
      orgId: row.org_id,
      type: row.type,
      subject: row.subject as TriggerSubject,
      facts: row.facts as Record<string, TriggerFactValue>,
      summary: withActor(row.summary, await actorName(ctx, row.org_id, row.actor)),
      dedupeKey: row.dedupe_key,
      cause: causeOf(row),
      ...(row.audience ? { audience: row.audience as { accountId: string; agentId: string } } : {}),
    });
  } catch (err) {
    await db
      .updateTable("event_outbox")
      .set({ attempts: sql`attempts + 1` })
      .where("org_id", "=", row.org_id)
      .where("id", "=", row.id)
      .execute();
    throw err;
  }
  await db
    .updateTable("event_outbox")
    .set({ emitted_at: sql`now()` })
    .where("org_id", "=", row.org_id)
    .where("id", "=", row.id)
    .where("emitted_at", "is", null)
    .execute();
}
