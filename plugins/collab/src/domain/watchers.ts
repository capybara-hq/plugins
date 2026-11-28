import type { CollabDb } from "../store/db.js";
import type { Actor } from "../store/types.js";
import { requireRole } from "./access.js";
import { CollabError } from "./errors.js";
import { loadItem, watcherIds } from "./internal.js";

// A trigger fact array can carry at most this many entries.
const MAX_WATCHERS = 64;

export async function setItemWatching(
  db: CollabDb,
  orgId: string,
  actor: Actor,
  itemId: string,
  watching: boolean,
): Promise<boolean> {
  return db.transaction().execute(async (tx) => {
    const item = await loadItem(tx, orgId, itemId);
    // Member removal locks the membership before changing its items. Keep the same lock order.
    await tx
      .selectFrom("project_members")
      .select("account_id")
      .where("org_id", "=", orgId)
      .where("project_id", "=", item.project_id)
      .where("account_id", "=", actor.accountId)
      .forShare()
      .executeTakeFirst();
    await requireRole(tx, orgId, actor.accountId, item.project_id, "write");
    const locked = await tx
      .selectFrom("items")
      .select("id")
      .where("org_id", "=", orgId)
      .where("id", "=", itemId)
      .forNoKeyUpdate()
      .executeTakeFirst();
    if (!locked) throw new CollabError("not_found", "Item not found.");

    if (!watching) {
      await tx
        .deleteFrom("item_watchers")
        .where("org_id", "=", orgId)
        .where("item_id", "=", itemId)
        .where("account_id", "=", actor.accountId)
        .execute();
      return false;
    }
    const watchers = await watcherIds(tx, orgId, itemId);
    if (watchers.includes(actor.accountId)) return true;
    if (watchers.length >= MAX_WATCHERS) {
      throw new CollabError("watcher_limit", "This item already has 64 watchers.");
    }
    await tx
      .insertInto("item_watchers")
      .values({
        org_id: orgId,
        project_id: item.project_id,
        item_id: itemId,
        account_id: actor.accountId,
      })
      .execute();
    return true;
  });
}
