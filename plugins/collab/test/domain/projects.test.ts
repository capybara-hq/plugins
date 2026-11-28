import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CollabError } from "../../src/domain/errors.js";
import { createItem } from "../../src/domain/items.js";
import { addMember, removeMember, setFunction } from "../../src/domain/projects.js";
import type { CollabDb } from "../../src/store/db.js";
import { domainDb, ENGINEER, OWNER, outboxOf, QA, teamProject } from "./setup.js";

let db: CollabDb;
let close: () => Promise<void>;
beforeAll(async () => {
  ({ db, close } = await domainDb());
});
afterAll(async () => {
  await close();
});

const code = (p: Promise<unknown>) =>
  p.then(
    () => "ok",
    (e: unknown) => (e instanceof CollabError ? e.code : String(e)),
  );

const memberOf = (projectId: string, accountId: string) =>
  db
    .selectFrom("project_members")
    .selectAll()
    .where("project_id", "=", projectId)
    .where("account_id", "=", accountId)
    .executeTakeFirstOrThrow();

describe("collab projects", () => {
  it("function labels are owner-only; a member sets only their own default agent", async () => {
    const org = "org-fn";
    const project = await teamProject(db, org, "FN");
    expect(
      await code(
        setFunction(db, org, ENGINEER, project.id, ENGINEER.accountId, { functionLabel: "qa" }),
      ),
    ).toBe("forbidden");
    expect(
      await code(
        setFunction(db, org, ENGINEER, project.id, QA.accountId, { defaultAgentId: "mine" }),
      ),
    ).toBe("forbidden");
    const own = await setFunction(db, org, ENGINEER, project.id, ENGINEER.accountId, {
      defaultAgentId: "agent-eng-2",
    });
    expect([own.function_label, own.default_agent_id]).toEqual(["engineering", "agent-eng-2"]);
    const byOwner = await setFunction(db, org, OWNER, project.id, QA.accountId, {
      functionLabel: "testing",
    });
    expect([byOwner.function_label, byOwner.default_agent_id]).toEqual(["testing", "agent-qa"]);
  });

  it("addMember keeps the function and agent it is not given", async () => {
    const org = "org-upsert";
    const project = await teamProject(db, org, "UPS");
    await addMember(db, org, OWNER, project.id, ENGINEER.accountId, { role: "owner" });
    const row = await memberOf(project.id, ENGINEER.accountId);
    expect([row.role, row.function_label, row.default_agent_id]).toEqual([
      "owner",
      "engineering",
      "agent-eng",
    ]);
  });

  it("removing a member hands their open items back to the project owner", async () => {
    const org = "org-remove";
    const project = await teamProject(db, org, "REM");
    const open = await createItem(db, org, OWNER, {
      projectId: project.id,
      type: "task",
      title: "open",
      responsibleAccountId: ENGINEER.accountId,
      executingAgentId: "agent-eng",
    });
    await removeMember(db, org, OWNER, project.id, ENGINEER.accountId);
    const after = await db
      .selectFrom("items")
      .selectAll()
      .where("id", "=", open.id)
      .executeTakeFirstOrThrow();
    expect([after.responsible_account_id, after.executing_agent_id]).toEqual([
      OWNER.accountId,
      null,
    ]);
    expect(after.version).toBe(open.version + 1);
    const rows = await outboxOf(db, org, open.id);
    expect(rows.map((r) => [r.type, r.audience])).toContainEqual([
      "item.unassigned",
      { accountId: ENGINEER.accountId, agentId: "agent-eng" },
    ]);
    expect(await code(removeMember(db, org, OWNER, project.id, OWNER.accountId))).toBe("forbidden");
  });
});
