import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CollabError } from "../../src/domain/errors.js";
import {
  attachArtifact,
  comment,
  createItem,
  link,
  transition,
  updateItem,
} from "../../src/domain/items.js";
import type { CollabDb } from "../../src/store/db.js";
import { domainDb, GUEST, OWNER, OWNER_AGENT, outboxOf, teamProject } from "./setup.js";

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

describe("collab items", () => {
  it("parallel creates allocate distinct keys", async () => {
    const project = await teamProject(db, "org-keys", "KEYS");
    const items = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        createItem(db, "org-keys", OWNER, { projectId: project.id, type: "task", title: `t${i}` }),
      ),
    );
    const numbers = items.map((i) => i.number).sort((a, b) => a - b);
    expect(numbers).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
  });

  it("concurrent transition: second gets version_conflict", async () => {
    const project = await teamProject(db, "org-race", "RACE");
    const item = await createItem(db, "org-race", OWNER, {
      projectId: project.id,
      type: "task",
      title: "race",
    });
    const results = await Promise.all([
      code(transition(db, "org-race", OWNER, item.id, item.version, "in_progress")),
      code(transition(db, "org-race", OWNER, item.id, item.version, "canceled")),
    ]);
    expect(results.sort()).toEqual(["ok", "version_conflict"]);
    // A stale version after the move also conflicts.
    expect(
      await code(updateItem(db, "org-race", OWNER, item.id, item.version, { title: "x" })),
    ).toBe("version_conflict");
  });

  it("guest cannot create items", async () => {
    const project = await teamProject(db, "org-guest", "GST");
    expect(
      await code(
        createItem(db, "org-guest", GUEST, { projectId: project.id, type: "task", title: "no" }),
      ),
    ).toBe("forbidden");
    // A non-member does not learn that the project exists.
    expect(
      await code(
        createItem(
          db,
          "org-guest",
          { accountId: "stranger" },
          { projectId: project.id, type: "task", title: "no" },
        ),
      ),
    ).toBe("not_found");
    // Another org never sees the project.
    expect(
      await code(
        createItem(db, "org-other", OWNER, { projectId: project.id, type: "task", title: "no" }),
      ),
    ).toBe("not_found");
  });

  it("each write appends activity and an outbox row and bumps the version", async () => {
    const org = "org-writes";
    const project = await teamProject(db, org, "WR");
    const a = await createItem(db, org, OWNER_AGENT, {
      projectId: project.id,
      type: "task",
      title: "first",
      responsibleAccountId: OWNER.accountId,
      executingAgentId: "agent-pm",
    });
    const b = await createItem(db, org, OWNER, {
      projectId: project.id,
      type: "task",
      title: "second",
    });
    const updated = await updateItem(db, org, OWNER, a.id, a.version, {
      title: "renamed",
      priority: 1,
    });
    expect(updated.version).toBe(a.version + 1);
    await comment(db, org, OWNER, a.id, "looks good");
    await link(db, org, OWNER, { fromId: a.id, toId: b.id, kind: "blocks" });
    await link(db, org, OWNER, { fromId: a.id, toId: b.id, kind: "blocks" });
    const v1 = await attachArtifact(db, org, OWNER, a.id, {
      kind: "doc",
      name: "PRD",
      url: "https://x.test/1",
    });
    const v2 = await attachArtifact(db, org, OWNER, a.id, {
      kind: "doc",
      name: "PRD",
      url: "https://x.test/2",
    });
    expect([v1.version, v2.version]).toEqual([1, 2]);

    const rows = await outboxOf(db, org, a.id);
    expect(rows.map((r) => r.type)).toEqual([
      "item.assigned",
      "item.created",
      "item.updated",
      "item.commented",
      "item.updated",
      "item.updated",
      "item.updated",
    ]);
    expect(new Set(rows.map((r) => r.dedupe_key)).size).toBe(rows.length);
    expect(rows[0]?.audience).toEqual({ accountId: OWNER.accountId, agentId: "agent-pm" });
    expect(rows[1]?.cause).toEqual(OWNER_AGENT);
    expect(rows[1]?.subject).toMatchObject({
      title: "WR-1 first",
      url: "/p/collab/projects?item=WR-1",
    });
    expect(rows[1]?.facts).toMatchObject({ projectKey: "WR", itemType: "task", status: "todo" });

    const activity = await db
      .selectFrom("activity")
      .select("kind")
      .where("org_id", "=", org)
      .where("item_id", "=", a.id)
      .orderBy("created_at")
      .execute();
    expect(activity.map((r) => r.kind)).toEqual([
      "created",
      "updated",
      "commented",
      "linked",
      "artifact_attached",
      "artifact_attached",
    ]);
    const final = await db
      .selectFrom("items")
      .select("version")
      .where("id", "=", a.id)
      .executeTakeFirstOrThrow();
    expect(final.version).toBe(6);
  });
});
