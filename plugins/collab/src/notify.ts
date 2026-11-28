import type { ExtensionContext } from "@capybara-hq/plugin-sdk";
import { sql } from "kysely";
import { ITEM_PANEL, ITEM_PROPERTIES, PROJECTS } from "./constants.js";
import { assign } from "./domain/assignment.js";
import { CollabError } from "./domain/errors.js";
import { type EmitterCtx, emitting } from "./events/emitter.js";
import { itemKey } from "./events/outbox.js";
import { type CollabDb, collabDb } from "./store/db.js";
import type { Actor } from "./store/types.js";
import { type ActionDeps, registerAction } from "./ui/actions.js";

/** What the notices use of `ctx`. */
export type NotifyCtx = Pick<ExtensionContext, "db" | "log" | "inbox" | "agents">;

/** The inbox action that takes the agent off an item (`projects` component). */
export const STOP_AGENT_ACTION = "inbox.stop-agent";

/** Inbox titles are capped at 200 characters (`INBOX_LIMITS.titleChars`). */
const TITLE_MAX = 200;

/** An item as the assignment notice describes it. */
export interface NoticeItem {
  id: string;
  /** `<PROJECT>-<n>`. */
  key: string;
  title: string;
  responsibleAccountId: string;
  executingAgentId: string | null;
  /**
   * The assignment this notice is about (its activity entry): the inbox item is deduped per item
   * and assignment, so a retried notice never doubles up.
   */
  assignmentId: string;
}

/** The payload of a {@link STOP_AGENT_ACTION} button: the pair the notice was about. */
interface StopPayload {
  itemId: string;
  agentId: string;
}

function clip(text: string, max: number): string {
  const chars = [...text];
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join("")}…`;
}

function itemLink(key: string): string {
  return `/p/collab/projects?item=${key}`;
}

async function dbNow(db: CollabDb): Promise<Date> {
  const { rows } = await sql<{ t: Date }>`SELECT clock_timestamp() AS t`.execute(db);
  const row = rows[0];
  if (!row) throw new Error("clock_timestamp() returned no row");
  return row.t;
}

/**
 * Tells the responsible person an item was handed to them (and to which agent), with a button
 * that stops the agent. Skipped when they assigned it themselves (in person or through their own
 * agent).
 */
export async function notifyAssigned(
  ctx: NotifyCtx,
  orgId: string,
  item: NoticeItem,
  byActor: Actor,
): Promise<void> {
  if (byActor.accountId === item.responsibleAccountId) return;
  let agentName: string | undefined;
  if (item.executingAgentId) {
    try {
      const agents = await ctx.agents.usableBy({ orgId, accountId: item.responsibleAccountId });
      agentName = agents.find((a) => a.id === item.executingAgentId)?.name;
    } catch (err) {
      ctx.log.warn("collab could not read agent names for an assignment notice", { orgId, err });
    }
  }
  const payload: StopPayload | undefined = item.executingAgentId
    ? { itemId: item.id, agentId: item.executingAgentId }
    : undefined;
  await ctx.inbox.post({
    orgId,
    accountId: item.responsibleAccountId,
    kind: "collab.assigned",
    title: clip(`${item.key} assigned to you: ${item.title}`, TITLE_MAX),
    body: item.executingAgentId ? `${agentName ?? "Your agent"} is working on it.` : "",
    link: itemLink(item.key),
    actions: payload
      ? [
          {
            id: "stop",
            label: { zh: "停止智能体", en: "Stop agent" },
            style: "danger",
            uiAction: { contribution: PROJECTS, actionId: STOP_AGENT_ACTION, payload },
          },
        ]
      : [],
    dedupeKey: `collab.assigned-${item.id}-${item.assignmentId}`,
  });
}

/** Asks the project owner to pick who gets an item whose default assignment matched no one or several. */
async function notifyHandoffUnresolved(
  ctx: NotifyCtx,
  orgId: string,
  row: { activityId: string; itemId: string; key: string; title: string; ownerAccountId: string },
  detail: { status?: string; functionLabel?: string },
): Promise<void> {
  const who = detail.functionLabel
    ? `No single project member has the function "${detail.functionLabel}"`
    : "The configured member is no longer in the project";
  await ctx.inbox.post({
    orgId,
    accountId: row.ownerAccountId,
    kind: "collab.handoff",
    title: clip(`Pick who gets ${row.key}: ${row.title}`, TITLE_MAX),
    body: `${who}, so ${row.key} kept its assignment when it entered "${detail.status ?? "?"}". Assign it on the item page.`,
    link: itemLink(row.key),
    dedupeKey: `collab.handoff-${row.itemId}-${row.activityId}`,
  });
}

interface Pair {
  accountId: string | null;
  agentId: string | null;
}

/**
 * Posts the notices owed for the assignments and unresolved handoffs recorded since `since` (the
 * caller's write; a concurrent write's entries may come along: same notices, deduped by key). Per
 * item only the assignment that is still current is announced, and only when it gave the item to
 * a new person or a new agent (taking the agent off tells nobody).
 */
export async function notifyRecordedSince(
  ctx: NotifyCtx,
  orgId: string,
  since: Date,
): Promise<void> {
  const db = collabDb(ctx.db);
  const rows = await db
    .selectFrom("activity as a")
    .innerJoin("items as i", (j) =>
      j.onRef("i.id", "=", "a.item_id").onRef("i.org_id", "=", "a.org_id"),
    )
    .innerJoin("projects as p", (j) =>
      j.onRef("p.id", "=", "i.project_id").onRef("p.org_id", "=", "i.org_id"),
    )
    .select([
      "a.id as activityId",
      "a.kind",
      "a.actor",
      "a.detail",
      "i.id as itemId",
      "i.number",
      "i.title",
      "i.responsible_account_id",
      "i.executing_agent_id",
      "p.key as projectKey",
      "p.owner_account_id",
    ])
    .where("a.org_id", "=", orgId)
    .where("a.kind", "in", ["assigned", "handoff_unresolved"])
    .where("a.created_at", ">=", since)
    .orderBy("a.created_at")
    .limit(200)
    .execute();
  const announced = new Set<string>();
  for (const row of rows) {
    const key = itemKey(row.projectKey, row.number);
    const actor = row.actor as Actor;
    if (row.kind === "handoff_unresolved") {
      await notifyHandoffUnresolved(
        ctx,
        orgId,
        {
          activityId: row.activityId,
          itemId: row.itemId,
          key,
          title: row.title,
          ownerAccountId: row.owner_account_id,
        },
        row.detail as { status?: string; functionLabel?: string },
      );
      continue;
    }
    const { from, to } = row.detail as { from: Pair; to: Pair };
    if (announced.has(row.itemId) || !to.accountId) continue;
    if (to.accountId !== row.responsible_account_id || to.agentId !== row.executing_agent_id)
      continue;
    const newPerson = from.accountId !== to.accountId;
    const newAgent = to.agentId !== null && from.agentId !== to.agentId;
    if (!newPerson && !newAgent) continue;
    announced.add(row.itemId);
    await notifyAssigned(
      ctx,
      orgId,
      {
        id: row.itemId,
        key,
        title: row.title,
        responsibleAccountId: to.accountId,
        executingAgentId: to.agentId,
        assignmentId: row.activityId,
      },
      actor,
    );
  }
}

/**
 * Runs a domain write the way every write path does: the events it owes go out (`emitting`),
 * then, once it committed, the inbox notices for the assignments it made. A failed notice is
 * logged, never thrown: the write is done.
 */
export async function notifying<T>(
  ctx: NotifyCtx & EmitterCtx,
  orgId: string,
  write: () => Promise<T>,
): Promise<T> {
  const since = await dbNow(collabDb(ctx.db));
  const result = await emitting(ctx, orgId, write);
  try {
    await notifyRecordedSince(ctx, orgId, since);
  } catch (err) {
    ctx.log.warn("collab could not post an assignment notice", { orgId, err });
  }
  return result;
}

/** The contributions that show items; their open queries refetch after a change. */
export async function invalidateItems(
  ctx: Pick<ExtensionContext, "ui" | "log">,
  orgId: string,
): Promise<void> {
  for (const contribution of [PROJECTS, ITEM_PANEL, ITEM_PROPERTIES]) {
    try {
      await ctx.ui.invalidate({ orgId, contribution });
    } catch (err) {
      ctx.log.warn("collab could not invalidate a contribution", { orgId, contribution, err });
    }
  }
}

function stopPayload(payload: unknown): StopPayload {
  const p = payload as Partial<StopPayload> | null;
  if (!p || typeof p.itemId !== "string" || typeof p.agentId !== "string") {
    throw new Error("collab: inbox.stop-agent needs { itemId, agentId }");
  }
  return { itemId: p.itemId, agentId: p.agentId };
}

/** Attempts at the stop when a concurrent write moves the version in between. */
const STOP_ATTEMPTS = 3;

/**
 * The notice's "Stop agent": takes the agent off the item (the person keeps it), as the person
 * who clicked, who must be the responsible person or the project owner. Idempotent: when the
 * item no longer has that agent (stopped already, or reassigned since), nothing changes.
 */
async function stopAgent(
  deps: ActionDeps,
  args: { orgId: string; accountId: string; payload?: unknown },
) {
  const { itemId, agentId } = stopPayload(args.payload);
  const { ctx, db } = deps;
  for (let attempt = 1; ; attempt++) {
    const item = await db
      .selectFrom("items as i")
      .innerJoin("projects as p", "p.id", "i.project_id")
      .select([
        "i.id",
        "i.version",
        "i.responsible_account_id",
        "i.executing_agent_id",
        "p.owner_account_id",
      ])
      .where("i.org_id", "=", args.orgId)
      .where("i.id", "=", itemId)
      .executeTakeFirst();
    if (!item || item.executing_agent_id !== agentId || !item.responsible_account_id) {
      return { toast: { zh: "智能体已不在这个事项上", en: "The agent is no longer on this item" } };
    }
    if (
      args.accountId !== item.responsible_account_id &&
      args.accountId !== item.owner_account_id
    ) {
      return {
        toast: {
          zh: "只有负责人或项目所有者可以停止智能体",
          en: "Only the responsible person or the project owner can stop the agent",
        },
      };
    }
    const responsible = item.responsible_account_id;
    try {
      await notifying(ctx, args.orgId, () =>
        assign(db, args.orgId, { accountId: args.accountId }, itemId, item.version, {
          responsibleAccountId: responsible,
          executingAgentId: null,
        }),
      );
    } catch (err) {
      if (
        err instanceof CollabError &&
        err.code === "version_conflict" &&
        attempt < STOP_ATTEMPTS
      ) {
        continue;
      }
      if (err instanceof CollabError) {
        return {
          toast: {
            zh: `无法停止智能体：${err.message}`,
            en: `Could not stop the agent: ${err.message}`,
          },
        };
      }
      throw err;
    }
    await invalidateItems(ctx, args.orgId);
    return { toast: { zh: "已停止智能体", en: "Agent stopped" } };
  }
}

registerAction(STOP_AGENT_ACTION, stopAgent);
