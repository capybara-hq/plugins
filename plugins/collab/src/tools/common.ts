import {
  type ExtensionContext,
  type InputRequired,
  type ToolCallContext,
  ToolError,
  type ToolHandler,
  type ToolResult,
} from "@capybara-hq/plugin-sdk";
import { canSee } from "../domain/access.js";
import type { AgentAllowed } from "../domain/assignment.js";
import { CollabError } from "../domain/errors.js";
import type { AdditionGuard } from "../domain/items.js";
import { notifying } from "../notify.js";
import type { CollabDb } from "../store/db.js";
import type { Actor, Item, Project } from "../store/types.js";
import { toolError } from "./format.js";

/** What every tool handler needs: the kernel's ctx and the plugin's typed database. */
export interface ToolDeps {
  ctx: ExtensionContext;
  db: CollabDb;
}

/** An item key as models write it: `<PROJECT>-<n>`. */
const ITEM_KEY = /^([A-Z][A-Z0-9]{1,9})-([1-9][0-9]{0,8})$/;

/**
 * The person a tool acts as. `guarded` refuses runs whose trigger account is not the
 * conversation's owner, so the two are one account here; the tool sees only their projects.
 */
export function personOf(call: ToolCallContext): string {
  return call.ownerAccountId ?? call.accountId;
}

/** The refusal of a run started by someone other than the conversation's owner. */
const FOREIGN_RUN =
  "This run was started by another member than the conversation's owner; collab tools act only " +
  "for the conversation's owner. Ask the owner to run it.";

/** The actor a tool write records: the person, and the agent acting for them in this conversation. */
export function actorOf(call: ToolCallContext): Actor {
  return { accountId: personOf(call), agentId: call.agentId, conversationId: call.conversationId };
}

/**
 * Runs a domain write as the call's actor, then emits the events it owes and posts the inbox
 * notices of the assignments it made (`notifying`). The actor carries the
 * kernel's cause handle of this call, so those events keep the call's chain depth and
 * self-trigger check (also when the `collab-emit` queue emits them later).
 */
export async function writing<T>(
  deps: ToolDeps,
  call: ToolCallContext,
  write: (actor: Actor) => Promise<T>,
): Promise<T> {
  const actor: Actor = { ...actorOf(call), causeHandle: await deps.ctx.triggers.causeOf(call) };
  return notifying(deps.ctx, call.orgId, () => write(actor));
}

/** Wraps a handler so domain refusals reach the model as actionable `ToolError`s. */
export function guarded(
  handler: (
    input: Record<string, unknown>,
    call: ToolCallContext,
  ) => Promise<ToolResult | InputRequired>,
): ToolHandler {
  return async (input, call) => {
    // Same rule as the kernel's device access: a tool acts for exactly one account, so a run
    // whose trigger account differs from the conversation's owner gets no collab tool.
    if (call.ownerAccountId && call.ownerAccountId !== call.accountId) {
      throw new ToolError(FOREIGN_RUN);
    }
    try {
      return await handler((input ?? {}) as Record<string, unknown>, call);
    } catch (error) {
      if (error instanceof CollabError) throw toolError(error);
      throw error;
    }
  };
}

const notFound = () => new CollabError("not_found", "Item not found.");

/**
 * The item with `key` in a project the person is a member of. A key in a project they cannot see
 * answers exactly like a key that does not exist (never the title).
 */
export async function itemByKey(
  db: CollabDb,
  orgId: string,
  person: string,
  key: string,
): Promise<{ item: Item; project: Project }> {
  const m = ITEM_KEY.exec(key.trim().toUpperCase());
  if (!m?.[1] || !m[2]) {
    throw new CollabError("invalid_input", `"${key}" is not an item key like CAP-12.`);
  }
  const project = await db
    .selectFrom("projects")
    .selectAll()
    .where("org_id", "=", orgId)
    .where("key", "=", m[1])
    .executeTakeFirst();
  if (!project || !(await canSee(db, orgId, person, project.id))) throw notFound();
  const item = await db
    .selectFrom("items")
    .selectAll()
    .where("org_id", "=", orgId)
    .where("project_id", "=", project.id)
    .where("number", "=", Number(m[2]))
    .executeTakeFirst();
  if (!item) throw notFound();
  return { item, project };
}

/** The project with `key` the person is a member of (else `not_found`). */
export async function projectByKey(
  db: CollabDb,
  orgId: string,
  person: string,
  key: string,
): Promise<Project> {
  const project = await db
    .selectFrom("projects")
    .selectAll()
    .where("org_id", "=", orgId)
    .where("key", "=", key.trim().toUpperCase())
    .executeTakeFirst();
  if (!project || !(await canSee(db, orgId, person, project.id))) {
    throw new CollabError("not_found", `Project "${key}" not found.`);
  }
  return project;
}

/**
 * Refuses a write from the item's work conversation once its pair moved on (spec §6.1: the run
 * finishes its turn, its next write fails). The work conversation is one whose subject is the
 * item (`ctx.conversations.bySubject`); a sub-agent counts through its root conversation. Writes
 * from any other conversation are ordinary member writes. Versioned writes check it before their
 * transaction (a reassignment bumps the version, so a stale check loses on the version);
 * additions run it as their guard, under the item lock.
 */
export async function assertStillAssigned(
  deps: ToolDeps,
  call: ToolCallContext,
  item: Item,
): Promise<void> {
  const person = personOf(call);
  if (item.responsible_account_id === person && item.executing_agent_id === call.agentId) return;
  const conversation = call.rootConversationId || call.conversationId;
  const work = await deps.ctx.conversations.bySubject({
    orgId: call.orgId,
    subject: { kind: "item", id: item.id },
  });
  if (work.some((c) => c.id === conversation)) {
    throw new CollabError(
      "no_longer_assigned",
      "You are no longer assigned to this item: it was reassigned while you were working.",
    );
  }
}

/** {@link assertStillAssigned} as a domain addition guard (runs on the locked, current row). */
export function stillAssignedGuard(deps: ToolDeps, call: ToolCallContext): AdditionGuard {
  return (_tx, item) => assertStillAssigned(deps, call, item);
}

/**
 * The domain's `agentAllowed` for one call: `ctx.agents.usableBy`, read once per account. A
 * failed read refuses the agent (the member keeps the item without one).
 */
export function agentAllowedFor(deps: ToolDeps, orgId: string): AgentAllowed {
  const cache = new Map<string, Promise<Map<string, string>>>();
  return async (accountId, agentId) => {
    let usable = cache.get(accountId);
    if (!usable) {
      usable = usableAgents(deps.ctx, orgId, accountId);
      cache.set(accountId, usable);
    }
    try {
      return (await usable).has(agentId);
    } catch (err) {
      deps.ctx.log.warn("collab could not read the agents a member may use", { orgId, err });
      return false;
    }
  };
}

/**
 * A note for the model when the item's latest write left out a default agent (the
 * `default_agent_dropped` activity of that write's transaction).
 */
export async function droppedAgentNote(
  deps: ToolDeps,
  orgId: string,
  itemId: string,
): Promise<string> {
  // Compared in SQL: a JS Date would drop the microseconds of the transaction's now().
  const dropped = await deps.db
    .selectFrom("activity")
    .select("detail")
    .where("org_id", "=", orgId)
    .where("item_id", "=", itemId)
    .where("kind", "=", "default_agent_dropped")
    .where("created_at", "=", (eb) =>
      eb
        .selectFrom("activity")
        .select((e) => e.fn.max("created_at").as("t"))
        .where("org_id", "=", orgId)
        .where("item_id", "=", itemId),
    )
    .execute();
  return dropped
    .map(
      (d) =>
        ` The default agent ${String(d.detail.agentId)} was left out: the member can no longer use it.`,
    )
    .join("");
}

/** The agents `accountId` may use, by id. */
export async function usableAgents(
  ctx: ExtensionContext,
  orgId: string,
  accountId: string,
): Promise<Map<string, string>> {
  const agents = await ctx.agents.usableBy({ orgId, accountId });
  return new Map(agents.map((a) => [a.id, a.name]));
}

/** Display names of accounts (unknown ones keep their id); never fails the tool. */
export async function namesOf(
  deps: ToolDeps,
  orgId: string,
  ids: (string | null | undefined)[],
): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((id): id is string => Boolean(id)))].slice(0, 200);
  const names = new Map(unique.map((id) => [id, id]));
  if (unique.length === 0) return names;
  try {
    for (const p of await deps.ctx.people.get({ orgId, accountIds: unique })) {
      names.set(p.id, p.name);
    }
  } catch (error) {
    deps.ctx.log.warn("collab could not read people names for a tool result", {
      orgId,
      err: error,
    });
  }
  return names;
}

/**
 * The account a `responsible` argument names: "me", an account id, or the exact display name of
 * a project member (case-insensitive).
 */
export async function resolvePerson(
  deps: ToolDeps,
  orgId: string,
  projectId: string,
  person: string,
  value: string,
): Promise<string> {
  const v = value.trim();
  if (v.toLowerCase() === "me") return person;
  const members = await deps.db
    .selectFrom("project_members")
    .select("account_id")
    .where("org_id", "=", orgId)
    .where("project_id", "=", projectId)
    .execute();
  const ids = members.map((m) => m.account_id);
  if (ids.includes(v)) return v;
  const names = await namesOf(deps, orgId, ids);
  const matches = ids.filter((id) => names.get(id)?.toLowerCase() === v.toLowerCase());
  if (matches.length === 1 && matches[0]) return matches[0];
  throw new CollabError(
    "invalid_assignee",
    matches.length > 1
      ? `Several project members are named "${v}". Pass the account id from project_list instead.`
      : `"${v}" is not a member of this project. Pass "me", an account id or a member name from project_list.`,
  );
}

/** A non-empty string argument, or `invalid_input`. */
export function str(input: Record<string, unknown>, name: string): string {
  const v = input[name];
  if (typeof v !== "string" || v.trim() === "") {
    throw new CollabError("invalid_input", `Missing "${name}".`);
  }
  return v;
}

/** An optional string argument. */
export function optStr(input: Record<string, unknown>, name: string): string | undefined {
  const v = input[name];
  return typeof v === "string" && v.trim() !== "" ? v : undefined;
}

/** A positive integer argument (an item version), or `invalid_input`. */
export function int(input: Record<string, unknown>, name: string): number {
  const v = input[name];
  if (typeof v !== "number" || !Number.isInteger(v)) {
    throw new CollabError("invalid_input", `Missing "${name}" (an integer).`);
  }
  return v;
}
