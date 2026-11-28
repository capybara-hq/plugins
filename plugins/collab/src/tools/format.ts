import { ToolError, type ToolResult } from "@capybara-hq/plugin-sdk";
import type { CollabError } from "../domain/errors.js";
import type { Actor, Item, Status } from "../store/types.js";

/** The item's key: `<PROJECT>-<n>`. */
export function keyOf(projectKey: string, item: Pick<Item, "number">): string {
  return `${projectKey}-${item.number}`;
}

/** The domain's refusal with the next step for the model. */
function errorText(error: CollabError): string {
  const m = error.message;
  switch (error.code) {
    case "not_found":
      return `${m} Check the key with item_search or project_list; only projects you are a member of are visible.`;
    case "forbidden":
      return `${m} Ask a project owner to do it, or ask the user how to continue.`;
    case "invalid_input":
      return `${m} Check the arguments and retry.`;
    case "version_conflict":
      return `${m} Call item_get for the current version, check the change still applies, then retry with it.`;
    case "invalid_transition":
      return `${m} Pass one of the allowed statuses (item_get lists them).`;
    case "gated":
      return `${m} Ask that person to confirm it.`;
    case "invalid_assignee":
      return `${m} Check project_list for the members and retry.`;
    case "no_longer_assigned":
      return `${m} Stop working on it and do not retry; tell the user, or call item_get to see who has it now.`;
    case "watcher_limit":
      return `${m} Ask the person whether they want to try again later.`;
    case "archived":
      return `${m} Do not retry; tell the user the project is archived.`;
  }
}

/** The `ToolError` for a domain refusal. */
export function toolError(error: CollabError): ToolError {
  return new ToolError(errorText(error));
}

/** A result: the model's text plus the people-facing summary (never sent to the model). */
export function result(text: string, summary?: { zh: string; en: string }): ToolResult {
  return {
    content: [{ type: "text", text }],
    ...(summary ? { display: { summary: clipSummary(summary) } } : {}),
  };
}

/** Display summaries are at most 200 code points per language. */
function clipSummary(s: { zh: string; en: string }): { zh: string; en: string } {
  const clip = (t: string) => {
    const cps = [...t];
    return cps.length <= 200 ? t : `${cps.slice(0, 199).join("")}…`;
  };
  return { zh: clip(s.zh), en: clip(s.en) };
}

/** The status's key with its English name, e.g. `in_progress ("In progress")`. */
export function statusLabel(statuses: Status[], key: string): string {
  const s = statuses.find((x) => x.key === key);
  return s ? `${key} ("${s.name_en}")` : key;
}

/** The statuses the item may move to next. */
export function nextStatuses(statuses: Status[], key: string): string[] {
  const from = statuses.find((s) => s.key === key);
  return from?.next_keys ?? statuses.filter((s) => s.key !== key).map((s) => s.key);
}

/** "Zhang" or "Zhang (acct-id)" when the name is the id. */
export function personLabel(names: Map<string, string>, id: string | null): string {
  if (!id) return "none";
  const name = names.get(id);
  return name && name !== id ? `${name} (${id})` : id;
}

/** An agent id with its name when known. */
export function agentLabel(agents: Map<string, string>, id: string | null): string {
  if (!id) return "none";
  const name = agents.get(id);
  return name ? `${name} (${id})` : id;
}

/** Who did something, for activity and comments. */
export function actorLabel(names: Map<string, string>, actor: Actor): string {
  const who = names.get(actor.accountId) ?? actor.accountId;
  return "agentId" in actor ? `${who}'s agent ${actor.agentId}` : who;
}

/** One line per item, for lists. */
export function itemLine(projectKey: string, item: Item, names: Map<string, string>): string {
  const who = item.responsible_account_id
    ? `responsible ${personLabel(names, item.responsible_account_id)}${item.executing_agent_id ? `, agent ${item.executing_agent_id}` : ""}`
    : "unassigned";
  return `- ${keyOf(projectKey, item)} [${item.type}] ${item.status_key} "${item.title}" (${who}; priority ${item.priority}; version ${item.version})`;
}

/** Priority words: 0 none, 1 urgent, 2 high, 3 normal, 4 low. */
// capybara:allow-module-state read-only constant
export const PRIORITY_NAMES = ["none", "urgent", "high", "normal", "low"] as const;
