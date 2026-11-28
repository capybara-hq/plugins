import { actorJson, isAgent, watcherIds } from "../domain/internal.js";
import type { CollabDb } from "../store/db.js";
import type { Actor, Item, StatusCategory } from "../store/types.js";
import { EVENT_DECLARATIONS } from "./declarations.js";
import { clipBytes, type SummaryDetail, storedDetail } from "./summary.js";

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
  /** Directed types (declared `directed`, and only those): the pair the event is addressed to. */
  audience?: { accountId: string; agentId: string };
  detail?: SummaryDetail;
  /**
   * The dedupe key when the event is not an item version (comments, links, artifacts do not bump
   * the version and key on their own ids). Default `<type>-<item id>-<item version>`.
   */
  dedupeKey?: string;
  /** `decision.answered`: the decision, whose id keys the event instead of the item version. */
  decisionId?: string;
}

function dedupeKeyFor(type: string, item: Item, extra: OutboxExtra): string {
  if (extra.dedupeKey) return extra.dedupeKey;
  if (type === "decision.answered") {
    if (!extra.decisionId) throw new Error("decision.answered needs the decision id");
    return `${type}-${item.id}-${extra.decisionId}`;
  }
  return `${type}-${item.id}-${item.version}`;
}

function clipList(values: string[]): string[] {
  return values.slice(0, FACT_LIST_ITEMS).map((v) => clipBytes(v, FACT_STRING_BYTES));
}

/**
 * Writes the event owed for a change into `event_outbox`, in the transaction of the change. The
 * dedupe key (unique per org) is `<type>-<item id>-<item version>` unless `extra.dedupeKey` names
 * one, so a retried emit never makes a second event. The row keeps the actor and, for a tool
 * call, its cause handle: the emitter (`emitter.ts`) turns them into the kernel's cause.
 */
export async function outboxFor(
  tx: CollabDb,
  orgId: string,
  type: string,
  item: Item,
  extra: OutboxExtra,
): Promise<void> {
  const declared = EVENT_DECLARATIONS.find((d) => d.type === type);
  if (!declared) throw new Error(`Event type ${type} is not declared.`);
  // A directed event wakes exactly the pair it names; a broadcast one names nobody.
  if (declared.directed !== (extra.audience !== undefined)) {
    throw new Error(
      declared.directed
        ? `Event type ${type} is directed and needs an audience.`
        : `Event type ${type} is broadcast and takes no audience.`,
    );
  }
  const key = itemKey(extra.projectKey, item.number);
  const facts: Record<string, unknown> = {
    projectKey: clipBytes(extra.projectKey, FACT_STRING_BYTES),
    itemType: clipBytes(item.type, FACT_STRING_BYTES),
    status: clipBytes(item.status_key, FACT_STRING_BYTES),
    statusCategory: extra.statusCategory,
    priority: item.priority,
    labels: clipList(item.labels),
    changedFields: clipList(extra.changedFields ?? []),
    watchers: await watcherIds(tx, orgId, item.id),
  };
  if (item.responsible_account_id) facts.responsibleAccountId = item.responsible_account_id;
  if (item.executing_agent_id) facts.executingAgentId = item.executing_agent_id;
  // The kernel accepts only an absolute http(s) subject url, so none is stored here: the in-app
  // link comes from TriggerSource.subjectLink (source.ts).
  const subject = {
    kind: "item",
    id: item.id,
    title: clipBytes(`${key} ${item.title}`, TITLE_BYTES),
  };
  await tx
    .insertInto("event_outbox")
    .values({
      org_id: orgId,
      type,
      subject: JSON.stringify(subject),
      facts: JSON.stringify(facts),
      detail: JSON.stringify(
        storedDetail(key, item.title, {
          ...(extra.changedFields ? { changedFields: extra.changedFields } : {}),
          ...extra.detail,
        }),
      ),
      dedupe_key: dedupeKeyFor(type, item, extra),
      audience: extra.audience ? JSON.stringify(extra.audience) : null,
      actor: actorJson(extra.actor),
      cause_handle: isAgent(extra.actor) ? (extra.actor.causeHandle ?? null) : null,
    })
    .execute();
}
