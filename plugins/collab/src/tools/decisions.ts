import { randomUUID } from "node:crypto";
import type { ToolSpec } from "@capybara-hq/plugin-sdk";
import { type SqlBool, sql } from "kysely";
import { decisionHooks, queueDeadline } from "../decisions-queue.js";
import { askDecision, type DecisionOption } from "../domain/decisions.js";
import { CollabError } from "../domain/errors.js";
import type { DecisionState } from "../store/types.js";
import {
  guarded,
  itemByKey,
  namesOf,
  optStr,
  personOf,
  resolvePerson,
  stillAssignedGuard,
  str,
  type ToolDeps,
  writing,
} from "./common.js";
import { actorLabel, keyOf, personLabel, result } from "./format.js";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
// capybara:allow-module-state read-only constant
const STATES: readonly DecisionState[] = ["open", "answered", "canceled", "expired"];

const DECISION_LIST: ToolSpec = {
  name: "decision_list",
  title: "List decisions",
  description:
    "List decisions (questions and gate confirmations) on tracker items you can see: who asked, " +
    "who must answer, the options, and the answer once given.\n" +
    "Filter by item key, state (open by default), or decisions addressed to your person. Use it " +
    "to check whether a question or gate you raised was answered before asking again.",
  inputSchema: {
    type: "object",
    properties: {
      key: { type: "string", description: 'An item key, e.g. "CAP-12".' },
      state: {
        type: "string",
        enum: [...STATES, "any"],
        description: 'open (default), answered, canceled, expired or "any".',
      },
      addressedToMe: {
        type: "boolean",
        description: "Only decisions your person must answer.",
      },
      limit: {
        type: "integer",
        minimum: 1,
        maximum: MAX_LIMIT,
        description: `Most decisions to return (1 to ${MAX_LIMIT}, default ${DEFAULT_LIMIT}).`,
      },
    },
    additionalProperties: false,
  },
  keyArgs: ["key", "state"],
  annotations: { readOnlyHint: true },
  defaultPolicy: "allow",
};

const DECISION_ASK: ToolSpec = {
  name: "decision_ask",
  title: "Ask a decision",
  description:
    "Ask a person to decide something about a tracker item: a question with up to 10 options (or " +
    "free text), your recommendation, and whether your work is blocked on it.\n" +
    "The person gets an inbox item (with answer buttons for up to 3 options); the answer arrives " +
    "in this conversation. Ask the item's responsible person by default. Use it for choices a " +
    "person must make (scope, trade-offs, approvals); use item_comment for updates that need no " +
    "answer, and item_transition for gated status changes. Check decision_list before asking again.",
  inputSchema: {
    type: "object",
    properties: {
      key: { type: "string", description: 'The item key, e.g. "CAP-12".' },
      question: {
        type: "string",
        maxLength: 2000,
        description: "The question, self-contained: the person reads it in their inbox.",
      },
      options: {
        type: "array",
        maxItems: 10,
        items: {
          type: "object",
          properties: {
            id: {
              type: "string",
              description:
                "A short id: starts with a letter or digit, then letters, digits, _ or - (at most 32).",
            },
            label: { type: "string", maxLength: 100, description: "What the person picks." },
          },
          required: ["id", "label"],
          additionalProperties: false,
        },
        description: "The answers to pick from; omit for a free-text answer.",
      },
      recommendation: {
        type: "object",
        properties: {
          optionId: { type: "string", description: "The option you recommend." },
          why: { type: "string", maxLength: 1000, description: "Why, in one or two sentences." },
        },
        required: ["optionId", "why"],
        additionalProperties: false,
      },
      blocking: {
        type: "boolean",
        description:
          "true when work that depends on the answer must wait; false to proceed with the recommendation.",
      },
      addressee: {
        type: "string",
        description:
          "Who must answer: \"me\", an account id or a project member's name. Default the item's responsible person.",
      },
      deadlineHours: {
        type: "number",
        exclusiveMinimum: 0,
        maximum: 720,
        description:
          "Hours until the person is reminded; the project owner is told a day after that.",
      },
    },
    required: ["key", "question", "blocking"],
    additionalProperties: false,
  },
  keyArgs: ["key"],
  defaultPolicy: "allow",
};

function optionsOf(input: Record<string, unknown>): DecisionOption[] {
  const raw = input.options;
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new CollabError("invalid_input", '"options" must be a list.');
  return raw.map((o) => {
    const v = (o ?? {}) as Record<string, unknown>;
    return { id: String(v.id ?? ""), label: String(v.label ?? "") };
  });
}

function recommendationOf(
  input: Record<string, unknown>,
): { optionId: string; why: string } | undefined {
  const r = input.recommendation as Record<string, unknown> | undefined;
  if (!r) return undefined;
  return { optionId: String(r.optionId ?? ""), why: String(r.why ?? "") };
}

/** Registers decision_ask and decision_list (no answer tool: only a person answers). */
export function registerDecisionTools(deps: ToolDeps): void {
  const { ctx, db } = deps;
  ctx.tools.register(
    DECISION_ASK,
    guarded(async (input, call) => {
      const person = personOf(call);
      const { item, project } = await itemByKey(db, call.orgId, person, str(input, "key"));
      if (typeof input.blocking !== "boolean") {
        throw new CollabError("invalid_input", 'Missing "blocking" (true or false).');
      }
      const blocking = input.blocking;
      const addresseeArg = optStr(input, "addressee");
      const addressee = addresseeArg
        ? await resolvePerson(deps, call.orgId, project.id, person, addresseeArg)
        : undefined;
      const deadlineHours =
        typeof input.deadlineHours === "number" ? input.deadlineHours : undefined;
      // Intent first: the decision's jobs are queued before it is written (a rolled-back write
      // leaves them nothing to do).
      const id = randomUUID();
      const follow = decisionHooks(ctx, call.orgId);
      if (deadlineHours !== undefined && deadlineHours > 0 && deadlineHours <= 720) {
        await queueDeadline(ctx, call.orgId, id, deadlineHours);
      }
      const decision = await writing(deps, call, (actor) =>
        askDecision(
          db,
          call.orgId,
          actor,
          {
            itemId: item.id,
            question: str(input, "question"),
            options: optionsOf(input),
            recommendation: recommendationOf(input),
            blocking,
            addressee,
            deadlineHours,
          },
          { id, guard: stillAssignedGuard(deps, call), decisions: follow.hooks },
        ),
      );
      await follow.flush();
      const names = await namesOf(deps, call.orgId, [decision.addressee_account_id]);
      const who = names.get(decision.addressee_account_id) ?? decision.addressee_account_id;
      const key = keyOf(project.key, item);
      const next = blocking
        ? "Stop work that depends on this answer; the answer will arrive in this conversation."
        : "Proceed with the recommended option; the answer will arrive in this conversation.";
      if (decision.id !== id) {
        return result(
          `You already asked ${who} this on ${key}; it is still open (decision ${decision.id}). ${next}`,
          { zh: `已询问过 ${who}`, en: `Already asked ${who}` },
        );
      }
      return result(`Asked ${who}. ${next} (decision ${decision.id} on ${key})`, {
        zh: `已询问 ${who}`,
        en: `Asked ${who}`,
      });
    }),
  );
  ctx.tools.register(
    DECISION_LIST,
    guarded(async (input, call) => {
      const person = personOf(call);
      const limit =
        typeof input.limit === "number"
          ? Math.min(Math.max(1, Math.trunc(input.limit)), MAX_LIMIT)
          : DEFAULT_LIMIT;
      let q = db
        .selectFrom("decisions as d")
        .innerJoin("items as i", "i.id", "d.item_id")
        .innerJoin("projects as p", "p.id", "i.project_id")
        .innerJoin("project_members as m", (j) =>
          j.onRef("m.project_id", "=", "p.id").on("m.account_id", "=", person),
        )
        .selectAll("d")
        .select(["p.key as project_key", "i.number", "i.title"])
        .where("d.org_id", "=", call.orgId)
        .where("i.org_id", "=", call.orgId)
        .where("p.org_id", "=", call.orgId)
        .where("m.org_id", "=", call.orgId);
      const key = optStr(input, "key");
      if (key)
        q = q.where("d.item_id", "=", (await itemByKey(db, call.orgId, person, key)).item.id);
      const state = optStr(input, "state") ?? "open";
      if (state !== "any") q = q.where("d.state", "=", state as DecisionState);
      // Every recipient counts (each confirmer of a gate several members may confirm).
      if (input.addressedToMe === true) {
        q = q.where(
          sql<SqlBool>`(d.addressee_account_id = ${person} OR ${person} = ANY(d.addressees))`,
        );
      }
      const rows = await q.orderBy("d.created_at", "desc").limit(limit).execute();
      if (rows.length === 0) {
        return result(`No ${state === "any" ? "" : `${state} `}decisions match.`);
      }
      const names = await namesOf(deps, call.orgId, [
        ...rows.map((r) => r.addressee_account_id),
        ...rows.map((r) => r.asker.accountId),
      ]);
      const lines = rows.map((r) => {
        const options = (r.options as { id: string; label: string }[])
          .map((o) => `${o.id} "${o.label}"`)
          .join(", ");
        const gate = r.gate_target ? ` gate to "${r.gate_target}";` : "";
        const answer = r.answer ? ` answer: ${JSON.stringify(r.answer)};` : "";
        return (
          `- ${r.id} on ${r.project_key}-${r.number} "${r.title}" [${r.kind}, ${r.state}${r.blocking ? ", blocking" : ""}]:${gate} ` +
          `"${r.question}" asked by ${actorLabel(names, r.asker)}, waiting on ${personLabel(names, r.addressee_account_id)}; options: ${options || "free text"};${answer}`
        );
      });
      return result(`${rows.length} decisions:\n${lines.join("\n")}`, {
        zh: `列出 ${rows.length} 个决策`,
        en: `Listed ${rows.length} decisions`,
      });
    }),
  );
}
