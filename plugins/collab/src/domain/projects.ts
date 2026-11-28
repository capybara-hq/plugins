import type { CollabDb } from "../store/db.js";
import type { Actor, Project, ProjectMember, ProjectRole } from "../store/types.js";
import { requireRole } from "./access.js";
import { recordAssignment } from "./assignment.js";
import { CollabError } from "./errors.js";
import { loadProject, writeItem } from "./internal.js";
import { seedProject } from "./seed.js";
import { statusesForType } from "./workflow.js";

/** A project key: an upper-case letter, then 1 to 9 upper-case letters or digits (items are `<KEY>-<n>`). */
const PROJECT_KEY = /^[A-Z][A-Z0-9]{1,9}$/;

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && (error as { code?: unknown }).code === "23505"
  );
}

/** Creates a project owned by the actor's person, with the default item types and workflows. */
export async function createProject(
  db: CollabDb,
  orgId: string,
  actor: Actor,
  input: { key: string; name: string; description?: string },
): Promise<Project> {
  if (!PROJECT_KEY.test(input.key)) {
    throw new CollabError(
      "invalid_input",
      `Project key "${input.key}" is invalid: use 2 to 10 upper-case letters or digits, starting with a letter (e.g. CAP).`,
    );
  }
  const name = input.name.trim();
  if (!name) throw new CollabError("invalid_input", "The project name must not be empty.");
  try {
    return await db.transaction().execute(async (tx) => {
      const project = await tx
        .insertInto("projects")
        .values({
          org_id: orgId,
          key: input.key,
          name,
          description: input.description ?? "",
          owner_account_id: actor.accountId,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      await tx
        .insertInto("project_members")
        .values({
          org_id: orgId,
          project_id: project.id,
          account_id: actor.accountId,
          role: "owner",
          function_label: null,
          default_agent_id: null,
        })
        .execute();
      await seedProject(tx, orgId, project.id);
      return project;
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new CollabError(
        "invalid_input",
        `Project key "${input.key}" is already used in this organization. Choose another key.`,
      );
    }
    throw error;
  }
}

/**
 * Adds a person to the project, or changes their role (project owners only). The function label
 * and default agent are set when given and otherwise kept (null on a new member).
 */
export async function addMember(
  db: CollabDb,
  orgId: string,
  actor: Actor,
  projectId: string,
  accountId: string,
  input: { role: ProjectRole; functionLabel?: string | null; defaultAgentId?: string | null },
): Promise<ProjectMember> {
  return db.transaction().execute(async (tx) => {
    await requireRole(tx, orgId, actor.accountId, projectId, "owner");
    const project = await loadProject(tx, orgId, projectId);
    if (accountId === project.owner_account_id && input.role !== "owner") {
      throw new CollabError("forbidden", "The project owner keeps the owner role.");
    }
    const given = {
      ...(input.functionLabel !== undefined
        ? { function_label: input.functionLabel?.trim() || null }
        : {}),
      ...(input.defaultAgentId !== undefined ? { default_agent_id: input.defaultAgentId } : {}),
    };
    return tx
      .insertInto("project_members")
      .values({
        org_id: orgId,
        project_id: projectId,
        account_id: accountId,
        role: input.role,
        function_label: null,
        default_agent_id: null,
        ...given,
      })
      .onConflict((oc) =>
        oc.columns(["project_id", "account_id"]).doUpdateSet({ role: input.role, ...given }),
      )
      .returningAll()
      .executeTakeFirstOrThrow();
  });
}

/**
 * Removes a person from the project (project owners only; the project owner stays). Their open
 * items go back to the project owner without an agent, recorded like any reassignment.
 */
export async function removeMember(
  db: CollabDb,
  orgId: string,
  actor: Actor,
  projectId: string,
  accountId: string,
): Promise<void> {
  await db.transaction().execute(async (tx) => {
    await requireRole(tx, orgId, actor.accountId, projectId, "owner");
    const project = await loadProject(tx, orgId, projectId);
    if (accountId === project.owner_account_id) {
      throw new CollabError("forbidden", "The project owner cannot be removed.");
    }
    await tx
      .deleteFrom("project_members")
      .where("org_id", "=", orgId)
      .where("project_id", "=", projectId)
      .where("account_id", "=", accountId)
      .execute();
    const open = await tx
      .selectFrom("items")
      .selectAll()
      .where("org_id", "=", orgId)
      .where("project_id", "=", projectId)
      .where("responsible_account_id", "=", accountId)
      .where("closed_at", "is", null)
      .forUpdate()
      .execute();
    for (const item of open) {
      const after = await writeItem(tx, orgId, item, {
        responsible_account_id: project.owner_account_id,
        executing_agent_id: null,
      });
      const statuses = await statusesForType(tx, orgId, projectId, item.type);
      await recordAssignment(tx, orgId, actor, item, after, {
        projectKey: project.key,
        statusCategory: statuses.find((s) => s.key === item.status_key)?.category ?? "todo",
      });
    }
  });
}

/**
 * Sets a member's function label (used by default assignment; project owners only) and the agent
 * a default assignment hands their items to (owners for anyone, a member for themselves). A field
 * left out is kept.
 */
export async function setFunction(
  db: CollabDb,
  orgId: string,
  actor: Actor,
  projectId: string,
  accountId: string,
  input: { functionLabel?: string | null; defaultAgentId?: string | null },
): Promise<ProjectMember> {
  return db.transaction().execute(async (tx) => {
    const self = accountId === actor.accountId;
    const need = input.functionLabel !== undefined || !self ? "owner" : "write";
    await requireRole(tx, orgId, actor.accountId, projectId, need);
    const set = {
      ...(input.functionLabel !== undefined
        ? { function_label: input.functionLabel?.trim() || null }
        : {}),
      ...(input.defaultAgentId !== undefined ? { default_agent_id: input.defaultAgentId } : {}),
    };
    if (Object.keys(set).length === 0) {
      throw new CollabError("invalid_input", "Pass functionLabel or defaultAgentId.");
    }
    const row = await tx
      .updateTable("project_members")
      .set(set)
      .where("org_id", "=", orgId)
      .where("project_id", "=", projectId)
      .where("account_id", "=", accountId)
      .returningAll()
      .executeTakeFirst();
    if (!row) throw new CollabError("not_found", "That person is not a member of the project.");
    return row;
  });
}
