import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EVENT_TYPES } from "../../src/constants.js";
import { createItem } from "../../src/domain/items.js";
import { removeMember } from "../../src/domain/projects.js";
import { EVENT_DECLARATIONS } from "../../src/events/declarations.js";
import { createTriggerSource } from "../../src/events/source.js";
import type { CollabDb } from "../../src/store/db.js";
import { domainDb, ENGINEER, GUEST, OWNER, QA, teamProject } from "../domain/setup.js";

let db: CollabDb;
let close: () => Promise<void>;
beforeAll(async () => {
  ({ db, close } = await domainDb());
});
afterAll(async () => {
  await close();
});

describe("collab trigger source", () => {
  it("declares every emitted type with the filterable facts; assignment and answers are directed", () => {
    const source = createTriggerSource(db);
    const events = source.events();
    expect(events.map((e) => e.type)).toEqual([...EVENT_TYPES]);
    expect(events).toBe(EVENT_DECLARATIONS);
    const directed = events.filter((e) => e.directed).map((e) => e.type);
    expect(directed.sort()).toEqual(["decision.answered", "item.assigned", "item.unassigned"]);
    for (const e of events) {
      expect(Object.keys(e.facts).sort()).toEqual(
        [
          "changedFields",
          "executingAgentId",
          "itemType",
          "labels",
          "mentions",
          "priority",
          "projectKey",
          "responsibleAccountId",
          "status",
          "statusCategory",
        ].sort(),
      );
      for (const f of Object.values(e.facts)) expect(f.filterable).toBe(true);
      expect(e.name.zh && e.name.en).toBeTruthy();
    }
  });

  it("removed member is not visible", async () => {
    const org = "org-vis";
    const project = await teamProject(db, org, "VIS");
    const item = await createItem(db, org, OWNER, {
      projectId: project.id,
      type: "task",
      title: "seen",
    });
    const source = createTriggerSource(db);
    const subject = { kind: "item", id: item.id, title: "VIS-1 seen" };
    const all = [OWNER.accountId, ENGINEER.accountId, QA.accountId, GUEST.accountId, "acct-out"];
    expect((await source.visible({ orgId: org, accountIds: all, subject })).sort()).toEqual(
      [OWNER.accountId, ENGINEER.accountId, QA.accountId, GUEST.accountId].sort(),
    );
    await removeMember(db, org, OWNER, project.id, QA.accountId);
    const after = await source.visible({ orgId: org, accountIds: all, subject });
    expect(after).not.toContain(QA.accountId);
    expect(after).toContain(ENGINEER.accountId);
    // Another org, another kind or a malformed id sees nothing.
    expect(await source.visible({ orgId: "org-other", accountIds: all, subject })).toEqual([]);
    expect(
      await source.visible({ orgId: org, accountIds: all, subject: { ...subject, kind: "doc" } }),
    ).toEqual([]);
    expect(
      await source.visible({ orgId: org, accountIds: all, subject: { ...subject, id: "nope" } }),
    ).toEqual([]);
  });

  it("links a subject to the in-app item page", async () => {
    const org = "org-link";
    const project = await teamProject(db, org, "LNK");
    const item = await createItem(db, org, OWNER, {
      projectId: project.id,
      type: "task",
      title: "linked",
    });
    const source = createTriggerSource(db);
    const subject = { kind: "item", id: item.id, title: "LNK-1 linked" };
    expect(await source.subjectLink?.({ orgId: org, subject })).toBe(
      "/p/collab/projects?item=LNK-1",
    );
    expect(await source.subjectLink?.({ orgId: "org-other", subject })).toBeNull();
    expect(await source.subjectLink?.({ orgId: org, subject: { ...subject, id: "x" } })).toBeNull();
  });
});
