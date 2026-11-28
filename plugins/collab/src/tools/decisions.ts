import type { ToolSpec } from "@capybara-hq/plugin-sdk";
import type { DecisionState } from "../store/types.js";
import { guarded, itemByKey, namesOf, optStr, personOf, type ToolDeps } from "./common.js";
import { actorLabel, personLabel, result } from "./format.js";

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

/** Registers decision_list (decision_ask arrives with the decisions task). */
export function registerDecisionTools(deps: ToolDeps): void {
  const { ctx, db } = deps;
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
      if (input.addressedToMe === true) q = q.where("d.addressee_account_id", "=", person);
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
