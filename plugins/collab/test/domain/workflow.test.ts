import type { Updateable } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assign } from "../../src/domain/assignment.js";
import { CollabError } from "../../src/domain/errors.js";
import { createItem, transition as moveTo, updateItem } from "../../src/domain/items.js";
import { removeMember } from "../../src/domain/projects.js";
import type { CollabDb } from "../../src/store/db.js";
import type { Actor, Item, StatusesTable } from "../../src/store/types.js";
import {
  domainDb,
  ENGINEER,
  NO_DECISION_JOBS,
  OWNER,
  OWNER_AGENT,
  outboxOf,
  QA,
  teamProject,
} from "./setup.js";

/** `transition` with decision hooks that owe nothing (these tests do not look at inbox items). */
const transition = (...[d, o, a, i, v, to, opts]: Parameters<typeof moveTo>) =>
  moveTo(d, o, a, i, v, to, { decisions: NO_DECISION_JOBS, ...opts });

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

/** Changes one status of a project's workflow for a type (workflows are editable per project). */
async function editStatus(
  projectId: string,
  type: string,
  key: string,
  set: Updateable<StatusesTable>,
): Promise<void> {
  const wf = await db
    .selectFrom("workflows")
    .select("id")
    .where("project_id", "=", projectId)
    .where("item_type", "=", type)
    .executeTakeFirstOrThrow();
  await db
    .updateTable("statuses")
    .set(set)
    .where("workflow_id", "=", wf.id)
    .where("key", "=", key)
    .execute();
}

const statusOf = async (id: string) =>
  await db.selectFrom("items").selectAll().where("id", "=", id).executeTakeFirstOrThrow();

/** A requirement in "in_progress" with `n` tasks under it. */
async function parentWithChildren(org: string, key: string, n: number) {
  const project = await teamProject(db, org, key);
  let parent = await createItem(db, org, OWNER, {
    projectId: project.id,
    type: "requirement",
    title: "p",
  });
  parent = await walk(org, OWNER, parent, ["drafting", "review", "ready", "in_progress"]);
  const children: Item[] = [];
  for (let i = 0; i < n; i++) {
    children.push(
      await createItem(db, org, OWNER, {
        projectId: project.id,
        type: "task",
        title: `t${i}`,
        parentId: parent.id,
      }),
    );
  }
  return { project, parent, children };
}

/** Moves the item through `path` as `actor`, returning the item at the end. */
async function walk(org: string, actor: Actor, item: Item, path: string[]): Promise<Item> {
  let current = item;
  for (const to of path) {
    const result = await transition(db, org, actor, current.id, current.version, to);
    if (!("item" in result)) throw new Error(`gate at ${to}`);
    current = result.item;
  }
  return current;
}

describe("collab workflows", () => {
  it("next_keys restricts transitions", async () => {
    const org = "org-next";
    const project = await teamProject(db, org, "NXT");
    const req = await createItem(db, org, OWNER, {
      projectId: project.id,
      type: "requirement",
      title: "r",
    });
    expect(req.status_key).toBe("backlog");
    expect(await code(transition(db, org, OWNER, req.id, req.version, "in_progress"))).toBe(
      "invalid_transition",
    );
    expect(await code(transition(db, org, OWNER, req.id, req.version, "nope"))).toBe(
      "invalid_transition",
    );
    expect(await code(transition(db, org, OWNER, req.id, req.version, "drafting"))).toBe("ok");
  });

  it("agent into gated status returns a gate decision", async () => {
    const org = "org-gate";
    const project = await teamProject(db, org, "GATE");
    const created = await createItem(db, org, OWNER, {
      projectId: project.id,
      type: "requirement",
      title: "Export PDF",
    });
    const req = await walk(org, OWNER, created, ["drafting", "review"]);
    const result = await transition(db, org, OWNER_AGENT, req.id, req.version, "ready");
    if (!("gate" in result)) throw new Error("expected a gate");
    expect(result.gate).toMatchObject({
      kind: "gate",
      state: "open",
      addressee_account_id: OWNER.accountId,
      gate_target: "ready",
      asker: OWNER_AGENT,
    });
    const after = await db
      .selectFrom("items")
      .selectAll()
      .where("id", "=", req.id)
      .executeTakeFirstOrThrow();
    expect(after.status_key).toBe("review");
    expect((await outboxOf(db, org, req.id)).at(-1)?.type).toBe("gate.requested");
    // Asking again returns the same open decision.
    const again = await transition(db, org, OWNER_AGENT, req.id, after.version, "ready");
    expect("gate" in again && again.gate.id).toBe(result.gate.id);
    // A person who is not the confirmer is refused.
    expect(await code(transition(db, org, ENGINEER, req.id, after.version, "ready"))).toBe("gated");
  });

  it("entering ready reassigns to the engineering member and their agent", async () => {
    const org = "org-ready";
    const project = await teamProject(db, org, "RDY");
    const created = await createItem(db, org, OWNER, {
      projectId: project.id,
      type: "requirement",
      title: "Export PDF",
      responsibleAccountId: OWNER.accountId,
      executingAgentId: "agent-pm",
    });
    // The owner is the gate's confirmer, so a person move into "ready" goes through.
    const ready = await walk(org, OWNER, created, ["drafting", "review", "ready"]);
    expect(ready.status_key).toBe("ready");
    expect(ready.responsible_account_id).toBe(ENGINEER.accountId);
    expect(ready.executing_agent_id).toBe("agent-eng");
    const types = (await outboxOf(db, org, ready.id)).slice(-3).map((r) => [r.type, r.audience]);
    expect(types).toEqual([
      ["item.assigned", { accountId: ENGINEER.accountId, agentId: "agent-eng" }],
      ["item.status_changed", null],
      ["item.unassigned", { accountId: OWNER.accountId, agentId: "agent-pm" }],
    ]);
  });

  it("parent moves to acceptance when children are done", async () => {
    const org = "org-parent";
    const project = await teamProject(db, org, "PAR");
    let parent = await createItem(db, org, OWNER, {
      projectId: project.id,
      type: "requirement",
      title: "p",
    });
    parent = await walk(org, OWNER, parent, ["drafting", "review", "ready", "in_progress"]);
    const t1 = await createItem(db, org, OWNER, {
      projectId: project.id,
      type: "task",
      title: "t1",
      parentId: parent.id,
    });
    const t2 = await createItem(db, org, OWNER, {
      projectId: project.id,
      type: "task",
      title: "t2",
      parentId: parent.id,
    });
    await walk(org, OWNER, t1, ["in_progress", "testing", "done"]);
    const mid = await db
      .selectFrom("items")
      .selectAll()
      .where("id", "=", parent.id)
      .executeTakeFirstOrThrow();
    expect(mid.status_key).toBe("in_progress");
    await walk(org, OWNER, t2, ["canceled"]);
    const end = await db
      .selectFrom("items")
      .selectAll()
      .where("id", "=", parent.id)
      .executeTakeFirstOrThrow();
    expect(end.status_key).toBe("acceptance");
    // The move, then the request of the gated move to done (asked of the requester at once).
    expect(end.version).toBe(mid.version + 2);
  });

  it("entering testing hands a task to the qa member and their agent", async () => {
    const org = "org-qa";
    const project = await teamProject(db, org, "QAT");
    const task = await createItem(db, org, OWNER, {
      projectId: project.id,
      type: "task",
      title: "t",
      responsibleAccountId: ENGINEER.accountId,
      executingAgentId: "agent-eng",
    });
    const testing = await walk(org, ENGINEER, task, ["in_progress", "testing"]);
    expect([testing.responsible_account_id, testing.executing_agent_id]).toEqual([
      QA.accountId,
      "agent-qa",
    ]);
  });

  it("assign refuses a non-member and a stale version", async () => {
    const org = "org-assign";
    const project = await teamProject(db, org, "ASG");
    const task = await createItem(db, org, OWNER, {
      projectId: project.id,
      type: "task",
      title: "t",
    });
    expect(
      await code(
        assign(db, org, OWNER, task.id, task.version, {
          responsibleAccountId: "stranger",
          executingAgentId: null,
        }),
      ),
    ).toBe("invalid_assignee");
    const done = await assign(db, org, OWNER, task.id, task.version, {
      responsibleAccountId: ENGINEER.accountId,
      executingAgentId: "agent-eng",
    });
    expect(done.version).toBe(task.version + 1);
    expect(
      await code(
        assign(db, org, OWNER, task.id, task.version, {
          responsibleAccountId: QA.accountId,
          executingAgentId: null,
        }),
      ),
    ).toBe("version_conflict");
  });

  it("only the requester accepts a requirement, not the responsible engineer", async () => {
    const org = "org-accept";
    const project = await teamProject(db, org, "ACC");
    const created = await createItem(db, org, OWNER, {
      projectId: project.id,
      type: "requirement",
      title: "r",
    });
    expect(created.requester_account_id).toBe(OWNER.accountId);
    const accepting = await walk(org, OWNER, created, [
      "drafting",
      "review",
      "ready",
      "in_progress",
      "acceptance",
    ]);
    // "ready" handed it to the engineer; assignment keeps the requester.
    expect(accepting.responsible_account_id).toBe(ENGINEER.accountId);
    expect(accepting.requester_account_id).toBe(OWNER.accountId);
    expect(await code(transition(db, org, ENGINEER, accepting.id, accepting.version, "done"))).toBe(
      "gated",
    );
    // Self-assigning does not open the gate either.
    const mine = await assign(db, org, ENGINEER, accepting.id, accepting.version, {
      responsibleAccountId: ENGINEER.accountId,
      executingAgentId: null,
    });
    expect(await code(transition(db, org, ENGINEER, mine.id, mine.version, "done"))).toBe("gated");
    const agentAsk = await transition(
      db,
      org,
      { ...ENGINEER, agentId: "agent-eng", conversationId: "c" },
      mine.id,
      mine.version,
      "done",
    );
    expect("gate" in agentAsk && agentAsk.gate.addressee_account_id).toBe(OWNER.accountId);
    const fresh = await statusOf(mine.id);
    expect(await code(transition(db, org, OWNER, fresh.id, fresh.version, "done"))).toBe("ok");
  });

  it("parent entering in_progress with every child closed moves on to acceptance", async () => {
    const org = "org-late";
    const project = await teamProject(db, org, "LATE");
    let parent = await createItem(db, org, OWNER, {
      projectId: project.id,
      type: "requirement",
      title: "p",
    });
    parent = await walk(org, OWNER, parent, ["drafting", "review", "ready"]);
    const t = await createItem(db, org, OWNER, {
      projectId: project.id,
      type: "task",
      title: "t",
      parentId: parent.id,
    });
    await walk(org, OWNER, t, ["canceled"]);
    parent = await statusOf(parent.id);
    const moved = await transition(db, org, ENGINEER, parent.id, parent.version, "in_progress");
    const stored = await statusOf(parent.id);
    expect(stored.status_key).toBe("acceptance");
    // The returned row is the auto-moved one, so the caller's next write does not conflict.
    if (!("item" in moved)) throw new Error("expected a move");
    expect([moved.item.status_key, moved.item.version]).toEqual(["acceptance", stored.version]);
    await updateItem(db, org, ENGINEER, moved.item.id, moved.item.version, { title: "p2" });
  });

  it("a gate request opened by entering in_progress returns the fresh version", async () => {
    const org = "org-lategate";
    const project = await teamProject(db, org, "LGT");
    await editStatus(project.id, "requirement", "acceptance", {
      gate: JSON.stringify({ confirmer: "owner" }),
    });
    let parent = await createItem(db, org, OWNER, {
      projectId: project.id,
      type: "requirement",
      title: "p",
    });
    parent = await walk(org, OWNER, parent, ["drafting", "review", "ready"]);
    const t = await createItem(db, org, OWNER, {
      projectId: project.id,
      type: "task",
      title: "t",
      parentId: parent.id,
    });
    await walk(org, OWNER, t, ["canceled"]);
    parent = await statusOf(parent.id);
    // Even the confirmer moving it gets a decision: acceptance stays an explicit act.
    const moved = await transition(db, org, OWNER, parent.id, parent.version, "in_progress");
    if (!("item" in moved)) throw new Error("expected a move");
    expect([moved.item.status_key, moved.item.version]).toEqual([
      "in_progress",
      (await statusOf(parent.id)).version,
    ]);
    await updateItem(db, org, OWNER, moved.item.id, moved.item.version, { title: "p2" });
  });

  it("a requester who left the project hands the acceptance gate to the owner", async () => {
    const org = "org-gone";
    const project = await teamProject(db, org, "GONE");
    const created = await createItem(db, org, QA, {
      projectId: project.id,
      type: "requirement",
      title: "r",
    });
    const accepting = await walk(org, OWNER, created, [
      "drafting",
      "review",
      "ready",
      "in_progress",
      "acceptance",
    ]);
    await removeMember(db, org, OWNER, project.id, QA.accountId, NO_DECISION_JOBS);
    const ask = await transition(
      db,
      org,
      { ...ENGINEER, agentId: "agent-eng", conversationId: "c" },
      accepting.id,
      accepting.version,
      "done",
    );
    expect("gate" in ask && ask.gate.addressee_account_id).toBe(OWNER.accountId);
    const fresh = await statusOf(accepting.id);
    expect(await code(transition(db, org, OWNER, fresh.id, fresh.version, "done"))).toBe("ok");
  });

  it("two children closing at once still move the parent", async () => {
    const org = "org-together";
    const { parent, children } = await parentWithChildren(org, "TOG", 2);
    const moved = await Promise.all(
      children.map((c) => walk(org, OWNER, c, ["in_progress", "testing"])),
    );
    await Promise.all(moved.map((c) => transition(db, org, QA, c.id, c.version, "done")));
    expect((await statusOf(parent.id)).status_key).toBe("acceptance");
  });

  it("parent auto-move asks the gate when acceptance is gated", async () => {
    const org = "org-autogate";
    const { project, parent, children } = await parentWithChildren(org, "AGT", 1);
    await editStatus(project.id, "requirement", "acceptance", {
      gate: JSON.stringify({ confirmer: "owner" }),
    });
    await walk(org, OWNER, children[0] as Item, ["canceled"]);
    expect((await statusOf(parent.id)).status_key).toBe("in_progress");
    const gate = await db
      .selectFrom("decisions")
      .selectAll()
      .where("item_id", "=", parent.id)
      .where("state", "=", "open")
      .executeTakeFirstOrThrow();
    expect(gate).toMatchObject({
      kind: "gate",
      gate_target: "acceptance",
      addressee_account_id: OWNER.accountId,
    });
  });

  it("parent auto-move is skipped when the workflow does not allow it", async () => {
    const org = "org-noauto";
    const { project, parent, children } = await parentWithChildren(org, "NOA", 1);
    await editStatus(project.id, "requirement", "in_progress", {
      next_keys: ["ready", "canceled"],
    });
    await walk(org, OWNER, children[0] as Item, ["canceled"]);
    expect((await statusOf(parent.id)).status_key).toBe("in_progress");
  });
});
