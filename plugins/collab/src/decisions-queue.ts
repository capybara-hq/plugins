import type { ExtensionContext, InboxAction } from "@capybara-hq/plugin-sdk";
import { PROJECTS } from "./constants.js";
import { answerersOf, type DecisionOption } from "./domain/decisions.js";
import { itemKey } from "./events/outbox.js";
import { type CollabDb, collabDb } from "./store/db.js";
import type { Decision, Item, Project } from "./store/types.js";

/** The queue of a decision's jobs: notify the addressee, remind at the deadline, escalate. */
export const DECISIONS_QUEUE = "collab-decisions";
/** The UI action (of the `projects` page) an inbox button calls to answer a decision. */
export const INBOX_ANSWER = "inbox.answer";
/** The notify job runs this long after the write: it posts only what the request path missed. */
const NOTIFY_DELAY_MS = 30_000;
/** The project owner hears of an unanswered decision this long after its deadline. */
const ESCALATE_AFTER_MS = 24 * 60 * 60 * 1000;
/** Inbox limits (`INBOX_LIMITS`): title, body and action label lengths in characters. */
const TITLE_CHARS = 200;
const BODY_CHARS = 2000;
const LABEL_CHARS = 40;
/** At most this many option buttons; a decision with more is answered on its page. */
const MAX_BUTTONS = 3;

/** What the decision jobs use of `ctx`. */
export type DecisionsCtx = Pick<ExtensionContext, "db" | "log" | "queue" | "inbox" | "people">;

export type DecisionStep = "notify" | "remind" | "escalate";

/** The payload of a `collab-decisions` job (`orgId` gives the job its org scope). */
export interface DecisionJob {
  orgId: string;
  decisionId: string;
  step: DecisionStep;
}

/** The payload of an inbox answer button. */
export interface AnswerPayload {
  decisionId: string;
  optionId: string;
}

/** A job id per decision and step, the same on every replica (a uuid has no `:`). */
export function decisionJobId(step: DecisionStep, decisionId: string): string {
  return `collab-decision-${step}-${decisionId}`;
}

/** Defines the `collab-decisions` queue (in `setup`). */
export function registerDecisionQueue(ctx: DecisionsCtx): void {
  ctx.queue.define<DecisionJob>(DECISIONS_QUEUE, (job) => runDecisionJob(ctx, job));
}

/**
 * Queues the decision's notify job, before the write that creates the decision (intent first: a
 * crash after the commit still notifies; a rolled-back write leaves the job nothing to do).
 */
export async function queueNotify(
  ctx: DecisionsCtx,
  orgId: string,
  decisionId: string,
): Promise<void> {
  await ctx.queue.add<DecisionJob>(
    DECISIONS_QUEUE,
    { orgId, decisionId, step: "notify" },
    { jobId: decisionJobId("notify", decisionId), delayMs: NOTIFY_DELAY_MS },
  );
}

/** Queues the reminder at the deadline and the escalation a day later (before the write too). */
export async function queueDeadline(
  ctx: DecisionsCtx,
  orgId: string,
  decisionId: string,
  deadlineHours: number,
): Promise<void> {
  const delayMs = Math.round(deadlineHours * 3600 * 1000);
  await ctx.queue.add<DecisionJob>(
    DECISIONS_QUEUE,
    { orgId, decisionId, step: "remind" },
    { jobId: decisionJobId("remind", decisionId), delayMs },
  );
  await ctx.queue.add<DecisionJob>(
    DECISIONS_QUEUE,
    { orgId, decisionId, step: "escalate" },
    { jobId: decisionJobId("escalate", decisionId), delayMs: delayMs + ESCALATE_AFTER_MS },
  );
}

/**
 * The gate hook of a write that may open gate decisions (`MoveOptions.onGateDecision`): queues
 * each decision's notify job inside the write, and `flush()` posts the inbox items once the
 * write committed. State lives in this one request's object only.
 */
export function gateNotifier(ctx: DecisionsCtx, orgId: string) {
  const ids: string[] = [];
  return {
    onGateDecision: async (decisionId: string) => {
      await queueNotify(ctx, orgId, decisionId);
      ids.push(decisionId);
    },
    flush: async () => {
      for (const id of ids) await notifyNow(ctx, orgId, id);
    },
  };
}

/** Posts the addressee's inbox item right after the commit; failures are the notify job's. */
export async function notifyNow(
  ctx: DecisionsCtx,
  orgId: string,
  decisionId: string,
): Promise<void> {
  try {
    await runDecisionJob(ctx, { orgId, decisionId, step: "notify" });
  } catch (err) {
    ctx.log.warn("collab could not post a decision's inbox item; its job retries", {
      orgId,
      decisionId,
      err,
    });
  }
}

/** Resolves the decision's inbox items (after an answer); failures are logged. */
export async function resolveDecisionInbox(
  ctx: DecisionsCtx,
  orgId: string,
  decision: Pick<Decision, "id" | "inbox_item_ids">,
): Promise<void> {
  for (const itemId of decision.inbox_item_ids) {
    try {
      await ctx.inbox.resolve({ orgId, itemId });
    } catch (err) {
      ctx.log.warn("collab could not resolve a decision's inbox item", {
        orgId,
        decisionId: decision.id,
        err,
      });
    }
  }
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

const FLAG = { notify: "notified_at", remind: "reminded_at", escalate: "escalated_at" } as const;

/**
 * One step of a decision. Idempotent: a decision that is gone (rolled back), no longer open, or
 * whose step already posted is skipped. The inbox post dedupes on a key per decision and step,
 * so a retry after a lost result gets the same item; the step's flag is set only while the
 * decision is still open, and an item posted while an answer landed is resolved at once.
 */
export async function runDecisionJob(ctx: DecisionsCtx, job: DecisionJob): Promise<void> {
  const db = collabDb(ctx.db);
  const loaded = await load(db, job.orgId, job.decisionId);
  if (!loaded) return;
  const { decision, item, project } = loaded;
  const flag = FLAG[job.step];
  if (decision.state !== "open" || decision[flag] !== null) return;
  const post =
    job.step === "escalate"
      ? await escalation(ctx, loaded)
      : await addresseeItem(db, job.orgId, loaded, job.step === "remind");
  let inboxItemId: string | null = null;
  if (post) {
    inboxItemId = (
      await ctx.inbox.post({
        orgId: job.orgId,
        link: `/p/collab/${PROJECTS}?item=${itemKey(project.key, item.number)}`,
        dedupeKey: job.step === "notify" ? decision.id : `${decision.id}-${job.step}`,
        ...post,
      })
    ).itemId;
  }
  const marked = await db
    .updateTable("decisions")
    .set({
      [flag]: new Date(),
      ...(inboxItemId
        ? { inbox_item_ids: (eb) => eb.fn("array_append", ["inbox_item_ids", eb.val(inboxItemId)]) }
        : {}),
    })
    .where("org_id", "=", job.orgId)
    .where("id", "=", decision.id)
    .where("state", "=", "open")
    .where(flag, "is", null)
    .returning("id")
    .executeTakeFirst();
  if (!marked && inboxItemId) {
    const now = await load(db, job.orgId, decision.id);
    // Answered in the meantime: its resolve may have missed this item.
    if (now && now.decision.state !== "open") {
      await ctx.inbox.resolve({ orgId: job.orgId, itemId: inboxItemId });
    }
  }
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

/** The addressee's item (the first notice, or the reminder at the deadline). */
async function addresseeItem(
  db: CollabDb,
  orgId: string,
  { decision, item, project }: Loaded,
  reminder: boolean,
): Promise<Post> {
  const key = itemKey(project.key, item.number);
  const options = decision.options as DecisionOption[];
  const rec = decision.recommendation as { optionId: string; why: string } | null;
  // Buttons only for a person who may answer (a gate routed to the owner to pick a confirmer has
  // none), and only when every option fits; otherwise the item links to the decision's page.
  const canAnswer = (await answerersOf(db, orgId, decision, item)).includes(
    decision.addressee_account_id,
  );
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
    accountId: decision.addressee_account_id,
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
  if (project.owner_account_id === decision.addressee_account_id) return null;
  const key = itemKey(project.key, item.number);
  let who = decision.addressee_account_id;
  try {
    const [person] = await ctx.people.get({ orgId: decision.org_id, accountIds: [who] });
    if (person) who = person.name;
  } catch {
    // The id stands in for the name.
  }
  return {
    accountId: project.owner_account_id,
    kind: "collab.decision.escalated",
    title: clip(`Unanswered decision on ${key} ${item.title}`, TITLE_CHARS),
    body: clip(
      `${who} has not answered since the deadline a day ago: ${decision.question}`,
      BODY_CHARS,
    ),
  };
}
