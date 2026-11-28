import type { CollabDb } from "../store/db.js";
import type { Actor, Project, ProjectMember, ProjectRole } from "../store/types.js";
import { requireRole } from "./access.js";
import { CollabError } from "./errors.js";
import { loadProject } from "./internal.js";
import { seedProject } from "./seed.js";

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

/** Adds a person to the project, or changes their role and function (project owners only). */
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
    const values = {
      role: input.role,
      function_label: input.functionLabel?.trim() || null,
      default_agent_id: input.defaultAgentId ?? null,
    };
    return tx
      .insertInto("project_members")
      .values({ org_id: orgId, project_id: projectId, account_id: accountId, ...values })
      .onConflict((oc) => oc.columns(["project_id", "account_id"]).doUpdateSet(values))
      .returningAll()
      .executeTakeFirstOrThrow();
  });
}

/** Removes a person from the project (project owners only; the project owner stays). */
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
  });
}

/**
 * Sets a member's function label (used by default assignment) and the agent a default assignment
 * hands their items to. A project owner may set anyone's; a member may set their own.
 */
export async function setFunction(
  db: CollabDb,
  orgId: string,
  actor: Actor,
  projectId: string,
  accountId: string,
  input: { functionLabel: string | null; defaultAgentId?: string | null },
): Promise<ProjectMember> {
  return db.transaction().execute(async (tx) => {
    await requireRole(
      tx,
      orgId,
      actor.accountId,
      projectId,
      accountId === actor.accountId ? "write" : "owner",
    );
    const row = await tx
      .updateTable("project_members")
      .set({
        function_label: input.functionLabel?.trim() || null,
        ...(input.defaultAgentId !== undefined ? { default_agent_id: input.defaultAgentId } : {}),
      })
      .where("org_id", "=", orgId)
      .where("project_id", "=", projectId)
      .where("account_id", "=", accountId)
      .returningAll()
      .executeTakeFirst();
    if (!row) throw new CollabError("not_found", "That person is not a member of the project.");
    return row;
  });
}
