import type { TriggerSource, TriggerSubject } from "@capybara-hq/plugin-sdk";
import type { CollabDb } from "../store/db.js";
import { EVENT_DECLARATIONS } from "./declarations.js";
import { itemKey } from "./outbox.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The item id of a collab subject, or null for another kind or a malformed id. */
function itemIdOf(subject: TriggerSubject): string | null {
  return subject.kind === "item" && UUID_RE.test(subject.id) ? subject.id : null;
}

/**
 * The `trigger-source@1` provider: the declared event types, who may see an item (the members
 * of its project, guests included, as for reading it) and the in-app link to an item.
 */
export function createTriggerSource(db: CollabDb): TriggerSource {
  return {
    events: () => EVENT_DECLARATIONS,
    async visible({ orgId, accountIds, subject }) {
      const itemId = itemIdOf(subject);
      if (!itemId || accountIds.length === 0) return [];
      const rows = await db
        .selectFrom("project_members as m")
        .innerJoin("items as i", "i.project_id", "m.project_id")
        .select("m.account_id")
        .where("i.org_id", "=", orgId)
        .where("m.org_id", "=", orgId)
        .where("i.id", "=", itemId)
        .where("m.account_id", "in", accountIds)
        .execute();
      return rows.map((r) => r.account_id);
    },
    async subjectLink({ orgId, subject }) {
      const itemId = itemIdOf(subject);
      if (!itemId) return null;
      const row = await db
        .selectFrom("items as i")
        .innerJoin("projects as p", "p.id", "i.project_id")
        .select(["p.key", "i.number"])
        .where("i.org_id", "=", orgId)
        .where("i.id", "=", itemId)
        .executeTakeFirst();
      return row ? `/p/collab/projects?item=${itemKey(row.key, row.number)}` : null;
    },
  };
}
