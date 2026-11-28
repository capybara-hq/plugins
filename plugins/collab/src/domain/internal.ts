import { sql, type Updateable } from "kysely";
import type { CollabDb } from "../store/db.js";
import type { Actor, Item, ItemsTable, Project } from "../store/types.js";
import { CollabError } from "./errors.js";

/** True when an agent acts (in a conversation, for its person); false for a person's own action. */
export function isAgent(
  actor: Actor,
): actor is { accountId: string; agentId: string; conversationId: string } {
  return "agentId" in actor;
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

/**
 * Bumps the item's version without a version check (comments, links, artifacts: additions that
 * do not conflict). The update also locks the row for the rest of the transaction.
 */
export async function bumpItem(tx: CollabDb, orgId: string, itemId: string): Promise<Item> {
  const row = await tx
    .updateTable("items")
    .set({ version: sql`version + 1`, updated_at: sql`now()` })
    .where("org_id", "=", orgId)
    .where("id", "=", itemId)
    .returningAll()
    .executeTakeFirst();
  if (!row) throw new CollabError("not_found", "Item not found.");
  return row;
}

/** Appends an entry to the item's activity. */
export async function addActivity(
  tx: CollabDb,
  orgId: string,
  itemId: string,
  actor: Actor,
  kind: string,
  detail: Record<string, unknown> = {},
): Promise<void> {
  await tx
    .insertInto("activity")
    .values({
      org_id: orgId,
      item_id: itemId,
      actor: JSON.stringify(actor),
      kind,
      detail: JSON.stringify(detail),
    })
    .execute();
}
