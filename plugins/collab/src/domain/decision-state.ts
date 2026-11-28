import { sql } from "kysely";
import type { CollabDb } from "../store/db.js";
import type { Actor, Decision, Item, Project } from "../store/types.js";
import { addActivity } from "./internal.js";
import { type GateRule, gateOf, statusesForType } from "./workflow.js";

/**
 * The jobs a write owes when it opens, re-addresses or closes decisions (`decisions-queue.ts`
 * builds them from `ctx`). Each runs inside the write's transaction, before the change: intent
 * first, so a crash after the commit still notifies, and a rollback leaves the jobs nothing to do.
 */
export interface DecisionHooks {
  /** A decision is about to be created: notify its addressee, expire it after 30 days. */
  created(decisionId: string): Promise<void>;
  /** The decision moves to another addressee (`gen` = its new address generation). */
  readdressed(decisionId: string, gen: number): Promise<void>;
  /** The decision closed (answered, canceled, expired): resolve its inbox items. */
  closed(decisionId: string): Promise<void>;
}

/**
 * The hooks of a write that needs them. A write that opens, moves or closes a decision without
 * them would leave inbox items wrong, so it refuses (a programming error, never a user's).
 */
export function requireHooks(hooks: DecisionHooks | undefined, what: string): DecisionHooks {
  if (!hooks)
    throw new Error(`collab: ${what} needs decision hooks (decisionHooks in decisions-queue.ts)`);
  return hooks;
}

/** Who may confirm a gate, and who the gate request is addressed to. */
export async function gateConfirmers(
  tx: CollabDb,
  orgId: string,
  project: Project,
  item: Item,
  gate: GateRule,
): Promise<{ addressee: string; confirmers: string[] }> {
  const owner = project.owner_account_id;
  const isActiveMember = async (accountId: string) =>
    (await tx
      .selectFrom("project_members")
      .select("account_id")
      .where("org_id", "=", orgId)
      .where("project_id", "=", project.id)
      .where("account_id", "=", accountId)
      .where("role", "!=", "guest")
      .executeTakeFirst()) !== undefined;
  switch (gate.confirmer) {
    case "owner":
      return { addressee: owner, confirmers: [owner] };
    case "requester": {
      // A requester who left the project (or became a guest) hands the gate to the owner.
      const who = (await isActiveMember(item.requester_account_id))
        ? item.requester_account_id
        : owner;
      return { addressee: who, confirmers: [who] };
    }
    case "responsible": {
      const who = item.responsible_account_id ?? owner;
      return { addressee: who, confirmers: [who] };
    }
    case "member": {
      const who = (await isActiveMember(gate.accountId)) ? gate.accountId : owner;
      return { addressee: who, confirmers: [who] };
    }
    case "function": {
      const members = await tx
        .selectFrom("project_members")
        .select("account_id")
        .where("org_id", "=", orgId)
        .where("project_id", "=", project.id)
        .where("function_label", "=", gate.functionLabel)
        .where("role", "!=", "guest")
        .execute();
      const ids = members.map((m) => m.account_id);
      if (ids.length === 0) return { addressee: owner, confirmers: [owner] };
      // Anyone with the label confirms; several of them: the request goes to the owner to route.
      return { addressee: ids.length === 1 ? (ids[0] ?? owner) : owner, confirmers: ids };
    }
  }
}

async function isActiveMember(
  tx: CollabDb,
  orgId: string,
  projectId: string,
  accountId: string,
): Promise<boolean> {
  const row = await tx
    .selectFrom("project_members")
    .select("account_id")
    .where("org_id", "=", orgId)
    .where("project_id", "=", projectId)
    .where("account_id", "=", accountId)
    .where("role", "!=", "guest")
    .executeTakeFirst();
  return row !== undefined;
}

/**
 * Who a decision is addressed to now and who may answer it: a question's addressee while an
 * active (non-guest) member, else the project owner; a gate's confirmers as its rule names them
 * today (the owner when the target lost its gate).
 */
export async function currentAddressee(
  tx: CollabDb,
  orgId: string,
  project: Project,
  item: Item,
  decision: Decision,
): Promise<{ addressee: string; answerers: string[] }> {
  if (decision.kind === "question") {
    const who = (await isActiveMember(tx, orgId, project.id, decision.addressee_account_id))
      ? decision.addressee_account_id
      : project.owner_account_id;
    return { addressee: who, answerers: [who] };
  }
  const statuses = await statusesForType(tx, orgId, item.project_id, item.type);
  const target = statuses.find((s) => s.key === decision.gate_target);
  const gate = target ? gateOf(target) : null;
  if (!gate) return { addressee: project.owner_account_id, answerers: [project.owner_account_id] };
  const { addressee, confirmers } = await gateConfirmers(tx, orgId, project, item, gate);
  return { addressee, answerers: confirmers };
}

/**
 * Closes an open decision without an answer (`canceled`: a gate the item moved past; `expired`:
 * open for 30 days). Returns false when it was no longer open.
 */
export async function closeDecision(
  tx: CollabDb,
  orgId: string,
  actor: Actor,
  decision: Decision,
  state: "canceled" | "expired",
  reason: string,
  hooks: DecisionHooks | undefined,
): Promise<boolean> {
  const jobs = requireHooks(hooks, "closing a decision");
  await jobs.closed(decision.id);
  const row = await tx
    .updateTable("decisions")
    .set({ state })
    .where("org_id", "=", orgId)
    .where("id", "=", decision.id)
    .where("state", "=", "open")
    .returning("id")
    .executeTakeFirst();
  if (!row) return false;
  await addActivity(tx, orgId, decision.item_id, actor, `decision_${state}`, {
    decisionId: decision.id,
    reason,
  });
  return true;
}

/**
 * Cancels the item's open gate decisions a move made stale: requested from another status than
 * the one the item now has, or for the status it just entered (a direct move by the confirmer).
 */
export async function cancelStaleGates(
  tx: CollabDb,
  orgId: string,
  actor: Actor,
  item: Item,
  hooks: DecisionHooks | undefined,
): Promise<void> {
  const stale = await tx
    .selectFrom("decisions")
    .selectAll()
    .where("org_id", "=", orgId)
    .where("item_id", "=", item.id)
    .where("kind", "=", "gate")
    .where("state", "=", "open")
    .where((eb) =>
      eb.or([
        eb("gate_from", "is", null),
        eb("gate_from", "!=", item.status_key),
        eb("gate_target", "=", item.status_key),
      ]),
    )
    .forUpdate()
    .execute();
  for (const decision of stale) {
    await closeDecision(tx, orgId, actor, decision, "canceled", "superseded", hooks);
  }
}

/**
 * Moves open decisions whose addressee is no longer right (a question's addressee left or became
 * a guest; a gate's confirmer changed with a reassignment, a role or a function label) to the
 * right person: a new address generation, the old inbox items kept for resolving, the notice and
 * reminder owed again. `scope` is one item or a whole project.
 */
export async function readdressOpen(
  tx: CollabDb,
  orgId: string,
  scope: { itemId: string } | { projectId: string },
  hooks: DecisionHooks | undefined,
): Promise<void> {
  const open = await tx
    .selectFrom("decisions as d")
    .innerJoin("items as i", "i.id", "d.item_id")
    .selectAll("d")
    .where("d.org_id", "=", orgId)
    .where("i.org_id", "=", orgId)
    .where("d.state", "=", "open")
    .where(
      "itemId" in scope ? "i.id" : "i.project_id",
      "=",
      "itemId" in scope ? scope.itemId : scope.projectId,
    )
    .forUpdate()
    .execute();
  const projects = new Map<string, Project>();
  for (const decision of open) {
    const item = await tx
      .selectFrom("items")
      .selectAll()
      .where("org_id", "=", orgId)
      .where("id", "=", decision.item_id)
      .executeTakeFirstOrThrow();
    let project = projects.get(item.project_id);
    if (!project) {
      project = await tx
        .selectFrom("projects")
        .selectAll()
        .where("org_id", "=", orgId)
        .where("id", "=", item.project_id)
        .executeTakeFirstOrThrow();
      projects.set(project.id, project);
    }
    const { addressee } = await currentAddressee(tx, orgId, project, item, decision);
    if (addressee === decision.addressee_account_id) continue;
    const gen = decision.address_gen + 1;
    await requireHooks(hooks, "re-addressing a decision").readdressed(decision.id, gen);
    await tx
      .updateTable("decisions")
      .set({
        addressee_account_id: addressee,
        address_gen: gen,
        stale_inbox_item_ids: sql`stale_inbox_item_ids || inbox_item_ids`,
        inbox_item_ids: sql`'{}'::text[]`,
        notified_at: null,
        reminded_at: null,
      })
      .where("org_id", "=", orgId)
      .where("id", "=", decision.id)
      .execute();
    await addActivity(
      tx,
      orgId,
      item.id,
      { accountId: project.owner_account_id },
      "decision_readdressed",
      {
        decisionId: decision.id,
        from: decision.addressee_account_id,
        to: addressee,
      },
    );
  }
}
