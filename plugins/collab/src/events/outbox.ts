import type { CollabDb } from "../store/db.js";
import type { Actor, Item, StatusCategory } from "../store/types.js";
import { clipBytes, type SummaryDetail, summarize } from "./summary.js";

/** Kernel limits on a fact string and a subject title, in UTF-8 bytes. */
const FACT_STRING_BYTES = 256;
const FACT_LIST_ITEMS = 64;
const TITLE_BYTES = 1024;

/** The item's key as people and models see it: `<PROJECT>-<n>`. */
export function itemKey(projectKey: string, number: number): string {
  return `${projectKey}-${number}`;
}

/** What an outbox row needs beyond the item row. */
export interface OutboxExtra {
  actor: Actor;
  projectKey: string;
  statusCategory: StatusCategory;
  changedFields?: string[];
  mentions?: string[];
  /** Directed types (`item.assigned`, `item.unassigned`): the pair the event is addressed to. */
  audience?: { accountId: string; agentId: string };
  detail?: SummaryDetail;
}

function clipList(values: string[]): string[] {
  return values.slice(0, FACT_LIST_ITEMS).map((v) => clipBytes(v, FACT_STRING_BYTES));
}

/**
 * Writes the event owed for a change into `event_outbox`, in the transaction of the change. The
 * dedupe key is `<type>-<item id>-<item version>` (unique per org), so a retried emit never makes
 * a second event; `cause` keeps the actor until the emitter turns it into the kernel's cause.
 */
export async function outboxFor(
  tx: CollabDb,
  orgId: string,
  type: string,
  item: Item,
  extra: OutboxExtra,
): Promise<void> {
  const key = itemKey(extra.projectKey, item.number);
  const facts: Record<string, unknown> = {
    projectKey: clipBytes(extra.projectKey, FACT_STRING_BYTES),
    itemType: clipBytes(item.type, FACT_STRING_BYTES),
    status: clipBytes(item.status_key, FACT_STRING_BYTES),
    statusCategory: extra.statusCategory,
    priority: item.priority,
    labels: clipList(item.labels),
    mentions: clipList(extra.mentions ?? []),
    changedFields: clipList(extra.changedFields ?? []),
  };
  if (item.responsible_account_id) facts.responsibleAccountId = item.responsible_account_id;
  if (item.executing_agent_id) facts.executingAgentId = item.executing_agent_id;
  const subject = {
    kind: "item",
    id: item.id,
    title: clipBytes(`${key} ${item.title}`, TITLE_BYTES),
    url: `/p/collab/projects?item=${encodeURIComponent(key)}`,
  };
  await tx
    .insertInto("event_outbox")
    .values({
      org_id: orgId,
      type,
      subject: JSON.stringify(subject),
      facts: JSON.stringify(facts),
      summary: summarize(type, key, item.title, {
        ...(extra.changedFields ? { changedFields: extra.changedFields } : {}),
        ...extra.detail,
      }),
      dedupe_key: `${type}-${item.id}-${item.version}`,
      audience: extra.audience ? JSON.stringify(extra.audience) : null,
      cause: JSON.stringify(extra.actor),
    })
    .execute();
}
