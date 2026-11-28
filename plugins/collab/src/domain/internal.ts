import { sql, type Updateable } from "kysely";
import type { CollabDb } from "../store/db.js";
import type { Actor, Item, ItemsTable, Project } from "../store/types.js";
import { CollabError } from "./errors.js";

/** True when an agent acts (in a conversation, for its person); false for a person's own action. */
export function isAgent(
  actor: Actor,
): actor is { accountId: string; agentId: string; conversationId: string; causeHandle?: string } {
  return "agentId" in actor;
}

/**
 * The actor as the item's history stores it (activity, comments, decisions, artifacts): without
 * the cause handle, which belongs to the outbox rows only.
 */
export function actorJson(actor: Actor): string {
  if (!isAgent(actor)) return JSON.stringify({ accountId: actor.accountId });
  return JSON.stringify({
    accountId: actor.accountId,
    agentId: actor.agentId,
    conversationId: actor.conversationId,
  });
}

export async function watcherIds(db: CollabDb, orgId: string, itemId: string): Promise<string[]> {
  const rows = await db
    .selectFrom("item_watchers")
    .select("account_id")
    .where("org_id", "=", orgId)
    .where("item_id", "=", itemId)
    .orderBy("account_id")
    .execute();
  return rows.map((row) => row.account_id);
}

export async function isWatching(
  db: CollabDb,
  orgId: string,
  itemId: string,
  accountId: string,
): Promise<boolean> {
  const row = await db
    .selectFrom("item_watchers")
    .select("account_id")
    .where("org_id", "=", orgId)
    .where("item_id", "=", itemId)
    .where("account_id", "=", accountId)
    .executeTakeFirst();
  return row !== undefined;
}

export function isWatcherActivity(
  kind: string,
): kind is "status_changed" | "commented" | "decision_answered" {
  return kind === "status_changed" || kind === "commented" || kind === "decision_answered";
}

/** The project in the org, or `not_found`. */
export async function loadProject(
  db: CollabDb,
  orgId: string,
  projectId: string,
): Promise<Project> {
  const project = await db
    .selectFrom("projects")
    .selectAll()
    .where("org_id", "=", orgId)
    .where("id", "=", projectId)
    .executeTakeFirst();
  if (!project) throw new CollabError("not_found", "Project not found.");
  return project;
}

/** The item in the org, or `not_found`. */
export async function loadItem(db: CollabDb, orgId: string, itemId: string): Promise<Item> {
  const item = await db
    .selectFrom("items")
    .selectAll()
    .where("org_id", "=", orgId)
    .where("id", "=", itemId)
    .executeTakeFirst();
  if (!item) throw new CollabError("not_found", "Item not found.");
  return item;
}

/** Refuses when the caller's version is not the item's current one. */
export function checkVersion(item: Item, version: number): void {
  if (item.version !== version) {
    throw new CollabError(
      "version_conflict",
      `The item changed since version ${version} (now ${item.version}). Read it again and retry.`,
    );
  }
}

/**
 * Writes `patch` to the item and bumps its version, only when the stored version is still
 * `before.version` (optimistic concurrency: the losing writer gets `version_conflict`).
 */
export async function writeItem(
  tx: CollabDb,
  orgId: string,
  before: Item,
  patch: Updateable<ItemsTable>,
): Promise<Item> {
  // The agent's run state belongs to the executing pair: a new pair starts without one.
  const pairChanged =
    (patch.responsible_account_id !== undefined &&
      patch.responsible_account_id !== before.responsible_account_id) ||
    (patch.executing_agent_id !== undefined &&
      patch.executing_agent_id !== before.executing_agent_id);
  const reset = pairChanged
    ? {
        agent_state: null,
        agent_conversation_id: null,
        agent_state_at: null,
        assigned_version: before.version + 1,
      }
    : {};
  const row = await tx
    .updateTable("items")
    .set({ ...patch, ...reset, version: sql`version + 1`, updated_at: sql`now()` })
    .where("org_id", "=", orgId)
    .where("id", "=", before.id)
    .where("version", "=", before.version)
    .returningAll()
    .executeTakeFirst();
  if (!row) {
    throw new CollabError(
      "version_conflict",
      `The item changed since version ${before.version}. Read it again and retry.`,
    );
  }
  return row;
}

/** Appends an entry to the item's activity; returns its id. */
export async function addActivity(
  tx: CollabDb,
  orgId: string,
  itemId: string,
  actor: Actor,
  kind: string,
  detail: Record<string, unknown> = {},
): Promise<string> {
  const recipients = isWatcherActivity(kind)
    ? (await watcherIds(tx, orgId, itemId)).filter((accountId) => accountId !== actor.accountId)
    : [];
  const row = await tx
    .insertInto("activity")
    .values({
      org_id: orgId,
      item_id: itemId,
      actor: actorJson(actor),
      kind,
      detail: JSON.stringify(detail),
      ...(recipients.length > 0 && { watcher_recipients: recipients }),
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  return row.id;
}
