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
  const row = await tx
    .updateTable("items")
    .set({ ...patch, version: sql`version + 1`, updated_at: sql`now()` })
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
  const row = await tx
    .insertInto("activity")
    .values({
      org_id: orgId,
      item_id: itemId,
      actor: actorJson(actor),
      kind,
      detail: JSON.stringify(detail),
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  return row.id;
}
