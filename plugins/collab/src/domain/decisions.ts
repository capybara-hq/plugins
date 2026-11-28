import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import { outboxFor } from "../events/outbox.js";
import type { CollabDb } from "../store/db.js";
import type { Actor, Decision, Item } from "../store/types.js";
import { requireRole } from "./access.js";
import {
  closeDecision,
  currentAddressee,
  type DecisionHooks,
  requireHooks,
} from "./decision-state.js";
import { CollabError } from "./errors.js";
import { actorJson, addActivity, isAgent, loadProject } from "./internal.js";
import { type AdditionGuard, type MoveOptions, transitionIn } from "./items.js";
import { statusesForType } from "./workflow.js";

/** One answer a decision offers. */
export interface DecisionOption {
  id: string;
  label: string;
}

export interface AskDecisionInput {
  itemId: string;
  question: string;
  /** None: the answer is free text. */
  options: DecisionOption[];
  recommendation?: { optionId: string; why: string } | undefined;
  blocking: boolean;
  /** Who must answer; default the item's responsible person (the project owner when none). */
  addressee?: string | undefined;
  /** Hours until the addressee is reminded (and a day later the project owner told). */
  deadlineHours?: number | undefined;
}

export interface AskDecisionOptions {
  /** The decision's id, chosen by the caller so it can queue the decision's jobs first. */
  id?: string;
  /** Runs on the locked item before the insert (e.g. the asking agent still works on it). */
  guard?: AdditionGuard;
  /** The decision's notify and expiry jobs (required: a new decision always owes them). */
  decisions?: DecisionHooks;
}

export interface DecisionAnswer {
  optionId?: string | undefined;
  text?: string | undefined;
}

/**
 * How an answer ended: `answered`; `closed` when the decision was no longer open (an earlier
 * click won, or it was canceled or expired: see `decision.state`); `superseded` when the item
 * moved past the gate since it was requested (the gate is canceled, nothing moves).
 */
export type AnswerOutcome = "answered" | "closed" | "superseded";

export interface AnswerResult {
  decision: Decision;
  item: Item;
  outcome: AnswerOutcome;
}

/** Input caps (longer input is refused with `invalid_input`). */
const MAX_QUESTION_CHARS = 2000;
const MAX_OPTIONS = 10;
const MAX_OPTION_LABEL_CHARS = 100;
const MAX_WHY_CHARS = 1000;
const MAX_ANSWER_CHARS = 2000;
const MAX_DEADLINE_HOURS = 24 * 30;
/** Open questions one asker (person, or person and agent) may have on one item. */
export const MAX_OPEN_QUESTIONS = 5;
/** A decision still open this long after it was asked expires. */
export const DECISION_EXPIRY_MS = 30 * 24 * 60 * 60 * 1000;
/**
 * An option id: short, stable, and an inbox action id (`INBOX_ID_RE`: starts with a letter or
 * digit), since the inbox buttons carry it as theirs.
 */
const OPTION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;
/** The options of every gate decision. */
export const GATE_APPROVE = "approve";
export const GATE_REJECT = "reject";

function checkOptions(options: DecisionOption[]): DecisionOption[] {
  if (options.length > MAX_OPTIONS) {
    throw new CollabError("invalid_input", `Offer at most ${MAX_OPTIONS} options.`);
  }
  const seen = new Set<string>();
  return options.map((o) => {
    const label = String(o.label ?? "").trim();
    if (!OPTION_ID.test(String(o.id)) || seen.has(o.id)) {
      throw new CollabError(
        "invalid_input",
        "Each option needs a unique id that starts with a letter or digit, followed by letters, digits, _ or - (at most 32 characters).",
      );
    }
    if (!label || label.length > MAX_OPTION_LABEL_CHARS) {
      throw new CollabError(
        "invalid_input",
        `Each option needs a label of at most ${MAX_OPTION_LABEL_CHARS} characters.`,
      );
    }
    seen.add(o.id);
    return { id: o.id, label };
  });
}

/** An active (non-guest) member of the project, else `invalid_assignee`. */
async function checkAddressee(
  tx: CollabDb,
  orgId: string,
  projectId: string,
  accountId: string,
): Promise<void> {
  const member = await tx
    .selectFrom("project_members")
    .select("account_id")
    .where("org_id", "=", orgId)
    .where("project_id", "=", projectId)
    .where("account_id", "=", accountId)
    .where("role", "!=", "guest")
    .executeTakeFirst();
  if (!member) {
    throw new CollabError(
      "invalid_assignee",
      "A decision is addressed to an owner or member of the item's project.",
    );
  }
}

/** The item locked `FOR NO KEY UPDATE` (reads go on; an assignment or move waits), or `not_found`. */
async function lockItem(tx: CollabDb, orgId: string, itemId: string): Promise<Item> {
  const item = await tx
    .selectFrom("items")
    .selectAll()
    .where("org_id", "=", orgId)
    .where("id", "=", itemId)
    .forNoKeyUpdate()
    .executeTakeFirst();
  if (!item) throw new CollabError("not_found", "Item not found.");
  return item;
}

/**
 * Asks a person a question about an item (a decision of kind `question`). The item is locked
 * like an addition and keeps its version. The same open question from the same asker to the
 * same person is returned instead of asked again; an asker has at most
 * {@link MAX_OPEN_QUESTIONS} open questions on an item. The deadline jobs are the caller's.
 */
export async function askDecision(
  db: CollabDb,
  orgId: string,
  actor: Actor,
  input: AskDecisionInput,
  opts: AskDecisionOptions = {},
): Promise<Decision> {
  const question = input.question.trim();
  if (!question || question.length > MAX_QUESTION_CHARS) {
    throw new CollabError(
      "invalid_input",
      `The question must not be empty and at most ${MAX_QUESTION_CHARS} characters.`,
    );
  }
  const options = checkOptions(input.options);
  const rec = input.recommendation;
  if (rec) {
    if (!options.some((o) => o.id === rec.optionId)) {
      throw new CollabError("invalid_input", "The recommendation must name one of the options.");
    }
    if (rec.why.length > MAX_WHY_CHARS) {
      throw new CollabError(
        "invalid_input",
        `The recommendation's reason must be at most ${MAX_WHY_CHARS} characters.`,
      );
    }
  }
  const hours = input.deadlineHours;
  if (
    hours !== undefined &&
    (!Number.isFinite(hours) || hours <= 0 || hours > MAX_DEADLINE_HOURS)
  ) {
    throw new CollabError(
      "invalid_input",
      `The deadline is a number of hours above 0 and at most ${MAX_DEADLINE_HOURS}.`,
    );
  }
  return db.transaction().execute(async (tx) => {
    const item = await lockItem(tx, orgId, input.itemId);
    await requireRole(tx, orgId, actor.accountId, item.project_id, "write");
    if (opts.guard) await opts.guard(tx, item);
    const project = await loadProject(tx, orgId, item.project_id);
    const addressee = input.addressee ?? item.responsible_account_id ?? project.owner_account_id;
    await checkAddressee(tx, orgId, project.id, addressee);
    // The item lock serializes asks on the item, so the count and the duplicate check hold.
    const mine = await tx
      .selectFrom("decisions")
      .selectAll()
      .where("org_id", "=", orgId)
      .where("item_id", "=", item.id)
      .where("kind", "=", "question")
      .where("state", "=", "open")
      .where(sql<string>`asker->>'accountId'`, "=", actor.accountId)
      .where(sql<string>`coalesce(asker->>'agentId', '')`, "=", isAgent(actor) ? actor.agentId : "")
      .execute();
    const same = mine.find((d) => d.question === question && d.addressee_account_id === addressee);
    if (same) return same;
    if (mine.length >= MAX_OPEN_QUESTIONS) {
      throw new CollabError(
        "invalid_input",
        `You already have ${MAX_OPEN_QUESTIONS} open questions on this item. Wait for answers (decision_list) before asking more.`,
      );
    }
    const id = opts.id ?? randomUUID();
    await requireHooks(opts.decisions, "asking a decision").created(id);
    const decision = await tx
      .insertInto("decisions")
      .values({
        id,
        org_id: orgId,
        item_id: item.id,
        kind: "question",
        asker: actorJson(actor),
        addressee_account_id: addressee,
        question,
        options: JSON.stringify(options),
        recommendation: rec ? JSON.stringify({ optionId: rec.optionId, why: rec.why }) : null,
        blocking: input.blocking,
        deadline_at:
          hours === undefined ? null : sql<Date>`now() + make_interval(secs => ${hours * 3600})`,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    await addActivity(tx, orgId, item.id, actor, "decision_asked", {
      decisionId: decision.id,
      addressee,
      blocking: input.blocking,
    });
    return decision;
  });
}

/** Who may answer a decision now (see `currentAddressee`). */
export async function answerersOf(
  db: CollabDb,
  orgId: string,
  decision: Decision,
  item: Item,
): Promise<string[]> {
  const project = await loadProject(db, orgId, item.project_id);
  return (await currentAddressee(db, orgId, project, item, decision)).answerers;
}

/** The answer as one line for the event summary and the activity. */
function answerText(decision: Decision, answer: DecisionAnswer): string {
  const options = decision.options as DecisionOption[];
  const chosen = options.find((o) => o.id === answer.optionId);
  const parts = [`Question: "${decision.question}"`];
  if (chosen) parts.push(`Answer: "${chosen.label}" (${chosen.id}).`);
  if (answer.text) parts.push(`${chosen ? "Note" : "Answer"}: ${answer.text}`);
  return parts.join(" ");
}

/**
 * Tells the asker what became of their decision: a directed `decision.answered` while the asking
 * pair still holds the item; otherwise (a person asked, or the item moved on to another pair) an
 * `item.updated`.
 */
async function reportToAsker(
  tx: CollabDb,
  orgId: string,
  actor: Actor,
  decision: Decision,
  item: Item,
  text: string,
  answered: boolean,
): Promise<void> {
  const project = await loadProject(tx, orgId, item.project_id);
  const statuses = await statusesForType(tx, orgId, item.project_id, item.type);
  const base = {
    actor,
    projectKey: project.key,
    statusCategory: statuses.find((s) => s.key === item.status_key)?.category ?? "todo",
  };
  const asker = decision.asker;
  const holds =
    isAgent(asker) &&
    item.responsible_account_id === asker.accountId &&
    item.executing_agent_id === asker.agentId;
  if (answered && holds && isAgent(asker)) {
    await outboxFor(tx, orgId, "decision.answered", item, {
      ...base,
      audience: { accountId: asker.accountId, agentId: asker.agentId },
      decisionId: decision.id,
      detail: { answer: text },
    });
    return;
  }
  // An expiry is told only to an asking pair that still holds the item.
  if (!answered && !holds) return;
  await outboxFor(tx, orgId, "item.updated", item, {
    ...base,
    changedFields: ["decisions"],
    dedupeKey: `item.updated-decision-${decision.id}`,
    detail: { answer: text },
  });
}

/**
 * A person answers a decision (the UI action path; there is no answer tool, an agent never
 * answers). Only the addressee (a question; the project owner once the addressee left) or a
 * confirmer (a gate) may. The item is locked first; a gate the item moved past since it was
 * requested is canceled instead (`superseded`). The decision is marked answered by a conditional
 * update, so a second click changes nothing; an approved gate then moves the item, with the
 * confirmer as the actor, in the same transaction.
 */
export async function answerDecision(
  db: CollabDb,
  orgId: string,
  personAccountId: string,
  decisionId: string,
  answer: DecisionAnswer,
  opts: MoveOptions = {},
): Promise<AnswerResult> {
  const text = answer.text?.trim() || undefined;
  if (text && text.length > MAX_ANSWER_CHARS) {
    throw new CollabError(
      "invalid_input",
      `The answer must be at most ${MAX_ANSWER_CHARS} characters.`,
    );
  }
  return db.transaction().execute(async (tx) => {
    const found = await tx
      .selectFrom("decisions")
      .select("item_id")
      .where("org_id", "=", orgId)
      .where("id", "=", decisionId)
      .executeTakeFirst();
    if (!found) throw new CollabError("not_found", "Decision not found.");
    const item = await lockItem(tx, orgId, found.item_id);
    const current = await tx
      .selectFrom("decisions")
      .selectAll()
      .where("org_id", "=", orgId)
      .where("id", "=", decisionId)
      .executeTakeFirstOrThrow();
    await requireRole(tx, orgId, personAccountId, item.project_id, "read");
    if (current.state !== "open") return { decision: current, item, outcome: "closed" };
    const actor: Actor = { accountId: personAccountId };
    const answerers = await answerersOf(tx, orgId, current, item);
    if (!answerers.includes(personAccountId)) {
      throw new CollabError(
        "forbidden",
        current.kind === "gate"
          ? "Only the gate's confirmer can answer it."
          : "Only the person the decision is addressed to can answer it.",
      );
    }
    // Only a permitted answerer (or a move) closes a gate the item moved past.
    if (
      current.kind === "gate" &&
      current.gate_from !== null &&
      item.status_key !== current.gate_from &&
      item.status_key !== current.gate_target
    ) {
      await closeDecision(tx, orgId, actor, current, "canceled", "superseded", opts.decisions);
      return { decision: { ...current, state: "canceled" }, item, outcome: "superseded" };
    }
    const options = current.options as DecisionOption[];
    if (answer.optionId !== undefined && !options.some((o) => o.id === answer.optionId)) {
      throw new CollabError("invalid_input", "Pick one of the decision's options.");
    }
    if (options.length > 0 ? answer.optionId === undefined : !text) {
      throw new CollabError(
        "invalid_input",
        options.length > 0 ? "Pick one of the decision's options." : "Write an answer.",
      );
    }
    const hooks = requireHooks(opts.decisions, "answering a decision");
    const decision = await tx
      .updateTable("decisions")
      .set({
        state: "answered",
        answer: JSON.stringify({
          ...(answer.optionId !== undefined ? { optionId: answer.optionId } : {}),
          ...(text ? { text } : {}),
          accountId: personAccountId,
        }),
        answered_at: sql`now()`,
      })
      .where("org_id", "=", orgId)
      .where("id", "=", decisionId)
      .where("answered_at", "is", null)
      .where("state", "=", "open")
      .returningAll()
      .executeTakeFirst();
    if (!decision) return { decision: current, item, outcome: "closed" };
    let after = item;
    if (
      decision.kind === "gate" &&
      answer.optionId === GATE_APPROVE &&
      decision.gate_target &&
      item.status_key !== decision.gate_target
    ) {
      const moved = await transitionIn(
        tx,
        orgId,
        actor,
        item.id,
        item.version,
        decision.gate_target,
        opts,
      );
      after = "item" in moved ? moved.item : item;
    }
    // Queued once every step that can refuse has passed, so a rolled-back answer owes nothing.
    await hooks.closed(decisionId);
    await addActivity(tx, orgId, item.id, actor, "decision_answered", {
      decisionId,
      ...(answer.optionId !== undefined ? { optionId: answer.optionId } : {}),
    });
    await reportToAsker(
      tx,
      orgId,
      actor,
      decision,
      after,
      answerText(decision, { optionId: answer.optionId, text }),
      true,
    );
    return { decision, item: after, outcome: "answered" };
  });
}

/**
 * Expires a decision still open {@link DECISION_EXPIRY_MS} after it was asked (its expiry job).
 * The asking pair, if it still holds the item, gets an `item.updated` saying so. Returns the
 * decision when it expired now, null when there was nothing to do.
 */
export async function expireDecision(
  db: CollabDb,
  orgId: string,
  decisionId: string,
  hooks: DecisionHooks,
): Promise<Decision | null> {
  return db.transaction().execute(async (tx) => {
    const found = await tx
      .selectFrom("decisions")
      .select(["item_id", "state"])
      .where("org_id", "=", orgId)
      .where("id", "=", decisionId)
      .executeTakeFirst();
    if (found?.state !== "open") return null;
    const item = await lockItem(tx, orgId, found.item_id);
    const decision = await tx
      .selectFrom("decisions")
      .selectAll()
      .where("org_id", "=", orgId)
      .where("id", "=", decisionId)
      .where("state", "=", "open")
      .where("created_at", "<=", sql<Date>`now() - interval '30 days' + interval '1 minute'`)
      .executeTakeFirst();
    if (!decision) return null;
    const project = await loadProject(tx, orgId, item.project_id);
    // The owner stands for the plugin as the actor of an expiry.
    const actor: Actor = { accountId: project.owner_account_id };
    if (!(await closeDecision(tx, orgId, actor, decision, "expired", "unanswered", hooks))) {
      return null;
    }
    await reportToAsker(
      tx,
      orgId,
      actor,
      decision,
      item,
      `Question: "${decision.question}" expired unanswered after 30 days.`,
      false,
    );
    return { ...decision, state: "expired" };
  });
}
