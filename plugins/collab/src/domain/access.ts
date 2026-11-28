import type { CollabDb } from "../store/db.js";
import type { ProjectRole } from "../store/types.js";
import { CollabError } from "./errors.js";

/** The person's role in the project, or null when they are not a member (or the project is not in the org). */
export async function roleIn(
  db: CollabDb,
  orgId: string,
  accountId: string,
  projectId: string,
): Promise<ProjectRole | null> {
  const row = await db
    .selectFrom("project_members")
    .select("role")
    .where("org_id", "=", orgId)
    .where("project_id", "=", projectId)
    .where("account_id", "=", accountId)
    .executeTakeFirst();
  return row?.role ?? null;
}

/** Any member (owner, member or guest) sees the project and its items. */
export async function canSee(
  db: CollabDb,
  orgId: string,
  accountId: string,
  projectId: string,
): Promise<boolean> {
  return (await roleIn(db, orgId, accountId, projectId)) !== null;
}

/**
 * The role the person needs for an operation. A non-member gets `not_found` (a project the person
 * cannot see does not exist for them); a guest asking to write, or a member asking for an owner
 * operation, gets `forbidden`.
 */
export async function requireRole(
  db: CollabDb,
  orgId: string,
  accountId: string,
  projectId: string,
  need: "read" | "write" | "owner",
): Promise<ProjectRole> {
  const role = await roleIn(db, orgId, accountId, projectId);
  if (role === null) throw new CollabError("not_found", "Project not found.");
  if (need === "write" && role === "guest") {
    throw new CollabError("forbidden", "Guests can read this project but not change it.");
  }
  if (need === "owner" && role !== "owner") {
    throw new CollabError("forbidden", "Only a project owner can do this.");
  }
  return role;
}
