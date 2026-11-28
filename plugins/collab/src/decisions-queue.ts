import type { ExtensionContext, InboxAction } from "@capybara-hq/plugin-sdk";
import { PROJECTS } from "./constants.js";
import type { DecisionHooks } from "./domain/decision-state.js";
import { readdressOpen } from "./domain/decision-state.js";
import {
  answerersOf,
  DECISION_EXPIRY_MS,
  type DecisionOption,
  expireDecision,
} from "./domain/decisions.js";
import { emitting } from "./events/emitter.js";
import { itemKey } from "./events/outbox.js";
import { type CollabDb, collabDb } from "./store/db.js";
import type { Decision, Item, Project } from "./store/types.js";

/** The queue of a decision's jobs (notify, remind, escalate, resolve, expire). */
export const DECISIONS_QUEUE = "collab-decisions";
/** The UI action (of the `projects` page) an inbox button calls to answer a decision. */
export const INBOX_ANSWER = "inbox.answer";
/** The notify and resolve jobs run this long after the write: they do what the request missed. */
const FOLLOW_UP_DELAY_MS = 30_000;
/** The project owner hears of an unanswered decision this long after its deadline. */
const ESCALATE_AFTER_MS = 24 * 60 * 60 * 1000;
/** Inbox limits (`INBOX_LIMITS`): title, body and action label lengths in characters. */
const TITLE_CHARS = 200;
const BODY_CHARS = 2000;
const LABEL_CHARS = 40;
/** At most this many option buttons; a decision with more is answered on its page. */
const MAX_BUTTONS = 3;

/** What the decision jobs use of `ctx` (the expiry emits its event, hence the emitter's parts). */
export type DecisionsCtx = Pick<
  ExtensionContext,
  "db" | "log" | "queue" | "inbox" | "people" | "triggers" | "agents"
>;

export type DecisionStep = "notify" | "remind" | "escalate" | "resolve" | "expire";

/** The payload of a `collab-decisions` job (`orgId` gives the job its org scope). */
export interface DecisionJob {
  orgId: string;
  decisionId: string;
  step: DecisionStep;
  /** notify: the address generation it posts for (a later re-address makes it moot). */
  gen?: number;
}

/** The payload of an inbox answer button. */
export interface AnswerPayload {
  decisionId: string;
  optionId: string;
}

/**
 * A job id per decision and step, the same on every replica (a uuid has no `:`); a re-address
 * notifies under a new id (`-<gen>`), never one a finished job already has.
 */
export function decisionJobId(step: DecisionStep, decisionId: string, gen = 0): string {
  return `collab-decision-${step}-${decisionId}${step === "notify" && gen > 0 ? `-${gen}` : ""}`;
}

/** Defines the `collab-decisions` queue (in `setup`). */
export function registerDecisionQueue(ctx: DecisionsCtx): void {
  ctx.queue.define<DecisionJob>(DECISIONS_QUEUE, (job) => runDecisionJob(ctx, job));
}

/** Minute buckets of the jobs a decision may owe more than once (see {@link add}). */
const BUCKET_MS = 60_000;

/**
 * Queues a decision's job. A decision is created once, but it may be re-addressed or closed by a
 * write that later rolls back and then again by another: those jobs (resolve, a re-address's
 * notify) carry the minute bucket in their id and run two minutes after the bucket starts, so
 * every write of that minute has committed or rolled back before the job runs, and a later
 * write's job never shares the id of a finished one.
 */
async function add(ctx: DecisionsCtx, job: DecisionJob, delayMs: number): Promise<void> {
  const id = decisionJobId(job.step, job.decisionId, job.gen);
  const repeatable = job.step === "resolve" || (job.step === "notify" && (job.gen ?? 0) > 0);
  if (!repeatable) {
    await ctx.queue.add<DecisionJob>(DECISIONS_QUEUE, job, { jobId: id, delayMs });
    return;
  }
  const now = Date.now();
  const bucket = Math.floor(now / BUCKET_MS);
  await ctx.queue.add<DecisionJob>(DECISIONS_QUEUE, job, {
    jobId: `${id}-b${bucket}`,
    delayMs: (bucket + 2) * BUCKET_MS - now,
  });
}

/** Queues the reminder at the deadline and the escalation a day later (before the ask's write). */
export async function queueDeadline(
  ctx: DecisionsCtx,
  orgId: string,
  decisionId: string,
  deadlineHours: number,
): Promise<void> {
  const delayMs = Math.round(deadlineHours * 3600 * 1000);
  await add(ctx, { orgId, decisionId, step: "remind" }, delayMs);
  await add(ctx, { orgId, decisionId, step: "escalate" }, delayMs + ESCALATE_AFTER_MS);
}

/**
 * The decision hooks of one write (see {@link DecisionHooks}): each hook queues its job inside
 * the write (intent first) and remembers it; `flush()` runs them at once after the commit (best
 * effort, the queued jobs retry). State lives in this one request's object only.
 */
export function decisionHooks(ctx: DecisionsCtx, orgId: string) {
  const owed: DecisionJob[] = [];
  const hooks: DecisionHooks = {
    created: async (decisionId) => {
      const notify: DecisionJob = { orgId, decisionId, step: "notify", gen: 0 };
      await add(ctx, notify, FOLLOW_UP_DELAY_MS);
      await add(ctx, { orgId, decisionId, step: "expire" }, DECISION_EXPIRY_MS);
      owed.push(notify);
    },
    readdressed: async (decisionId, gen) => {
      const notify: DecisionJob = { orgId, decisionId, step: "notify", gen };
      await add(ctx, notify, FOLLOW_UP_DELAY_MS);
      owed.push(notify);
    },
    closed: async (decisionId) => {
      const resolve: DecisionJob = { orgId, decisionId, step: "resolve" };
      await add(ctx, resolve, FOLLOW_UP_DELAY_MS);
      owed.push(resolve);
    },
  };
  return {
    hooks,
    flush: async () => {
      for (const job of owed.splice(0)) {
        try {
          await runDecisionJob(ctx, job);
        } catch (err) {
          ctx.log.warn("collab decision follow-up failed; its job retries", {
            orgId,
            decisionId: job.decisionId,
            step: job.step,
            err,
          });
        }
      }
    },
  };
}

interface Loaded {
  decision: Decision;
  item: Item;
  project: Project;
}

async function load(db: CollabDb, orgId: string, decisionId: string): Promise<Loaded | null> {
  const decision = await db
    .selectFrom("decisions")
    .selectAll()
    .where("org_id", "=", orgId)
    .where("id", "=", decisionId)
    .executeTakeFirst();
  if (!decision) return null;
  const item = await db
    .selectFrom("items")
    .selectAll()
    .where("org_id", "=", orgId)
    .where("id", "=", decision.item_id)
    .executeTakeFirst();
  if (!item) return null;
  const project = await db
    .selectFrom("projects")
    .selectAll()
    .where("org_id", "=", orgId)
    .where("id", "=", item.project_id)
    .executeTakeFirstOrThrow();
  return { decision, item, project };
}

/** A refusal the inbox will repeat on every retry (an invalid item, the plugin off in the org). */
function permanentInboxRefusal(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return code === "invalid_item" || code === "org_disabled";
}

/** An item the inbox cannot resolve, now or ever (gone, invalid, the plugin off in the org). */
function permanentResolveRefusal(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return code === "not_found" || permanentInboxRefusal(err);
}

/**
 * Resolves inbox items. `strict` (the resolve step): a transient failure is rethrown so the job
 * retries, a permanent one only logged; otherwise every failure is only logged.
 */
async function resolveAll(
  ctx: DecisionsCtx,
  orgId: string,
  ids: string[],
  decisionId: string,
  strict = false,
) {
  for (const itemId of new Set(ids)) {
    try {
      await ctx.inbox.resolve({ orgId, itemId });
    } catch (err) {
      if (strict && !permanentResolveRefusal(err)) throw err;
      ctx.log.warn("collab could not resolve a decision's inbox item", { orgId, decisionId, err });
    }
  }
}

const FLAG = { notify: "notified_at", remind: "reminded_at", escalate: "escalated_at" } as const;

/**
 * One step of a decision. Every step is idempotent (the queue runs it at least once):
 * - notify / remind / escalate post once: skipped for a decision that is gone (rolled back),
 *   closed, re-addressed since (notify of an older generation) or whose step already posted.
 *   notify and remind first check the addressee is still right and re-address if not. The post
 *   dedupes on a key per decision and step; the flag is set only while the decision is open, and
 *   an item posted while an answer landed is resolved at once. A permanent inbox refusal sets the
 *   flag too (warned), so it is not retried forever.
 * - resolve resolves the inbox items of a closed decision (also of earlier addressees).
 * - expire expires a decision still open after 30 days.
 */
export async function runDecisionJob(ctx: DecisionsCtx, job: DecisionJob): Promise<void> {
  const db = collabDb(ctx.db);
  if (job.step === "expire") return expire(ctx, job);
  let loaded = await load(db, job.orgId, job.decisionId);
  if (!loaded) return;
  if (job.step === "resolve") {
    const { decision } = loaded;
    if (decision.state === "open") return;
    await resolveAll(
      ctx,
      job.orgId,
      [...decision.inbox_item_ids, ...decision.stale_inbox_item_ids],
      decision.id,
      true,
    );
    return;
  }
  if (loaded.decision.state !== "open") return;
  // A notify of an older generation is moot: the re-address queued its own.
  if (job.step === "notify" && job.gen !== undefined && job.gen !== loaded.decision.address_gen) {
    return;
  }
  if (job.step !== "escalate") {
    loaded = await refreshAddressee(ctx, db, job.orgId, loaded);
    if (!loaded) return;
  }
  const { decision, item, project } = loaded;
  const flag = FLAG[job.step];
  if (decision.state !== "open" || decision[flag] !== null) return;
  if (job.step === "notify" && decision.stale_inbox_item_ids.length > 0) {
    await resolveAll(ctx, job.orgId, decision.stale_inbox_item_ids, decision.id);
  }
  // Every recipient (each confirmer of a gate several members may confirm) gets their own item;
  // one already posted for this step (an earlier, interrupted run) is not posted again. The first
  // answer closes the decision and its resolve step resolves every item.
  const posts: { account: string | null; post: Post }[] = [];
  if (job.step === "escalate") {
    const post = await escalation(ctx, loaded);
    if (post) posts.push({ account: null, post });
  } else {
    const step = job.step;
    for (const to of recipientsOf(decision)) {
      if (decision.inbox_by_account[to]?.[step]) continue;
      posts.push({
        account: to,
        post: await addresseeItem(db, job.orgId, loaded, step === "remind", to),
      });
    }
  }
  // The SDK dedupes per account, so each recipient's item carries the step's plain key.
  const dedupeKey =
    job.step === "notify"
      ? `${decision.id}${decision.address_gen > 0 ? `-${decision.address_gen}` : ""}`
      : `${decision.id}-${job.step}`;
  const posted: { account: string | null; id: string }[] = [];
  let failure: unknown;
  for (const { account, post } of posts) {
    try {
      const { itemId } = await ctx.inbox.post({
        orgId: job.orgId,
        link: `/p/collab/${PROJECTS}?item=${itemKey(project.key, item.number)}`,
        dedupeKey,
        ...post,
      });
      posted.push({ account, id: itemId });
    } catch (err) {
      if (!permanentInboxRefusal(err)) {
        // Keep what was posted (the retry skips those recipients), then let the job retry.
        failure = err;
        break;
      }
      ctx.log.warn("collab decision inbox item refused for good; not retried", {
        orgId: job.orgId,
        decisionId: decision.id,
        step: job.step,
        err,
      });
    }
  }
  const step = job.step;
  const kept = await db.transaction().execute(async (tx) => {
    const now = await tx
      .selectFrom("decisions")
      .selectAll()
      .where("org_id", "=", job.orgId)
      .where("id", "=", decision.id)
      .forUpdate()
      .executeTakeFirst();
    if (now?.state !== "open" || now.address_gen !== decision.address_gen || now[flag] !== null) {
      return false;
    }
    const byAccount = { ...now.inbox_by_account };
    for (const p of posted) {
      if (p.account && step !== "escalate") {
        byAccount[p.account] = { ...byAccount[p.account], [step]: p.id };
      }
    }
    await tx
      .updateTable("decisions")
      .set({
        ...(failure === undefined ? { [flag]: new Date() } : {}),
        inbox_item_ids: [...now.inbox_item_ids, ...posted.map((p) => p.id)],
        inbox_by_account: JSON.stringify(byAccount),
      })
      .where("org_id", "=", job.orgId)
      .where("id", "=", decision.id)
      .execute();
    return true;
  });
  // Answered or re-addressed in the meantime: its resolve may have missed these items.
  if (!kept && posted.length > 0) {
    const now = await load(db, job.orgId, decision.id);
    if (now?.decision.state !== "open" || now.decision.address_gen !== decision.address_gen) {
      await resolveAll(
        ctx,
        job.orgId,
        posted.map((p) => p.id),
        decision.id,
      );
    }
  }
  if (failure !== undefined) throw failure;
}

/**
 * Re-addresses the decision's item when its addressee is no longer right (the jobs compute the
 * addressee fresh), then returns the current state.
 */
async function refreshAddressee(
  ctx: DecisionsCtx,
  db: CollabDb,
  orgId: string,
  loaded: Loaded,
): Promise<Loaded | null> {
  const fresh = await db.transaction().execute(async (tx) => {
    await tx
      .selectFrom("items")
      .select("id")
      .where("org_id", "=", orgId)
      .where("id", "=", loaded.item.id)
      .forNoKeyUpdate()
      .execute();
    const before = loaded.decision.address_gen;
    // The new generation's notify job is queued; this job posts for it directly below.
    await readdressOpen(tx, orgId, { itemId: loaded.item.id }, decisionHooks(ctx, orgId).hooks);
    const now = await tx
      .selectFrom("decisions")
      .select("address_gen")
      .where("org_id", "=", orgId)
      .where("id", "=", loaded.decision.id)
      .executeTakeFirst();
    return now?.address_gen !== before;
  });
  return fresh ? load(db, orgId, loaded.decision.id) : loaded;
}

async function expire(ctx: DecisionsCtx, job: DecisionJob): Promise<void> {
  const db = collabDb(ctx.db);
  const follow = decisionHooks(ctx, job.orgId);
  const expired = await emitting(ctx, job.orgId, () =>
    expireDecision(db, job.orgId, job.decisionId, follow.hooks),
  );
  if (expired) await follow.flush();
}

function clip(text: string, max: number): string {
  const cps = [...text];
  return cps.length <= max ? text : `${cps.slice(0, max - 1).join("")}…`;
}

type Post = {
  accountId: string;
  kind: string;
  title: string;
  body: string;
  actions?: InboxAction[];
};

/** Who a notice or reminder goes to: the decision's stored recipients (see `readdressOpen`). */
function recipientsOf(decision: Decision): string[] {
  return decision.addressees.length > 0 ? decision.addressees : [decision.addressee_account_id];
}

/** A recipient's item (the first notice, or the reminder at the deadline). */
async function addresseeItem(
  db: CollabDb,
  orgId: string,
  { decision, item, project }: Loaded,
  reminder: boolean,
  recipient: string,
): Promise<Post> {
  const key = itemKey(project.key, item.number);
  const options = decision.options as DecisionOption[];
  const rec = decision.recommendation as { optionId: string; why: string } | null;
  // Buttons only for a person who may answer (a gate routed to the owner to pick a confirmer has
  // none), and only when every option fits; otherwise the item links to the decision's page.
  const canAnswer = (await answerersOf(db, orgId, decision, item)).includes(recipient);
  const buttons = canAnswer && options.length > 0 && options.length <= MAX_BUTTONS;
  const lines = [decision.question];
  if (options.length > 0) lines.push(`Options: ${options.map((o) => o.label).join(" / ")}`);
  if (rec) {
    const label = options.find((o) => o.id === rec.optionId)?.label ?? rec.optionId;
    lines.push(`Recommended: ${label}${rec.why ? `: ${rec.why}` : ""}`);
  }
  if (!buttons) lines.push("Answer it on the item's page.");
  const what = decision.kind === "gate" ? "Confirm" : "Decide";
  return {
    accountId: recipient,
    kind: reminder ? "collab.decision.reminder" : "collab.decision",
    title: clip(`${reminder ? "Reminder: " : ""}${what} on ${key} ${item.title}`, TITLE_CHARS),
    body: clip(lines.join("\n"), BODY_CHARS),
    ...(buttons
      ? {
          actions: options.map((o) => ({
            id: o.id,
            label: { zh: clip(o.label, LABEL_CHARS), en: clip(o.label, LABEL_CHARS) },
            ...(o.id === "reject" && decision.kind === "gate"
              ? { style: "danger" as const }
              : o.id === rec?.optionId || (decision.kind === "gate" && o.id === "approve")
                ? { style: "primary" as const }
                : {}),
            uiAction: {
              contribution: PROJECTS,
              actionId: INBOX_ANSWER,
              payload: { decisionId: decision.id, optionId: o.id } satisfies AnswerPayload,
            },
          })),
        }
      : {}),
  };
}

/** The project owner's item a day after the deadline (none when the owner is the addressee). */
async function escalation(ctx: DecisionsCtx, { decision, item, project }: Loaded) {
  const waitingOn = recipientsOf(decision);
  // The owner asked to answer it is not told twice.
  if (waitingOn.includes(project.owner_account_id)) return null;
  const key = itemKey(project.key, item.number);
  const names = new Map(waitingOn.map((id) => [id, id]));
  try {
    for (const person of await ctx.people.get({ orgId: decision.org_id, accountIds: waitingOn })) {
      names.set(person.id, person.name);
    }
  } catch {
    // The ids stand in for the names.
  }
  const who = [...names.values()].join(", ");
  return {
    accountId: project.owner_account_id,
    kind: "collab.decision.escalated",
    title: clip(`Unanswered decision on ${key} ${item.title}`, TITLE_CHARS),
    body: clip(
      `${who} ${waitingOn.length > 1 ? "have" : "has"} not answered since the deadline a day ago: ${decision.question}`,
      BODY_CHARS,
    ),
  };
}
