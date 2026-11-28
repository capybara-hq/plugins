import { afterAll, beforeAll, expect, it } from "vitest";
import { watcherIds } from "../../src/domain/internal.js";
import { createItem } from "../../src/domain/items.js";
import { addMember, removeMember } from "../../src/domain/projects.js";
import { setItemWatching } from "../../src/domain/watchers.js";
import type { CollabDb } from "../../src/store/db.js";
import { domainDb, ENGINEER, GUEST, OWNER, teamProject } from "./setup.js";

let db: CollabDb;
let close: () => Promise<void>;
beforeAll(async () => {
  ({ db, close } = await domainDb());
});
afterAll(async () => {
  await close?.();
});

it("follows and unfollows for the actor only and drops subscriptions on member removal", async () => {
  const org = "watch-org";
  const project = await teamProject(db, org, "WATCH");
  const item = await createItem(db, org, OWNER, {
    projectId: project.id,
    type: "task",
    title: "Follow me",
  });
  await expect(setItemWatching(db, org, OWNER, item.id, true)).resolves.toBe(true);
  await expect(setItemWatching(db, org, OWNER, item.id, true)).resolves.toBe(true);
  await expect(setItemWatching(db, org, ENGINEER, item.id, true)).resolves.toBe(true);
  await expect(watcherIds(db, org, item.id)).resolves.toEqual([
    ENGINEER.accountId,
    OWNER.accountId,
  ]);
  await expect(watcherIds(db, "other-org", item.id)).resolves.toEqual([]);
  await expect(setItemWatching(db, "other-org", OWNER, item.id, true)).rejects.toMatchObject({
    code: "not_found",
  });
  await expect(setItemWatching(db, org, GUEST, item.id, true)).rejects.toMatchObject({
    code: "forbidden",
  });
  await addMember(db, org, OWNER, project.id, ENGINEER.accountId, { role: "guest" });
  await expect(watcherIds(db, org, item.id)).resolves.toEqual([OWNER.accountId]);
  await addMember(db, org, OWNER, project.id, ENGINEER.accountId, { role: "member" });
  await setItemWatching(db, org, ENGINEER, item.id, true);
  await removeMember(db, org, OWNER, project.id, ENGINEER.accountId);
  await expect(watcherIds(db, org, item.id)).resolves.toEqual([OWNER.accountId]);
  await expect(setItemWatching(db, org, OWNER, item.id, false)).resolves.toBe(false);
  await expect(setItemWatching(db, org, OWNER, item.id, false)).resolves.toBe(false);
  await db.updateTable("projects").set({ archived: true }).where("id", "=", project.id).execute();
  await expect(setItemWatching(db, org, OWNER, item.id, true)).rejects.toMatchObject({
    code: "archived",
  });
});

it("enforces the watcher cap across concurrent requests and allows an idempotent repeat", async () => {
  const org = "watch-cap";
  const project = await teamProject(db, org, "CAP");
  const item = await createItem(db, org, OWNER, {
    projectId: project.id,
    type: "task",
    title: "Popular item",
  });
  const accounts = Array.from({ length: 65 }, (_, index) => `watcher-${index}`);
  await db
    .insertInto("project_members")
    .values(
      accounts.map((account_id) => ({
        org_id: org,
        project_id: project.id,
        account_id,
        role: "member",
      })),
    )
    .execute();
  const results = await Promise.allSettled(
    accounts.map((accountId) => setItemWatching(db, org, { accountId }, item.id, true)),
  );
  const refused = results.filter((result) => result.status === "rejected");
  expect(refused).toEqual([
    { status: "rejected", reason: expect.objectContaining({ code: "watcher_limit" }) },
  ]);
  const watchers = await watcherIds(db, org, item.id);
  expect(watchers).toHaveLength(64);
  await expect(
    setItemWatching(db, org, { accountId: watchers[0] as string }, item.id, true),
  ).resolves.toBe(true);
});
