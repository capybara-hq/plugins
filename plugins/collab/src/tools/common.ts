import type {
  ExtensionContext,
  InputRequired,
  ToolCallContext,
  ToolHandler,
  ToolResult,
} from "@capybara-hq/plugin-sdk";
import { sql } from "kysely";
import { canSee } from "../domain/access.js";
import { CollabError } from "../domain/errors.js";
import { emitting } from "../events/emitter.js";
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
 * The person a tool acts as: the conversation's owner (the run's trigger account can differ, e.g.
 * an automation started for someone else). The tool sees only that person's projects.
 */
export function personOf(call: ToolCallContext): string {
  return call.ownerAccountId ?? call.accountId;
}

/** The actor a tool write records: the person, and the agent acting for them in this conversation. */
export function actorOf(call: ToolCallContext): Actor {
  return { accountId: personOf(call), agentId: call.agentId, conversationId: call.conversationId };
}

/**
 * Runs a domain write as the call's actor, then emits the events it owes. The actor carries the
 * kernel's cause handle of this call, so those events keep the call's chain depth and
 * self-trigger check (also when the `collab-emit` queue emits them later).
 */
export async function writing<T>(
  deps: ToolDeps,
  call: ToolCallContext,
  write: (actor: Actor) => Promise<T>,
): Promise<T> {
  const actor: Actor = { ...actorOf(call), causeHandle: await deps.ctx.triggers.causeOf(call) };
  return emitting(deps.ctx, call.orgId, () => write(actor));
}

/** Wraps a handler so domain refusals reach the model as actionable `ToolError`s. */
export function guarded(
  handler: (
    input: Record<string, unknown>,
    call: ToolCallContext,
  ) => Promise<ToolResult | InputRequired>,
): ToolHandler {
  return async (input, call) => {
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
 * Refuses a write by an agent that executed the item for this person and no longer does (spec
 * §6.1: its run finishes the turn, its next write fails). An agent that never executed the item
 * may still write (a person's helper commenting or filing a link).
 */
export async function assertStillAssigned(
  db: CollabDb,
  orgId: string,
  call: ToolCallContext,
  item: Item,
): Promise<void> {
  const person = personOf(call);
  if (item.responsible_account_id === person && item.executing_agent_id === call.agentId) return;
  const was = await db
    .selectFrom("activity")
    .select("id")
    .where("org_id", "=", orgId)
    .where("item_id", "=", item.id)
    .where("kind", "=", "assigned")
    .where((eb) =>
      eb.or(
        ["from", "to"].map(
          (side) =>
            sql<boolean>`(detail -> ${side} ->> 'agentId') = ${call.agentId} and (detail -> ${side} ->> 'accountId') = ${person}`,
        ),
      ),
    )
    .limit(1)
    .executeTakeFirst();
  if (was) {
    throw new CollabError(
      "no_longer_assigned",
      "You are no longer assigned to this item: it was reassigned while you were working.",
    );
  }
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
