import { outboxFor } from "../events/outbox.js";
import type { CollabDb } from "../store/db.js";
import type { Actor, Item, Status } from "../store/types.js";
import { requireRole } from "./access.js";
import { CollabError } from "./errors.js";
import { addActivity, checkVersion, loadItem, loadProject, writeItem } from "./internal.js";
import { defaultAssignmentOf, statusesForType } from "./workflow.js";

/** A responsible person and the agent working for them (or none). */
export interface Assignee {
  accountId: string;
  agentId: string | null;
}

/** The responsible person must be a project member who may write (owner or member, not a guest). */
export async function validateAssignee(
  db: CollabDb,
  orgId: string,
  projectId: string,
  accountId: string,
): Promise<void> {
  const member = await db
    .selectFrom("project_members")
    .select("role")
    .where("org_id", "=", orgId)
    .where("project_id", "=", projectId)
    .where("account_id", "=", accountId)
    .executeTakeFirst();
  if (!member || member.role === "guest") {
    throw new CollabError(
      "invalid_assignee",
      "The responsible person must be an owner or member of the project. Add them to the project first.",
    );
  }
}

/**
 * Who an item entering `status` is handed to: the named member, or the one member carrying the
 * function label, with the rule's agent or (with `memberAgent`) that member's default agent.
 * Null when the status has no rule or the label matches no member or several.
 */
export async function resolveDefaultAssignment(
  db: CollabDb,
  orgId: string,
  projectId: string,
  status: Status,
): Promise<Assignee | null> {
  const rule = defaultAssignmentOf(status);
  if (!rule) return null;
  let query = db
    .selectFrom("project_members")
    .select(["account_id", "default_agent_id"])
    .where("org_id", "=", orgId)
    .where("project_id", "=", projectId)
    .where("role", "!=", "guest");
  if (rule.accountId) query = query.where("account_id", "=", rule.accountId);
  else if (rule.functionLabel) query = query.where("function_label", "=", rule.functionLabel);
  else return null;
  const members = await query.limit(2).execute();
  const member = members.length === 1 ? members[0] : undefined;
  if (!member) return null;
  const agentId = rule.agentId ?? (rule.memberAgent ? member.default_agent_id : null);
  return { accountId: member.account_id, agentId };
}

/** True when the pair differs from the item's current one. */
export function assignmentDiffers(item: Item, target: Assignee): boolean {
  return (
    item.responsible_account_id !== target.accountId || item.executing_agent_id !== target.agentId
  );
}

/**
 * Records an assignment change already written to the item: the activity entry and the events.
 * A new pair with an agent gets a directed `item.assigned`; an agent losing the item gets a
 * directed `item.unassigned` (to the old pair); a person-only change is an `item.updated`.
 */
export async function recordAssignment(
  tx: CollabDb,
  orgId: string,
  actor: Actor,
  before: Item,
  after: Item,
  ctx: { projectKey: string; statusCategory: Status["category"] },
): Promise<void> {
  const from = { accountId: before.responsible_account_id, agentId: before.executing_agent_id };
  const to = { accountId: after.responsible_account_id, agentId: after.executing_agent_id };
  if (from.accountId === to.accountId && from.agentId === to.agentId) return;
  await addActivity(tx, orgId, after.id, actor, "assigned", { from, to });
  const base = { actor, projectKey: ctx.projectKey, statusCategory: ctx.statusCategory };
  if (to.accountId && to.agentId) {
    await outboxFor(tx, orgId, "item.assigned", after, {
      ...base,
      changedFields: ["responsible", "agent"],
      audience: { accountId: to.accountId, agentId: to.agentId },
      detail: { responsibleAccountId: to.accountId, executingAgentId: to.agentId },
    });
  } else {
    await outboxFor(tx, orgId, "item.updated", after, {
      ...base,
      changedFields: from.accountId === to.accountId ? ["agent"] : ["responsible", "agent"],
    });
  }
  if (
    from.accountId &&
    from.agentId &&
    (from.agentId !== to.agentId || from.accountId !== to.accountId)
  ) {
    await outboxFor(tx, orgId, "item.unassigned", after, {
      ...base,
      audience: { accountId: from.accountId, agentId: from.agentId },
      detail: { responsibleAccountId: from.accountId, executingAgentId: from.agentId },
    });
  }
}

/**
 * Hands the item to a responsible person and their agent (or no agent). Whether the agent is one
 * the person may use is the caller's check (it needs the kernel's agent list).
 */
export async function assign(
  db: CollabDb,
  orgId: string,
  actor: Actor,
  itemId: string,
  version: number,
  target: { responsibleAccountId: string; executingAgentId: string | null },
): Promise<Item> {
  return db.transaction().execute(async (tx) => {
    const item = await loadItem(tx, orgId, itemId);
    await requireRole(tx, orgId, actor.accountId, item.project_id, "write");
    checkVersion(item, version);
    await validateAssignee(tx, orgId, item.project_id, target.responsibleAccountId);
    const pair = { accountId: target.responsibleAccountId, agentId: target.executingAgentId };
    if (!assignmentDiffers(item, pair)) return item;
    const project = await loadProject(tx, orgId, item.project_id);
    const statuses = await statusesForType(tx, orgId, item.project_id, item.type);
    const category = statuses.find((s) => s.key === item.status_key)?.category ?? "todo";
    const after = await writeItem(tx, orgId, item, {
      responsible_account_id: pair.accountId,
      executing_agent_id: pair.agentId,
    });
    await recordAssignment(tx, orgId, actor, item, after, {
      projectKey: project.key,
      statusCategory: category,
    });
    return after;
  });
}
