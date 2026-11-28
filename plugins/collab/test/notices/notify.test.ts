import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assign } from "../../src/domain/assignment.js";
import { createItem, transition } from "../../src/domain/items.js";
import { addMember } from "../../src/domain/projects.js";
import { notifying } from "../../src/notify.js";
import type { CollabDb } from "../../src/store/db.js";
import { domainDb, ENGINEER, OWNER, OWNER_AGENT, QA, teamProject } from "../domain/setup.js";
import { noticeCtx } from "./fake.js";

let db: CollabDb;
let close: () => Promise<void>;
beforeAll(async () => {
  ({ db, close } = await domainDb());
});
afterAll(async () => {
  await close();
});

const AGENTS = {
  [ENGINEER.accountId]: [{ id: "agent-eng", name: "Engineer agent" }],
  [QA.accountId]: [{ id: "agent-qa", name: "QA agent" }],
};

async function task(orgId: string, key: string) {
  const project = await teamProject(db, orgId, key);
  const item = await createItem(db, orgId, OWNER, {
    projectId: project.id,
    type: "task",
    title: "Fix login",
  });
  return { project, item };
}

async function activityOf(itemId: string) {
  return db
    .selectFrom("activity")
    .selectAll()
    .where("item_id", "=", itemId)
    .orderBy("created_at")
    .execute();
}

describe("assignment notices", () => {
  it("assignment by someone else posts one inbox item with a stop action", async () => {
    const org = "org-notice-1";
    const { item } = await task(org, "NOA");
    const fake = noticeCtx(db, AGENTS);
    await notifying(fake.ctx, org, () =>
      assign(db, org, OWNER_AGENT, item.id, item.version, {
        responsibleAccountId: ENGINEER.accountId,
        executingAgentId: "agent-eng",
      }),
    );
    expect(fake.posts).toHaveLength(1);
    const post = fake.posts[0];
    expect(post).toMatchObject({
      orgId: org,
      accountId: ENGINEER.accountId,
      kind: "collab.assigned",
      title: "NOA-1 assigned to you: Fix login",
      body: "Engineer agent is working on it.",
      link: "/p/collab/projects?item=NOA-1",
    });
    expect(post?.actions).toEqual([
      {
        id: "stop",
        label: { zh: "停止智能体", en: "Stop agent" },
        style: "danger",
        uiAction: {
          contribution: "projects",
          actionId: "inbox.stop-agent",
          payload: { itemId: item.id, agentId: "agent-eng" },
        },
      },
    ]);
    expect(post?.dedupeKey).toMatch(new RegExp(`^collab\\.assigned-${item.id}-`));
  });

  it("self-assignment and taking the agent off post nothing", async () => {
    const org = "org-notice-2";
    const { item } = await task(org, "NOB");
    const fake = noticeCtx(db, AGENTS);
    // The engineer takes the item for themselves.
    const mine = await notifying(fake.ctx, org, () =>
      assign(db, org, ENGINEER, item.id, item.version, {
        responsibleAccountId: ENGINEER.accountId,
        executingAgentId: "agent-eng",
      }),
    );
    // The owner takes the agent off: the engineer keeps it, nobody is told.
    await notifying(fake.ctx, org, () =>
      assign(db, org, OWNER, item.id, mine.version, {
        responsibleAccountId: ENGINEER.accountId,
        executingAgentId: null,
      }),
    );
    expect(fake.posts).toHaveLength(0);
  });

  it("a handoff into a status with a default assignment notifies the new responsible person", async () => {
    const org = "org-notice-3";
    const { item } = await task(org, "NOC");
    const fake = noticeCtx(db, AGENTS);
    const moved = await transition(db, org, OWNER, item.id, item.version, "in_progress");
    if (!("item" in moved)) throw new Error("gated");
    await notifying(fake.ctx, org, () =>
      transition(db, org, OWNER, item.id, moved.item.version, "testing"),
    );
    expect(fake.posts.map((p) => [p.accountId, p.kind, p.body])).toEqual([
      [QA.accountId, "collab.assigned", "QA agent is working on it."],
    ]);
  });

  it("a default assignment matching several members asks the project owner to pick", async () => {
    const org = "org-notice-4";
    const { project, item } = await task(org, "NOD");
    await addMember(db, org, OWNER, project.id, "acct-qa2", {
      role: "member",
      functionLabel: "qa",
    });
    const fake = noticeCtx(db, AGENTS);
    const moved = await transition(db, org, ENGINEER, item.id, item.version, "in_progress");
    if (!("item" in moved)) throw new Error("gated");
    const done = await notifying(fake.ctx, org, () =>
      transition(db, org, ENGINEER, item.id, moved.item.version, "testing"),
    );
    if (!("item" in done)) throw new Error("gated");
    expect(done.item.responsible_account_id).toBe(item.responsible_account_id);
    expect(fake.posts).toHaveLength(1);
    expect(fake.posts[0]).toMatchObject({
      accountId: OWNER.accountId,
      kind: "collab.handoff",
      title: "Pick who gets NOD-1: Fix login",
      link: "/p/collab/projects?item=NOD-1",
    });
    expect(fake.posts[0]?.body).toContain('function "qa"');
    expect((await activityOf(item.id)).map((a) => a.kind)).toContain("handoff_unresolved");
  });

  it("stop action unassigns the agent and records activity", async () => {
    const org = "org-notice-5";
    const { item } = await task(org, "NOE");
    const fake = noticeCtx(db, AGENTS);
    await notifying(fake.ctx, org, () =>
      assign(db, org, OWNER, item.id, item.version, {
        responsibleAccountId: ENGINEER.accountId,
        executingAgentId: "agent-eng",
      }),
    );
    const post = fake.posts[0];
    if (!post) throw new Error("no notice");

    // Someone who is neither the responsible person nor the owner cannot stop it.
    const refused = await fake.click(org, QA.accountId, post, "stop");
    expect(refused).toMatchObject({
      toast: { en: expect.stringMatching(/only the responsible/i) },
    });

    const result = await fake.click(org, ENGINEER.accountId, post, "stop");
    expect(result).toMatchObject({ toast: { en: "Agent stopped" } });
    const after = await db
      .selectFrom("items")
      .selectAll()
      .where("id", "=", item.id)
      .executeTakeFirstOrThrow();
    expect(after.responsible_account_id).toBe(ENGINEER.accountId);
    expect(after.executing_agent_id).toBeNull();
    const last = (await activityOf(item.id)).filter((a) => a.kind === "assigned").at(-1);
    expect(last?.actor).toEqual({ accountId: ENGINEER.accountId });
    expect(last?.detail).toMatchObject({ to: { accountId: ENGINEER.accountId, agentId: null } });
    expect(fake.invalidations).toContainEqual({ orgId: org, contribution: "projects" });

    // At least once: a second click changes nothing.
    const again = await fake.click(org, ENGINEER.accountId, post, "stop");
    expect(again).toMatchObject({ toast: { en: expect.stringMatching(/no longer/i) } });
    const still = await db
      .selectFrom("items")
      .select("version")
      .where("id", "=", item.id)
      .executeTakeFirstOrThrow();
    expect(still.version).toBe(after.version);
  });

  it("an old notice's stop never touches a newer assignment", async () => {
    const org = "org-notice-6";
    const { item } = await task(org, "NOF");
    const fake = noticeCtx(db, AGENTS);
    const first = await notifying(fake.ctx, org, () =>
      assign(db, org, OWNER, item.id, item.version, {
        responsibleAccountId: ENGINEER.accountId,
        executingAgentId: "agent-eng",
      }),
    );
    await assign(db, org, OWNER, item.id, first.version, {
      responsibleAccountId: QA.accountId,
      executingAgentId: "agent-qa",
    });
    const post = fake.posts[0];
    if (!post) throw new Error("no notice");
    // The project owner clicks the engineer's old notice (forwarded): QA's agent stays.
    await fake.click(org, OWNER.accountId, post, "stop");
    const after = await db
      .selectFrom("items")
      .selectAll()
      .where("id", "=", item.id)
      .executeTakeFirstOrThrow();
    expect(after.executing_agent_id).toBe("agent-qa");
  });
});
