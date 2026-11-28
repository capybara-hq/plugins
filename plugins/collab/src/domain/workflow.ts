import type { CollabDb } from "../store/db.js";
import type { Status, StatusCategory } from "../store/types.js";
import { CollabError } from "./errors.js";

/**
 * Who confirms a gated status (stored in `statuses.gate`): the person who asked for the item
 * (its creator, unchanged by assignment), the item's responsible person, the project owner, a
 * named member, or any member with a function label.
 */
export type GateRule =
  | { confirmer: "requester" }
  | { confirmer: "responsible" }
  | { confirmer: "owner" }
  | { confirmer: "member"; accountId: string }
  | { confirmer: "function"; functionLabel: string };

/**
 * Who an item is handed to when it enters a status (stored in `statuses.default_assignment`).
 * `accountId` names a member; otherwise `functionLabel` resolves to the one member with that label.
 * The agent is `agentId`, or with `memberAgent` the resolved member's default agent, or none.
 */
export interface DefaultAssignmentRule {
  accountId?: string;
  functionLabel?: string;
  agentId?: string;
  memberAgent?: boolean;
}

/** The status categories that close an item. */
// capybara:allow-module-state read-only constant
const CLOSED_CATEGORIES: readonly StatusCategory[] = ["done", "canceled"];

export function isClosed(category: StatusCategory): boolean {
  return CLOSED_CATEGORIES.includes(category);
}

export function gateOf(status: Status): GateRule | null {
  return (status.gate as GateRule | null) ?? null;
}

export function defaultAssignmentOf(status: Status): DefaultAssignmentRule | null {
  return (status.default_assignment as DefaultAssignmentRule | null) ?? null;
}

/** The workflow id of an item type in a project. */
async function workflowIdOf(
  db: CollabDb,
  orgId: string,
  projectId: string,
  itemType: string,
): Promise<string> {
  const row = await db
    .selectFrom("item_types")
    .select("workflow_id")
    .where("org_id", "=", orgId)
    .where("project_id", "=", projectId)
    .where("key", "=", itemType)
    .executeTakeFirst();
  if (!row) throw new CollabError("invalid_input", `Unknown item type "${itemType}".`);
  if (!row.workflow_id) {
    throw new CollabError("invalid_input", `Item type "${itemType}" has no workflow.`);
  }
  return row.workflow_id;
}

/** The statuses of a workflow in board order. */
async function statusesOf(db: CollabDb, orgId: string, workflowId: string): Promise<Status[]> {
  return db
    .selectFrom("statuses")
    .selectAll()
    .where("org_id", "=", orgId)
    .where("workflow_id", "=", workflowId)
    .orderBy("position")
    .execute();
}

/** The statuses of an item type's workflow in board order. */
export async function statusesForType(
  db: CollabDb,
  orgId: string,
  projectId: string,
  itemType: string,
): Promise<Status[]> {
  return statusesOf(db, orgId, await workflowIdOf(db, orgId, projectId, itemType));
}

/** The status a new item starts in: the first one on the board that does not close it. */
export function initialStatus(statuses: Status[]): Status {
  const first = statuses.find((s) => !isClosed(s.category)) ?? statuses[0];
  if (!first) throw new CollabError("invalid_input", "The workflow has no statuses.");
  return first;
}

/**
 * Checks a move from `from` to `to`: the target must exist in the workflow and, when `from`
 * lists allowed next statuses, be one of them.
 */
export function checkTransition(statuses: Status[], fromKey: string, toKey: string): Status {
  const to = statuses.find((s) => s.key === toKey);
  if (!to) {
    const keys = statuses.map((s) => s.key).join(", ");
    throw new CollabError(
      "invalid_transition",
      `Unknown status "${toKey}". Statuses of this item: ${keys}.`,
    );
  }
  if (toKey === fromKey) {
    throw new CollabError("invalid_transition", `The item is already in "${toKey}".`);
  }
  const from = statuses.find((s) => s.key === fromKey);
  if (from?.next_keys && !from.next_keys.includes(toKey)) {
    throw new CollabError(
      "invalid_transition",
      `Cannot move from "${fromKey}" to "${toKey}". Allowed next statuses: ${from.next_keys.join(", ") || "none"}.`,
    );
  }
  return to;
}
