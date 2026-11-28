import { sql } from "kysely";
import { outboxFor } from "../events/outbox.js";
import type { CollabDb } from "../store/db.js";
import type { Actor, Decision, Item } from "../store/types.js";
import { requireRole } from "./access.js";
import { CollabError } from "./errors.js";
import { actorJson, addActivity, isAgent, loadItem, loadProject } from "./internal.js";
import { type AdditionGuard, gateConfirmers, type MoveOptions, transitionIn } from "./items.js";
import { gateOf, statusesForType } from "./workflow.js";

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
}

export interface DecisionAnswer {
  optionId?: string | undefined;
  text?: string | undefined;
}

/** The result of an answer: `alreadyAnswered` when an earlier click won (nothing changed). */
export interface AnswerResult {
  decision: Decision;
  item: Item;
  alreadyAnswered: boolean;
}

/** Input caps (longer input is refused with `invalid_input`). */
const MAX_QUESTION_CHARS = 2000;
const MAX_OPTIONS = 10;
const MAX_OPTION_LABEL_CHARS = 100;
const MAX_WHY_CHARS = 1000;
const MAX_ANSWER_CHARS = 2000;
const MAX_DEADLINE_HOURS = 24 * 30;
/** An option id: short, stable, safe in an inbox action payload. */
const OPTION_ID = /^[A-Za-z0-9_-]{1,32}$/;
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
        "Each option needs a unique id of letters, digits, _ or - (at most 32 characters).",
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

/**
 * Asks a person a question about an item (a decision of kind `question`). The item is locked
 * like an addition (`FOR NO KEY UPDATE`) and keeps its version. Notifying the addressee (inbox)
 * and the deadline jobs are the caller's (`decisions-queue.ts`), queued before this write.
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
    const item = await tx
      .selectFrom("items")
      .selectAll()
      .where("org_id", "=", orgId)
      .where("id", "=", input.itemId)
      .forNoKeyUpdate()
      .executeTakeFirst();
    if (!item) throw new CollabError("not_found", "Item not found.");
    await requireRole(tx, orgId, actor.accountId, item.project_id, "write");
    if (opts.guard) await opts.guard(tx, item);
    const project = await loadProject(tx, orgId, item.project_id);
    const addressee = input.addressee ?? item.responsible_account_id ?? project.owner_account_id;
    await checkAddressee(tx, orgId, project.id, addressee);
    const decision = await tx
      .insertInto("decisions")
      .values({
        ...(opts.id ? { id: opts.id } : {}),
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

/**
 * Who may answer a decision now: its addressee (a question), or the gate's confirmers as the
 * gate rule names them today (a gate).
 */
export async function answerersOf(
  db: CollabDb,
  orgId: string,
  decision: Decision,
  item: Item,
): Promise<string[]> {
  if (decision.kind === "question") return [decision.addressee_account_id];
  const project = await loadProject(db, orgId, item.project_id);
  const statuses = await statusesForType(db, orgId, item.project_id, item.type);
  const target = statuses.find((s) => s.key === decision.gate_target);
  const gate = target ? gateOf(target) : null;
  if (!gate) return [project.owner_account_id];
  return (await gateConfirmers(db, orgId, project, item, gate)).confirmers;
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
 * A person answers a decision (the UI action path; there is no answer tool, an agent never
 * answers). Only the addressee (a question) or a confirmer (a gate) may. The decision is marked
 * answered first, by a conditional update, so a second click changes nothing; an approved gate
 * then moves the item, with the confirmer as the actor, in the same transaction. The asking pair
 * gets a directed `decision.answered` while the item is still theirs; otherwise (a person asked,
 * or the item moved on to another pair) the answer is an `item.updated`.
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
      .selectAll()
      .where("org_id", "=", orgId)
      .where("id", "=", decisionId)
      .executeTakeFirst();
    if (!found) throw new CollabError("not_found", "Decision not found.");
    const item = await loadItem(tx, orgId, found.item_id);
    await requireRole(tx, orgId, personAccountId, item.project_id, "read");
    if (found.state !== "open") return { decision: found, item, alreadyAnswered: true };
    const answerers = await answerersOf(tx, orgId, found, item);
    if (!answerers.includes(personAccountId)) {
      throw new CollabError(
        "forbidden",
        found.kind === "gate"
          ? "Only the gate's confirmer can answer it."
          : "Only the person the decision is addressed to can answer it.",
      );
    }
    const options = found.options as DecisionOption[];
    if (answer.optionId !== undefined && !options.some((o) => o.id === answer.optionId)) {
      throw new CollabError("invalid_input", "Pick one of the decision's options.");
    }
    if (options.length > 0 ? answer.optionId === undefined : !text) {
      throw new CollabError(
        "invalid_input",
        options.length > 0 ? "Pick one of the decision's options." : "Write an answer.",
      );
    }
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
    if (!decision) {
      const current = await tx
        .selectFrom("decisions")
        .selectAll()
        .where("org_id", "=", orgId)
        .where("id", "=", decisionId)
        .executeTakeFirstOrThrow();
      return { decision: current, item, alreadyAnswered: true };
    }
    const actor: Actor = { accountId: personAccountId };
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
    const summary = answerText(decision, { optionId: answer.optionId, text });
    await addActivity(tx, orgId, item.id, actor, "decision_answered", {
      decisionId,
      ...(answer.optionId !== undefined ? { optionId: answer.optionId } : {}),
    });
    const project = await loadProject(tx, orgId, item.project_id);
    const statuses = await statusesForType(tx, orgId, item.project_id, item.type);
    const base = {
      actor,
      projectKey: project.key,
      statusCategory: statuses.find((s) => s.key === after.status_key)?.category ?? "todo",
    };
    const asker = decision.asker;
    if (
      isAgent(asker) &&
      after.responsible_account_id === asker.accountId &&
      after.executing_agent_id === asker.agentId
    ) {
      await outboxFor(tx, orgId, "decision.answered", after, {
        ...base,
        audience: { accountId: asker.accountId, agentId: asker.agentId },
        decisionId,
        detail: { answer: summary },
      });
    } else {
      await outboxFor(tx, orgId, "item.updated", after, {
        ...base,
        changedFields: ["decisions"],
        dedupeKey: `item.updated-decision-${decisionId}`,
        detail: { answer: summary },
      });
    }
    return { decision, item: after, alreadyAnswered: false };
  });
}
