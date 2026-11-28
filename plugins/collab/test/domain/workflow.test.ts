import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assign } from "../../src/domain/assignment.js";
import { CollabError } from "../../src/domain/errors.js";
import { createItem, transition } from "../../src/domain/items.js";
import type { CollabDb } from "../../src/store/db.js";
import type { Actor, Item } from "../../src/store/types.js";
import { domainDb, ENGINEER, OWNER, OWNER_AGENT, outboxOf, QA, teamProject } from "./setup.js";

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
    expect(end.version).toBe(mid.version + 1);
  });

  it("entering testing hands a task to the qa member without an agent", async () => {
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
      null,
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
});
