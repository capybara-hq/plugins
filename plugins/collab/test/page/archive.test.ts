import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createItem, transition } from "../../src/domain/items.js";
import "../../src/page/actions.js";
import type { CollabDb } from "../../src/store/db.js";
import { domainDb, ENGINEER, NO_DECISION_JOBS, OWNER, QA, teamProject } from "../domain/setup.js";
import { errorOf, toolHarness } from "../tools/harness.js";
import { pageCtx } from "./fake.js";

let db: CollabDb;
let close: () => Promise<void>;
beforeAll(async () => {
  ({ db, close } = await domainDb());
});
afterAll(async () => {
  await close();
});

const AGENTS = {
  [OWNER.accountId]: [{ id: "agent-pm", name: "PM agent" }],
  [ENGINEER.accountId]: [{ id: "agent-eng", name: "Engineer agent" }],
  [QA.accountId]: [{ id: "agent-qa", name: "QA agent" }],
};

async function inReview(org: string, key: string) {
  const project = await teamProject(db, org, key);
  let item = await createItem(db, org, OWNER, {
    projectId: project.id,
    type: "requirement",
    title: "Export",
  });
  for (const to of ["drafting", "review"]) {
    const out = await transition(db, org, ENGINEER, item.id, item.version, to, {
      decisions: NO_DECISION_JOBS,
    });
    if (!("item" in out)) throw new Error("unexpected gate");
    item = out.item;
  }
  return { project, item };
}

const itemRow = (id: string) =>
  db.selectFrom("items").selectAll().where("id", "=", id).executeTakeFirstOrThrow();
const decisionRow = (itemId: string) =>
  db.selectFrom("decisions").selectAll().where("item_id", "=", itemId).executeTakeFirstOrThrow();

describe("workflow changes and archived projects", () => {
  it("approving a gate whose move the workflow no longer allows cancels it", async () => {
    const org = "org-arch-disallowed";
    const { item } = await inReview(org, "ADA");
    const fake = pageCtx(db, AGENTS);
    await fake.act(org, ENGINEER.accountId, "item.move", {
      itemId: item.id,
      version: item.version,
      to: "ready",
    });
    const gate = await decisionRow(item.id);
    // The workflow changed: review no longer leads to ready.
    await db
      .updateTable("statuses")
      .set({ next_keys: ["drafting", "canceled"] })
      .where("org_id", "=", org)
      .where("key", "=", "review")
      .execute();
    const out = await fake.act(org, OWNER.accountId, "gate.confirm", {
      decisionId: gate.id,
      approve: true,
    });
    expect(out.toast?.en).toContain("no longer allowed");
    expect(out.invalidate).toContain("item.detail");
    expect((await decisionRow(item.id)).state).toBe("canceled");
    expect((await itemRow(item.id)).status_key).toBe("review");
    // Settled: a second click reads as closed, not as a failure.
    const again = await fake.act(org, OWNER.accountId, "gate.confirm", {
      decisionId: gate.id,
      approve: true,
    });
    expect(again.toast?.en).toBe("The item moved on.");
  });

  it("an archived project refuses every write until a project owner unarchives it", async () => {
    const org = "org-arch-readonly";
    const { project, item } = await inReview(org, "ARO");
    const fake = pageCtx(db, AGENTS);
    // An open gate request, then the project is archived.
    await fake.act(org, ENGINEER.accountId, "item.move", {
      itemId: item.id,
      version: item.version,
      to: "ready",
    });
    const gate = await decisionRow(item.id);
    const current = await itemRow(item.id);
    expect(
      await fake.act(org, OWNER.accountId, "settings.save", {
        projectId: project.id,
        archived: true,
      }),
    ).not.toHaveProperty("toast");

    const refusedEn = "The project is archived and read-only.";
    const writes: [string, string, object][] = [
      [ENGINEER.accountId, "item.comment", { itemId: item.id, body: "hi" }],
      [
        ENGINEER.accountId,
        "item.move",
        { itemId: item.id, version: current.version, to: "drafting" },
      ],
      [OWNER.accountId, "item.create", { projectId: project.id, type: "task", title: "New" }],
      [
        ENGINEER.accountId,
        "item.update",
        { itemId: item.id, version: current.version, title: "x" },
      ],
      [
        OWNER.accountId,
        "member.function",
        { projectId: project.id, accountId: QA.accountId, functionLabel: "x" },
      ],
      [OWNER.accountId, "settings.save", { projectId: project.id, name: "Renamed" }],
    ];
    for (const [who, action, payload] of writes) {
      const out = await fake.act(org, who, action, payload);
      expect(out.toast?.en, action).toContain(refusedEn);
    }
    // An answer cancels the open request (archived is read-only).
    const answer = await fake.act(org, OWNER.accountId, "gate.confirm", {
      decisionId: gate.id,
      approve: true,
    });
    expect(answer.toast?.en).toContain(refusedEn);
    expect((await decisionRow(item.id)).state).toBe("canceled");
    expect((await itemRow(item.id)).status_key).toBe("review");

    // Tools are refused with an actionable error.
    const tools = toolHarness(db, AGENTS, { [OWNER.accountId]: "Wang" });
    const call = { orgId: org, ownerAccountId: OWNER.accountId, agentId: "agent-pm" };
    expect(
      await errorOf(tools.run("item_comment", { key: "ARO-1", body: "from a tool" }, call)),
    ).toContain("archived");

    // A member cannot unarchive; the owner can, and writes work again.
    expect(
      (
        await fake.act(org, ENGINEER.accountId, "settings.save", {
          projectId: project.id,
          archived: false,
        })
      ).toast?.en,
    ).toBe("You are not allowed to do this.");
    expect(
      await fake.act(org, OWNER.accountId, "settings.save", {
        projectId: project.id,
        archived: false,
      }),
    ).not.toHaveProperty("toast");
    expect(
      await fake.act(org, ENGINEER.accountId, "item.comment", { itemId: item.id, body: "back" }),
    ).not.toHaveProperty("toast");
  });
});
