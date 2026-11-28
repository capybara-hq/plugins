import type { ExtensionContext } from "@capybara-hq/plugin-sdk";
import { sql } from "kysely";
import { PROJECTS } from "./constants.js";
import { itemKey } from "./events/outbox.js";
import { collabDb } from "./store/db.js";
import type { Actor } from "./store/types.js";

/** What the notices use of `ctx`. */
export type NotifyCtx = Pick<ExtensionContext, "db" | "log" | "inbox" | "agents">;

/** The inbox action that takes the agent off an item (`projects` component). */
export const STOP_AGENT_ACTION = "inbox.stop-agent";

/**
 * Activity kinds that may owe a notice: an assignment, an unresolved handoff, and a creation
 * that gave the item a responsible person (`detail.to`).
 */
// capybara:allow-module-state read-only constant
const OWING_KINDS = ["assigned", "handoff_unresolved", "created"] as const;

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
export interface StopPayload {
  itemId: string;
  agentId: string;
}

function clip(text: string, max: number): string {
  const chars = [...text];
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join("")}…`;
}

/** The same text in both UI languages, each clipped to `max`. */
function both(zh: string, en: string, max: number): { zh: string; en: string } {
  return { zh: clip(zh, max), en: clip(en, max) };
}

function itemLink(key: string): string {
  return `/p/collab/projects?item=${key}`;
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
    title: both(
      `${item.key} 已指派给你：${item.title}`,
      `${item.key} assigned to you: ${item.title}`,
      TITLE_MAX,
    ),
    body: item.executingAgentId
      ? {
          zh: `${agentName ?? "你的智能体"}正在处理。`,
          en: `${agentName ?? "Your agent"} is working on it.`,
        }
      : "",
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
    ? {
        zh: `项目中没有唯一一位成员具备职能“${detail.functionLabel}”`,
        en: `No single project member has the function "${detail.functionLabel}"`,
      }
    : { zh: "配置的成员已不在项目中", en: "The configured member is no longer in the project" };
  const status = detail.status ?? "?";
  await ctx.inbox.post({
    orgId,
    accountId: row.ownerAccountId,
    kind: "collab.handoff",
    title: both(
      `请选择 ${row.key} 的负责人：${row.title}`,
      `Pick who gets ${row.key}: ${row.title}`,
      TITLE_MAX,
    ),
    body: {
      zh: `${who.zh}，因此 ${row.key} 进入“${status}”时保留了原来的指派。请在事项页面指派。`,
      en: `${who.en}, so ${row.key} kept its assignment when it entered "${status}". Assign it on the item page.`,
    },
    link: itemLink(row.key),
    dedupeKey: `collab.handoff-${row.itemId}-${row.activityId}`,
  });
}

interface Pair {
  accountId: string | null;
  agentId: string | null;
}

/** Which unnotified entries a pass takes: those of a write (`since`), or older ones (`olderThan`). */
type NoticeWindow = { since: Date } | { olderThan: "sweep" };

/** A notice not posted within a day is given up (marked without posting). */
const NOTICE_MAX_AGE = sql<Date>`now() - interval '1 day'`;
/** The drain's sweep leaves an entry this long to its write's own request path. */
const SWEEP_AFTER = sql<Date>`now() - interval '1 minute'`;
const NOTICE_BATCH = 200;

/**
 * Posts the notices owed by unnotified `assigned` / `handoff_unresolved` / `created` entries in `window`,
 * marking each once it is decided (posted, or not owed). Per item only the assignment that is
 * still current is announced, and only when it gave the item to a new person or a new agent
 * (taking the agent off tells nobody). Intent first: the entry is written in the assignment's
 * transaction, so a notice that fails or is cut off by a crash stays owed and the org's drain job
 * (`sweepNotices`) posts it; a notice posted twice is deduped by its key. Returns how many
 * entries stay owed after failures.
 */
async function postOwed(ctx: NotifyCtx, orgId: string, window: NoticeWindow): Promise<number> {
  const db = collabDb(ctx.db);
  let query = db
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
    .where("a.kind", "in", OWING_KINDS)
    .where("a.notified_at", "is", null);
  query =
    "since" in window
      ? query.where("a.created_at", ">=", window.since)
      : query.where("a.created_at", "<", SWEEP_AFTER).where("a.created_at", ">=", NOTICE_MAX_AGE);
  const rows = await query.orderBy("a.created_at").limit(NOTICE_BATCH).execute();
  const announced = new Set<string>();
  let failed = 0;
  for (const row of rows) {
    try {
      await postOne(ctx, orgId, row, announced);
    } catch (err) {
      failed++;
      ctx.log.warn("collab could not post a notice; the drain job retries it", {
        orgId,
        activityId: row.activityId,
        err,
      });
      continue;
    }
    await db
      .updateTable("activity")
      .set({ notified_at: sql`now()` })
      .where("org_id", "=", orgId)
      .where("id", "=", row.activityId)
      .where("notified_at", "is", null)
      .execute();
  }
  return failed;
}

interface OwedRow {
  activityId: string;
  kind: string;
  actor: unknown;
  detail: unknown;
  itemId: string;
  number: number;
  title: string;
  responsible_account_id: string | null;
  executing_agent_id: string | null;
  projectKey: string;
  owner_account_id: string;
}

/** Posts the notice one entry owes, if any (`announced`: items already announced in this pass). */
async function postOne(
  ctx: NotifyCtx,
  orgId: string,
  row: OwedRow,
  announced: Set<string>,
): Promise<void> {
  const key = itemKey(row.projectKey, row.number);
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
    return;
  }
  // A creation with an initial responsible person reads as an assignment from nobody.
  const { from, to } =
    row.kind === "created"
      ? {
          from: { accountId: null, agentId: null },
          to: (row.detail as { to?: Pair }).to ?? { accountId: null, agentId: null },
        }
      : (row.detail as { from: Pair; to: Pair });
  if (announced.has(row.itemId) || !to.accountId) return;
  if (to.accountId !== row.responsible_account_id || to.agentId !== row.executing_agent_id) return;
  const newPerson = from.accountId !== to.accountId;
  const newAgent = to.agentId !== null && from.agentId !== to.agentId;
  if (!newPerson && !newAgent) return;
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
    row.actor as Actor,
  );
}

/** The request path: posts the notices of the entries recorded since `since` (its own write's). */
export async function notifyRecordedSince(
  ctx: NotifyCtx,
  orgId: string,
  since: Date,
): Promise<void> {
  await postOwed(ctx, orgId, { since });
}

/**
 * The drain job's pass: gives up notices owed for more than a day, then posts the ones still owed
 * after a minute (their request path failed or never ran). Returns how many stay owed.
 */
export async function sweepNotices(ctx: NotifyCtx, orgId: string): Promise<number> {
  const db = collabDb(ctx.db);
  await db
    .updateTable("activity")
    .set({ notified_at: sql`now()` })
    .where(
      "id",
      "in",
      db
        .selectFrom("activity")
        .select("id")
        .where("org_id", "=", orgId)
        .where("kind", "in", OWING_KINDS)
        .where("notified_at", "is", null)
        .where("created_at", "<", NOTICE_MAX_AGE)
        .limit(500),
    )
    .execute();
  return postOwed(ctx, orgId, { olderThan: "sweep" });
}
