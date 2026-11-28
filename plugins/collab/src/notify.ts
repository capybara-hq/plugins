import type { ExtensionContext } from "@capybara-hq/plugin-sdk";
import { sql } from "kysely";
import { AGENT_ITEMS, ITEM_PANEL, ITEM_PROPERTIES, PROJECTS } from "./constants.js";
import { decisionHooks } from "./decisions-queue.js";
import { assign } from "./domain/assignment.js";
import { ARCHIVED_TOAST, CollabError } from "./domain/errors.js";
import { type EmitterCtx, emitting } from "./events/emitter.js";
import {
  type NotifyCtx,
  notifyRecordedSince,
  STOP_AGENT_ACTION,
  type StopPayload,
} from "./notices.js";
import { type CollabDb, collabDb } from "./store/db.js";
import { type ActionDeps, payloadFields, registerAction } from "./ui/actions.js";

export {
  type NoticeItem,
  type NotifyCtx,
  notifyAssigned,
  notifyRecordedSince,
  STOP_AGENT_ACTION,
  sweepNotices,
} from "./notices.js";

async function dbNow(db: CollabDb): Promise<Date> {
  const { rows } = await sql<{ t: Date }>`SELECT clock_timestamp() AS t`.execute(db);
  const row = rows[0];
  if (!row) throw new Error("clock_timestamp() returned no row");
  return row.t;
}

/**
 * Runs a domain write the way every write path does: the events it owes go out (`emitting`),
 * then, once it committed, the inbox notices for the changes it made. A failed notice is
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
    ctx.log.warn("collab could not post an item notice", { orgId, err });
  }
  return result;
}

/** The contributions that show items; their open queries refetch after a change. */
export async function invalidateItems(
  ctx: Pick<ExtensionContext, "ui" | "log">,
  orgId: string,
): Promise<void> {
  for (const contribution of [PROJECTS, ITEM_PANEL, ITEM_PROPERTIES, AGENT_ITEMS]) {
    try {
      await ctx.ui.invalidate({ orgId, contribution });
    } catch (err) {
      ctx.log.warn("collab could not invalidate a contribution", { orgId, contribution, err });
    }
  }
}

function stopPayload(payload: unknown): StopPayload {
  return payloadFields(payload, { itemId: "uuid", agentId: "id" });
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
    // Like every UI write: decision jobs queued in the write (a reassignment can re-address a
    // gate), events and notices after the commit, then the follow-ups.
    const follow = decisionHooks(ctx, args.orgId);
    try {
      await notifying(ctx, args.orgId, () =>
        assign(
          db,
          args.orgId,
          { accountId: args.accountId },
          itemId,
          item.version,
          { responsibleAccountId: responsible, executingAgentId: null },
          follow.hooks,
        ),
      );
      await follow.flush();
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
          toast:
            err.code === "archived"
              ? ARCHIVED_TOAST
              : {
                  zh: "无法停止智能体，请在事项页面查看。",
                  en: "Could not stop the agent. Open the item's page.",
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
