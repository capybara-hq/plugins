import type { ExtensionContext, RunLifecyclePayload } from "@capybara-hq/plugin-sdk";
import { sql } from "kysely";
import { recordAssignment } from "./domain/assignment.js";
import { addActivity, loadProject, writeItem } from "./domain/internal.js";
import { statusesForType } from "./domain/workflow.js";
import { type EmitterCtx, emitting } from "./events/emitter.js";
import { invalidateItems } from "./notify.js";
import { type CollabDb, collabDb } from "./store/db.js";
import type { AgentState, Item } from "./store/types.js";

/** What the lifecycle handler uses of `ctx`. */
export type LifecycleCtx = EmitterCtx & Pick<ExtensionContext, "conversations" | "ui">;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Registers the `run.lifecycle` observer (in `setup`). */
export function registerLifecycle(ctx: LifecycleCtx & Pick<ExtensionContext, "hooks">): void {
  ctx.hooks.on("run.lifecycle", (payload) => onRunLifecycle(ctx, payload), { mode: "observe" });
}

/** The item a subject names, locked for this transaction; null for another kind or org. */
async function lockItem(tx: CollabDb, orgId: string, subject: RunLifecyclePayload["subject"]) {
  if (subject.kind !== "item" || !UUID_RE.test(subject.id)) return null;
  return (
    (await tx
      .selectFrom("items")
      .selectAll()
      .where("org_id", "=", orgId)
      .where("id", "=", subject.id)
      .forUpdate()
      .executeTakeFirst()) ?? null
  );
}

/**
 * Keeps `items.agent_state` in step with the executing agent's runs. Deliveries come at least once
 * and out of order across replicas, so a run phase is only a hint: the state is read from the
 * kernel (`ctx.conversations.bySubject`, the conversation's latest run) while the item row is
 * locked, so whichever delivery writes last writes the newest state, and a stale `started` never
 * turns an idle item back to working. Events of a pair that no longer executes the item, or of
 * another conversation, are ignored. `offer_declined` marks the item declined (with an activity
 * entry); when the kernel gave up delivering the offer (`undelivered`) the agent is taken off the
 * item as well (the person keeps it).
 */
export async function onRunLifecycle(ctx: LifecycleCtx, p: RunLifecyclePayload): Promise<void> {
  const changed =
    p.phase === "offer_declined" ? await offerDeclined(ctx, p) : await runPhase(ctx, p);
  if (changed) await invalidateItems(ctx, p.orgId);
}

function stateOf(conversationState: "idle" | "running" | "waiting"): AgentState {
  if (conversationState === "running") return "working";
  if (conversationState === "waiting") return "waiting";
  return "idle";
}

async function runPhase(ctx: LifecycleCtx, p: RunLifecyclePayload): Promise<boolean> {
  if (!p.conversationId) return false;
  const db = collabDb(ctx.db);
  return db.transaction().execute(async (tx) => {
    const item = await lockItem(tx, p.orgId, p.subject);
    if (!item?.responsible_account_id || item.executing_agent_id !== p.agentId) return false;
    const conversations = await ctx.conversations.bySubject({
      orgId: p.orgId,
      subject: { kind: "item", id: item.id },
    });
    const conversation = conversations.find((c) => c.id === p.conversationId);
    if (
      !conversation ||
      conversation.agentId !== item.executing_agent_id ||
      conversation.ownerAccountId !== item.responsible_account_id
    ) {
      return false;
    }
    const state = stateOf(conversation.state);
    if (item.agent_state === state && item.agent_conversation_id === conversation.id) return false;
    await setAgentState(tx, item, state, conversation.id);
    return true;
  });
}

/** Writes the run state; not an edit of the item, so the version stays. */
async function setAgentState(
  tx: CollabDb,
  item: Item,
  state: AgentState,
  conversationId: string | null,
): Promise<void> {
  await tx
    .updateTable("items")
    .set({ agent_state: state, agent_conversation_id: conversationId, agent_state_at: sql`now()` })
    .where("org_id", "=", item.org_id)
    .where("id", "=", item.id)
    .execute();
}

async function offerDeclined(ctx: LifecycleCtx, p: RunLifecyclePayload): Promise<boolean> {
  const db = collabDb(ctx.db);
  const reason = p.reason ?? "declined";
  return emitting(ctx, p.orgId, () =>
    db.transaction().execute(async (tx) => {
      const item = await lockItem(tx, p.orgId, p.subject);
      if (
        !item ||
        item.responsible_account_id !== p.accountId ||
        item.executing_agent_id !== p.agentId
      ) {
        return false;
      }
      // The person's rule speaks for them: the decline is recorded as theirs.
      const actor = { accountId: p.accountId };
      if (reason === "undelivered") {
        await addActivity(tx, p.orgId, item.id, actor, "agent_declined", {
          accountId: p.accountId,
          agentId: p.agentId,
          reason,
        });
        // The agent cannot run for this person: take it off, the person keeps the item.
        const after = await writeItem(tx, p.orgId, item, { executing_agent_id: null });
        const project = await loadProject(tx, p.orgId, item.project_id);
        const statuses = await statusesForType(tx, p.orgId, item.project_id, item.type);
        await recordAssignment(tx, p.orgId, actor, item, after, {
          projectKey: project.key,
          statusCategory: statuses.find((s) => s.key === item.status_key)?.category ?? "todo",
        });
        return true;
      }
      if (item.agent_state === "declined") return false;
      await addActivity(tx, p.orgId, item.id, actor, "agent_declined", {
        accountId: p.accountId,
        agentId: p.agentId,
        reason,
      });
      await setAgentState(tx, item, "declined", item.agent_conversation_id);
      return true;
    }),
  );
}
