import { randomUUID } from "node:crypto";
import { sql, type Updateable } from "kysely";
import { outboxFor } from "../events/outbox.js";
import type { CollabDb } from "../store/db.js";
import type {
  Actor,
  Artifact,
  Comment,
  Decision,
  Item,
  ItemsTable,
  LinkKind,
  Project,
  Status,
} from "../store/types.js";
import { canSee, requireRole } from "./access.js";
import {
  type AgentAllowed,
  assignmentDiffers,
  type DefaultAssignee,
  recordAssignment,
  resolveDefaultAssignment,
  validateAssignee,
} from "./assignment.js";
import {
  cancelStaleGates,
  type DecisionHooks,
  gateConfirmers,
  readdressOpen,
  recipientsOf,
  requireHooks,
} from "./decision-state.js";
import { CollabError } from "./errors.js";
import {
  actorJson,
  addActivity,
  checkVersion,
  isAgent,
  loadItem,
  loadProject,
  writeItem,
} from "./internal.js";
import {
  checkTransition,
  defaultAssignmentOf,
  gateOf,
  initialStatus,
  isClosed,
  statusesForType,
} from "./workflow.js";

/** How deep a parent chain may go before it is treated as a cycle. */
const MAX_PARENT_DEPTH = 100;
/** The parent auto-move (Global Constraints): a parent here moves on when every child is closed. */
const PARENT_WORKING_STATUS = "in_progress";
const PARENT_ACCEPTANCE_STATUS = "acceptance";
/** After the auto-move into acceptance, the gated move to this status is requested at once. */
const PARENT_DONE_STATUS = "done";

export interface CreateItemInput {
  projectId: string;
  type: string;
  title: string;
  description?: string;
  parentId?: string;
  responsibleAccountId?: string;
  executingAgentId?: string;
  priority?: number;
  labels?: string[];
}

export interface ItemPatch {
  title?: string;
  description?: string;
  priority?: number;
  labels?: string[];
  parentId?: string | null;
  fields?: Record<string, unknown>;
}

/** Input caps: longer input is refused with `invalid_input`. */
const MAX_TITLE_CHARS = 200;
const MAX_DESCRIPTION_CHARS = 50_000;
const MAX_COMMENT_CHARS = 20_000;
const MAX_LABELS = 20;
const MAX_LABEL_CHARS = 50;
const MAX_FIELDS_BYTES = 16 * 1024;

function checkTitle(title: string): string {
  const trimmed = title.trim();
  if (!trimmed) throw new CollabError("invalid_input", "The title must not be empty.");
  if (trimmed.length > MAX_TITLE_CHARS) {
    throw new CollabError(
      "invalid_input",
      `The title must be at most ${MAX_TITLE_CHARS} characters.`,
    );
  }
  return trimmed;
}

function checkDescription(description: string): string {
  if (description.length > MAX_DESCRIPTION_CHARS) {
    throw new CollabError(
      "invalid_input",
      `The description must be at most ${MAX_DESCRIPTION_CHARS} characters; attach longer documents as an artifact.`,
    );
  }
  return description;
}

function checkLabels(labels: string[]): string[] {
  const clean = labels.map((l) => l.trim()).filter(Boolean);
  if (clean.length > MAX_LABELS || clean.some((l) => l.length > MAX_LABEL_CHARS)) {
    throw new CollabError(
      "invalid_input",
      `Use at most ${MAX_LABELS} labels of at most ${MAX_LABEL_CHARS} characters each.`,
    );
  }
  return clean;
}

function checkFields(fields: Record<string, unknown>): string {
  const json = JSON.stringify(fields);
  if (new TextEncoder().encode(json).length > MAX_FIELDS_BYTES) {
    throw new CollabError("invalid_input", "Custom fields must stay under 16 KB of JSON.");
  }
  return json;
}

/** An artifact URL must be absolute http(s). */
function checkArtifactUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new CollabError("invalid_input", "The artifact URL must be an absolute http(s) URL.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new CollabError("invalid_input", "The artifact URL must be an absolute http(s) URL.");
  }
}

/** The object storage prefix of an item's files (inside the plugin's own namespace). */
export function artifactKeyPrefix(itemId: string): string {
  return `artifacts/${itemId}/`;
}

function checkPriority(priority: number): number {
  if (!Number.isInteger(priority) || priority < 0 || priority > 4) {
    throw new CollabError(
      "invalid_input",
      "Priority is an integer from 0 (none) through 1 (urgent) to 4 (low).",
    );
  }
  return priority;
}

function categoryOf(statuses: Status[], key: string): Status["category"] {
  return statuses.find((s) => s.key === key)?.category ?? "todo";
}

/** The parent must be another item of the same project, and must not be the item or its descendant. */
async function checkParent(
  tx: CollabDb,
  orgId: string,
  projectId: string,
  parentId: string,
  itemId?: string,
): Promise<void> {
  let current: string | null = parentId;
  for (let depth = 0; current; depth++) {
    if (current === itemId || depth > MAX_PARENT_DEPTH) {
      throw new CollabError("invalid_input", "An item cannot be its own ancestor.");
    }
    const row: { project_id: string; parent_id: string | null } | undefined = await tx
      .selectFrom("items")
      .select(["project_id", "parent_id"])
      .where("org_id", "=", orgId)
      .where("id", "=", current)
      .executeTakeFirst();
    if (!row || row.project_id !== projectId) {
      throw new CollabError("invalid_input", "The parent must be an item of the same project.");
    }
    current = row.parent_id;
  }
}

/** Options of the writes that may apply a status's default assignment. */
export interface MoveOptions {
  /** Drops a default agent the member may not use (see {@link AgentAllowed}). */
  agentAllowed?: AgentAllowed;
  /**
   * The jobs owed for decisions the write opens (a gate request), re-addresses (a reassignment
   * changed the confirmer) or cancels (a move made a gate stale). Required whenever that happens:
   * the write refuses without them (`requireHooks`).
   */
  decisions?: DecisionHooks;
  /**
   * A person who is not the gate's confirmer asks the confirmer (a gate decision, as an agent's
   * move does) instead of being refused with `gated` (the board's drop into a locked column).
   */
  requestGate?: boolean;
}

/** Records that a default assignment left out an agent the member can no longer use. */
async function noteDroppedAgent(
  tx: CollabDb,
  orgId: string,
  itemId: string,
  actor: Actor,
  assignee: DefaultAssignee,
): Promise<void> {
  await addActivity(tx, orgId, itemId, actor, "default_agent_dropped", {
    accountId: assignee.accountId,
    agentId: assignee.droppedAgentId,
    reason: "the member can no longer use this agent",
  });
}

/**
 * A default assignment that matches no member or several: the item keeps its assignment and the
 * project owner is asked to pick (an inbox notice owed by this entry, see notices.ts).
 */
async function noteUnresolvedHandoff(
  tx: CollabDb,
  orgId: string,
  itemId: string,
  actor: Actor,
  status: Status,
): Promise<void> {
  const rule = defaultAssignmentOf(status);
  if (!rule || !(rule.functionLabel || rule.accountId)) return;
  await addActivity(tx, orgId, itemId, actor, "handoff_unresolved", {
    status: status.key,
    ...(rule.functionLabel ? { functionLabel: rule.functionLabel } : {}),
    ...(rule.accountId ? { accountId: rule.accountId } : {}),
  });
}

/** Creates an item with the project's next key number, in the first status of its type's workflow. */
export async function createItem(
  db: CollabDb,
  orgId: string,
  actor: Actor,
  input: CreateItemInput,
  opts: MoveOptions = {},
): Promise<Item> {
  return db.transaction().execute(async (tx) => {
    await requireRole(tx, orgId, actor.accountId, input.projectId, "write");
    const project = await loadProject(tx, orgId, input.projectId);
    const title = checkTitle(input.title);
    const description = checkDescription(input.description ?? "");
    const labels = checkLabels(input.labels ?? []);
    const priority = input.priority === undefined ? undefined : checkPriority(input.priority);
    const statuses = await statusesForType(tx, orgId, project.id, input.type);
    const status = initialStatus(statuses);
    if (input.parentId) await checkParent(tx, orgId, project.id, input.parentId);

    let assignee: DefaultAssignee | null = null;
    if (input.responsibleAccountId) {
      await validateAssignee(tx, orgId, project.id, input.responsibleAccountId);
      assignee = { accountId: input.responsibleAccountId, agentId: input.executingAgentId ?? null };
    } else if (input.executingAgentId) {
      throw new CollabError(
        "invalid_assignee",
        "An executing agent needs a responsible person. Pass responsibleAccountId too.",
      );
    } else {
      // Entering the first status applies its default assignment, like any later status.
      assignee = await resolveDefaultAssignment(tx, orgId, project.id, status, opts.agentAllowed);
    }

    // The row lock on the project serializes concurrent creates: each gets its own number.
    const counter = await tx
      .updateTable("projects")
      .set({ next_item_number: sql`next_item_number + 1` })
      .where("org_id", "=", orgId)
      .where("id", "=", project.id)
      .returning("next_item_number")
      .executeTakeFirstOrThrow();
    const item = await tx
      .insertInto("items")
      .values({
        org_id: orgId,
        project_id: project.id,
        number: counter.next_item_number - 1,
        type: input.type,
        title,
        description,
        status_key: status.key,
        requester_account_id: actor.accountId,
        responsible_account_id: assignee?.accountId ?? null,
        executing_agent_id: assignee?.agentId ?? null,
        priority,
        labels,
        parent_id: input.parentId ?? null,
        closed_at: isClosed(status.category) ? new Date() : null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    // The initial assignment, if any: its notice is owed like an `assigned` entry's (notices.ts).
    await addActivity(tx, orgId, item.id, actor, "created", {
      status: status.key,
      ...(item.responsible_account_id
        ? { to: { accountId: item.responsible_account_id, agentId: item.executing_agent_id } }
        : {}),
    });
    if (assignee?.droppedAgentId) await noteDroppedAgent(tx, orgId, item.id, actor, assignee);
    if (!input.responsibleAccountId && !assignee) {
      await noteUnresolvedHandoff(tx, orgId, item.id, actor, status);
    }
    const base = { actor, projectKey: project.key, statusCategory: status.category };
    await outboxFor(tx, orgId, "item.created", item, {
      ...base,
      detail: { description: item.description },
    });
    if (item.responsible_account_id && item.executing_agent_id) {
      await outboxFor(tx, orgId, "item.assigned", item, {
        ...base,
        audience: { accountId: item.responsible_account_id, agentId: item.executing_agent_id },
        detail: {
          responsibleAccountId: item.responsible_account_id,
          executingAgentId: item.executing_agent_id,
        },
      });
    }
    return item;
  });
}

/** Changes the item's own fields (not its status or assignment), at the caller's version. */
export async function updateItem(
  db: CollabDb,
  orgId: string,
  actor: Actor,
  itemId: string,
  version: number,
  patch: ItemPatch,
): Promise<Item> {
  return db.transaction().execute((tx) => updateItemIn(tx, orgId, actor, itemId, version, patch));
}

/** {@link updateItem} inside the caller's transaction. */
export async function updateItemIn(
  tx: CollabDb,
  orgId: string,
  actor: Actor,
  itemId: string,
  version: number,
  patch: ItemPatch,
): Promise<Item> {
  const item = await loadItem(tx, orgId, itemId);
  await requireRole(tx, orgId, actor.accountId, item.project_id, "write");
  checkVersion(item, version);
  const set: Updateable<ItemsTable> = {};
  const changed: string[] = [];
  if (patch.title !== undefined && checkTitle(patch.title) !== item.title) {
    set.title = checkTitle(patch.title);
    changed.push("title");
  }
  if (patch.description !== undefined && patch.description !== item.description) {
    set.description = checkDescription(patch.description);
    changed.push("description");
  }
  if (patch.priority !== undefined && checkPriority(patch.priority) !== item.priority) {
    set.priority = patch.priority;
    changed.push("priority");
  }
  const labels = patch.labels === undefined ? undefined : checkLabels(patch.labels);
  if (labels !== undefined && labels.join("\n") !== item.labels.join("\n")) {
    set.labels = labels;
    changed.push("labels");
  }
  if (patch.parentId !== undefined && patch.parentId !== item.parent_id) {
    if (patch.parentId) await checkParent(tx, orgId, item.project_id, patch.parentId, item.id);
    set.parent_id = patch.parentId;
    changed.push("parent");
  }
  if (patch.fields !== undefined) {
    set.fields = checkFields({ ...item.fields, ...patch.fields });
    changed.push("fields");
  }
  if (changed.length === 0) return item;
  const after = await writeItem(tx, orgId, item, set);
  await addActivity(tx, orgId, item.id, actor, "updated", { changedFields: changed });
  const project = await loadProject(tx, orgId, item.project_id);
  const statuses = await statusesForType(tx, orgId, item.project_id, item.type);
  await outboxFor(tx, orgId, "item.updated", after, {
    actor,
    projectKey: project.key,
    statusCategory: categoryOf(statuses, after.status_key),
    changedFields: changed,
  });
  return after;
}

/**
 * Moves the item into `to` (already checked against the workflow and the gate): the status, the
 * close time, the status's default assignment, the activity and the events; then the parent
 * auto-move: of its parent when the item closed, of itself when it entered the working status.
 */
async function moveItem(
  tx: CollabDb,
  orgId: string,
  actor: Actor,
  project: Project,
  item: Item,
  statuses: Status[],
  to: Status,
  auto: boolean,
  opts: MoveOptions,
): Promise<Item> {
  const fromCategory = categoryOf(statuses, item.status_key);
  const set: Updateable<ItemsTable> = { status_key: to.key };
  if (isClosed(to.category) && !isClosed(fromCategory)) set.closed_at = new Date();
  if (!isClosed(to.category)) set.closed_at = null;
  const handoff = await resolveDefaultAssignment(tx, orgId, project.id, to, opts.agentAllowed);
  if (handoff && assignmentDiffers(item, handoff)) {
    set.responsible_account_id = handoff.accountId;
    set.executing_agent_id = handoff.agentId;
  }
  const after = await writeItem(tx, orgId, item, set);
  if (!handoff) await noteUnresolvedHandoff(tx, orgId, item.id, actor, to);
  await addActivity(tx, orgId, item.id, actor, "status_changed", {
    from: item.status_key,
    to: to.key,
    ...(auto ? { auto: true } : {}),
  });
  if (handoff?.droppedAgentId) await noteDroppedAgent(tx, orgId, item.id, actor, handoff);
  const base = { actor, projectKey: project.key, statusCategory: to.category };
  const fromName = statuses.find((s) => s.key === item.status_key)?.name_en ?? item.status_key;
  await outboxFor(tx, orgId, "item.status_changed", after, {
    ...base,
    changedFields: ["status"],
    detail: { fromStatus: fromName, toStatus: to.name_en },
  });
  if (isClosed(to.category) && !isClosed(fromCategory)) {
    await outboxFor(tx, orgId, "item.closed", after, { ...base, detail: { toStatus: to.name_en } });
  }
  await recordAssignment(tx, orgId, actor, item, after, base);
  await cancelStaleGates(tx, orgId, actor, after, opts.decisions);
  await readdressOpen(tx, orgId, { itemId: after.id }, opts.decisions);
  if (isClosed(to.category) && after.parent_id) {
    await advanceParent(tx, orgId, actor, after.parent_id, opts);
  }
  if (to.key === PARENT_WORKING_STATUS && (await advanceParent(tx, orgId, actor, after.id, opts))) {
    // The auto-move changed this item again: hand the caller its current version.
    return loadItem(tx, orgId, after.id);
  }
  return after;
}

/**
 * The parent auto-move: a parent in "in_progress" whose children are all closed (done or
 * canceled) moves to "acceptance", through the workflow like any move: skipped when the workflow
 * does not allow it, a gate request to the confirmer when "acceptance" is gated. The parent row
 * is locked first, so two children closing at once cannot both miss each other. Returns whether
 * the parent was written (moved, or a gate requested).
 */
async function advanceParent(
  tx: CollabDb,
  orgId: string,
  actor: Actor,
  parentId: string,
  opts: MoveOptions,
): Promise<boolean> {
  const parent = await tx
    .selectFrom("items")
    .selectAll()
    .where("org_id", "=", orgId)
    .where("id", "=", parentId)
    .forUpdate()
    .executeTakeFirst();
  if (!parent || parent.status_key !== PARENT_WORKING_STATUS) return false;
  const statuses = await statusesForType(tx, orgId, parent.project_id, parent.type);
  const acceptance = statuses.find((s) => s.key === PARENT_ACCEPTANCE_STATUS);
  if (!acceptance) return false;
  const from = statuses.find((s) => s.key === parent.status_key);
  if (from?.next_keys && !from.next_keys.includes(acceptance.key)) return false;
  const children = await tx
    .selectFrom("items as i")
    .leftJoin("item_types as t", (j) =>
      j.onRef("t.project_id", "=", "i.project_id").onRef("t.key", "=", "i.type"),
    )
    .leftJoin("statuses as s", (j) =>
      j.onRef("s.workflow_id", "=", "t.workflow_id").onRef("s.key", "=", "i.status_key"),
    )
    .select(["i.id", "s.category"])
    .where("i.org_id", "=", orgId)
    .where("i.parent_id", "=", parentId)
    .execute();
  if (children.length === 0) return false;
  if (!children.every((c) => c.category !== null && isClosed(c.category))) return false;
  const project = await loadProject(tx, orgId, parent.project_id);
  const gate = gateOf(acceptance);
  // A gated auto-move always opens a decision, even when the actor is the confirmer: acceptance
  // stays an explicit act.
  if (gate) {
    const addressing = await gateConfirmers(tx, orgId, project, parent, gate);
    await requestGate(tx, orgId, actor, project, parent, statuses, acceptance, addressing, opts);
    return true;
  }
  const moved = await moveItem(tx, orgId, actor, project, parent, statuses, acceptance, true, opts);
  // Only directed events reach an item's conversation, so nobody would hear of the auto-move:
  // the acceptance itself is requested from its confirmer right away (when it is gated).
  const done = statuses.find((s) => s.key === PARENT_DONE_STATUS);
  const doneGate = done ? gateOf(done) : null;
  const allowed = !acceptance.next_keys || acceptance.next_keys.includes(PARENT_DONE_STATUS);
  if (done && doneGate && allowed && moved.status_key === acceptance.key) {
    const addressing = await gateConfirmers(tx, orgId, project, moved, doneGate);
    await requestGate(tx, orgId, actor, project, moved, statuses, done, addressing, opts);
  }
  return true;
}

/**
 * Moves the item to `toStatus` at the caller's version. Into a gated status: an agent gets a gate
 * decision addressed to the confirmer (the item stays); the confirmer, a person, moves it; any
 * other person gets `gated`, or with `opts.requestGate` a gate decision like an agent.
 */
export async function transition(
  db: CollabDb,
  orgId: string,
  actor: Actor,
  itemId: string,
  version: number,
  toStatus: string,
  opts: MoveOptions = {},
): Promise<{ item: Item } | { gate: Decision }> {
  return db
    .transaction()
    .execute((tx) => transitionIn(tx, orgId, actor, itemId, version, toStatus, opts));
}

/** {@link transition} inside the caller's transaction (a gate decision's approval uses it). */
export async function transitionIn(
  tx: CollabDb,
  orgId: string,
  actor: Actor,
  itemId: string,
  version: number,
  toStatus: string,
  opts: MoveOptions = {},
): Promise<{ item: Item } | { gate: Decision }> {
  const item = await loadItem(tx, orgId, itemId);
  await requireRole(tx, orgId, actor.accountId, item.project_id, "write");
  checkVersion(item, version);
  const project = await loadProject(tx, orgId, item.project_id);
  const statuses = await statusesForType(tx, orgId, item.project_id, item.type);
  const to = checkTransition(statuses, item.status_key, toStatus);
  const gate = gateOf(to);
  if (gate) {
    const addressing = await gateConfirmers(tx, orgId, project, item, gate);
    const { confirmers } = addressing;
    if (isAgent(actor) || (opts.requestGate && !confirmers.includes(actor.accountId))) {
      return {
        gate: await requestGate(tx, orgId, actor, project, item, statuses, to, addressing, opts),
      };
    }
    if (!confirmers.includes(actor.accountId)) {
      throw new CollabError(
        "gated",
        `Moving to "${to.name_en}" needs confirmation by ${confirmers.join(", ")}. Ask them to move it.`,
      );
    }
  }
  return { item: await moveItem(tx, orgId, actor, project, item, statuses, to, false, opts) };
}

/** Creates (or returns the open) gate decision for moving the item into `to`. */
async function requestGate(
  tx: CollabDb,
  orgId: string,
  actor: Actor,
  project: Project,
  item: Item,
  statuses: Status[],
  to: Status,
  addressing: { addressee: string; confirmers: string[] },
  opts: MoveOptions,
): Promise<Decision> {
  const open = await tx
    .selectFrom("decisions")
    .selectAll()
    .where("org_id", "=", orgId)
    .where("item_id", "=", item.id)
    .where("kind", "=", "gate")
    .where("state", "=", "open")
    .where("gate_target", "=", to.key)
    .where("gate_from", "=", item.status_key)
    .executeTakeFirst();
  if (open) return open;
  const after = await writeItem(tx, orgId, item, {});
  const key = `${project.key}-${item.number}`;
  const id = randomUUID();
  await requireHooks(opts.decisions, "a gate request").created(id);
  const decision = await tx
    .insertInto("decisions")
    .values({
      id,
      org_id: orgId,
      item_id: item.id,
      kind: "gate",
      asker: actorJson(actor),
      addressee_account_id: addressing.addressee,
      addressees: recipientsOf({
        addressee: addressing.addressee,
        answerers: addressing.confirmers,
      }),
      question: `Move ${key} "${item.title}" to "${to.name_en}"?`,
      options: JSON.stringify([
        { id: "approve", label: "Approve" },
        { id: "reject", label: "Reject" },
      ]),
      blocking: true,
      gate_target: to.key,
      gate_from: item.status_key,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  await addActivity(tx, orgId, item.id, actor, "gate_requested", {
    to: to.key,
    decisionId: decision.id,
    addressee: addressing.addressee,
  });
  await outboxFor(tx, orgId, "gate.requested", after, {
    actor,
    projectKey: project.key,
    statusCategory: categoryOf(statuses, item.status_key),
    detail: { toStatus: to.name_en },
  });
  return decision;
}

/**
 * A check run inside an addition's transaction after the item row is locked, e.g. that the
 * writing agent still works on the item. It throws to refuse.
 */
export type AdditionGuard = (tx: CollabDb, item: Item) => Promise<void>;

/** Options of comment, link and attachArtifact. */
export interface AdditionOptions {
  guard?: AdditionGuard;
}

/**
 * The item a comment, link or artifact is added to, with the context its event needs. The item
 * row is locked `FOR NO KEY UPDATE` (reads go on; an assignment's UPDATE waits, and vice versa),
 * so the guard and the insert see the assignment that holds while they commit. These additions
 * do not conflict with edits, so they leave the version alone (their events key on their own ids).
 */
async function additionContext(
  tx: CollabDb,
  orgId: string,
  actor: Actor,
  itemId: string,
  guard?: AdditionGuard,
) {
  const item = await tx
    .selectFrom("items")
    .selectAll()
    .where("org_id", "=", orgId)
    .where("id", "=", itemId)
    .forNoKeyUpdate()
    .executeTakeFirst();
  if (!item) throw new CollabError("not_found", "Item not found.");
  await requireRole(tx, orgId, actor.accountId, item.project_id, "write");
  if (guard) await guard(tx, item);
  const project = await loadProject(tx, orgId, item.project_id);
  const statuses = await statusesForType(tx, orgId, item.project_id, item.type);
  return {
    item,
    base: {
      actor,
      projectKey: project.key,
      statusCategory: categoryOf(statuses, item.status_key),
    },
  };
}

/** Adds a comment to the item. */
export async function comment(
  db: CollabDb,
  orgId: string,
  actor: Actor,
  itemId: string,
  body: string,
  opts: AdditionOptions = {},
): Promise<Comment> {
  if (!body.trim()) throw new CollabError("invalid_input", "The comment must not be empty.");
  if (body.length > MAX_COMMENT_CHARS) {
    throw new CollabError(
      "invalid_input",
      `A comment must be at most ${MAX_COMMENT_CHARS} characters.`,
    );
  }
  return db.transaction().execute(async (tx) => {
    const { item, base } = await additionContext(tx, orgId, actor, itemId, opts.guard);
    const row = await tx
      .insertInto("comments")
      .values({ org_id: orgId, item_id: item.id, author: actorJson(actor), body })
      .returningAll()
      .executeTakeFirstOrThrow();
    await addActivity(tx, orgId, item.id, actor, "commented", { commentId: row.id });
    await outboxFor(tx, orgId, "item.commented", item, {
      ...base,
      dedupeKey: `item.commented-${row.id}`,
      detail: { comment: body },
    });
    return row;
  });
}

/** Links two items (`blocks`, `relates`, `duplicates`); linking twice is a no-op. */
export async function link(
  db: CollabDb,
  orgId: string,
  actor: Actor,
  input: { fromId: string; toId: string; kind: LinkKind },
  opts: AdditionOptions = {},
): Promise<void> {
  if (input.fromId === input.toId) {
    throw new CollabError("invalid_input", "An item cannot be linked to itself.");
  }
  await db.transaction().execute(async (tx) => {
    const { item: from, base } = await additionContext(tx, orgId, actor, input.fromId, opts.guard);
    const to = await loadItem(tx, orgId, input.toId);
    if (!(await canSee(tx, orgId, actor.accountId, to.project_id))) {
      throw new CollabError("not_found", "Item not found.");
    }
    const inserted = await tx
      .insertInto("item_links")
      .values({ org_id: orgId, from_id: from.id, to_id: to.id, kind: input.kind })
      .onConflict((oc) => oc.doNothing())
      .returning("from_id")
      .executeTakeFirst();
    if (!inserted) return;
    const activityId = await addActivity(tx, orgId, from.id, actor, "linked", {
      to: to.id,
      kind: input.kind,
    });
    await outboxFor(tx, orgId, "item.updated", from, {
      ...base,
      changedFields: ["links"],
      dedupeKey: `item.updated-link-${activityId}`,
    });
  });
}

/**
 * Attaches a file or a link to the item; a new one under an existing name is its next version.
 * A file is an object storage key under `artifactKeyPrefix(itemId)`; a link an http(s) URL.
 */
export async function attachArtifact(
  db: CollabDb,
  orgId: string,
  actor: Actor,
  itemId: string,
  input: { kind: string; name: string; storageKey?: string; url?: string },
  opts: AdditionOptions = {},
): Promise<Artifact> {
  if (!input.name.trim()) throw new CollabError("invalid_input", "The artifact needs a name.");
  if (Boolean(input.storageKey) === Boolean(input.url)) {
    throw new CollabError("invalid_input", "Attach either a file or a URL, exactly one of them.");
  }
  if (input.url) checkArtifactUrl(input.url);
  if (
    input.storageKey &&
    (!input.storageKey.startsWith(artifactKeyPrefix(itemId)) || input.storageKey.includes(".."))
  ) {
    throw new CollabError("invalid_input", "The file is not one of this item's uploads.");
  }
  return db.transaction().execute(async (tx) => {
    // The item lock (additionContext) also gives concurrent attachments of one name distinct
    // versions; the item's own version stays.
    const { item, base } = await additionContext(tx, orgId, actor, itemId, opts.guard);
    const latest = await tx
      .selectFrom("artifacts")
      .select((eb) => eb.fn.max("version").as("v"))
      .where("org_id", "=", orgId)
      .where("item_id", "=", item.id)
      .where("name", "=", input.name)
      .executeTakeFirst();
    const row = await tx
      .insertInto("artifacts")
      .values({
        org_id: orgId,
        item_id: item.id,
        kind: input.kind,
        name: input.name,
        version: (latest?.v ?? 0) + 1,
        storage_key: input.storageKey ?? null,
        url: input.url ?? null,
        author: actorJson(actor),
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    await addActivity(tx, orgId, item.id, actor, "artifact_attached", {
      artifactId: row.id,
      name: row.name,
      version: row.version,
    });
    await outboxFor(tx, orgId, "item.updated", item, {
      ...base,
      changedFields: ["artifacts"],
      dedupeKey: `item.updated-artifact-${row.id}`,
    });
    return row;
  });
}
