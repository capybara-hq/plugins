import type { RunLifecyclePayload, SubjectConversation } from "@capybara-hq/plugin-sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assign } from "../../src/domain/assignment.js";
import { createItem } from "../../src/domain/items.js";
import { onRunLifecycle } from "../../src/lifecycle.js";
import type { CollabDb } from "../../src/store/db.js";
import type { Item } from "../../src/store/types.js";
import { domainDb, ENGINEER, OWNER, outboxOf, teamProject } from "../domain/setup.js";
import { noticeCtx } from "./fake.js";

let db: CollabDb;
let close: () => Promise<void>;
beforeAll(async () => {
  ({ db, close } = await domainDb());
});
afterAll(async () => {
  await close();
});

/** A task handed to the engineer and agent-eng. */
async function assigned(orgId: string, key: string): Promise<Item> {
  const project = await teamProject(db, orgId, key);
  const item = await createItem(db, orgId, OWNER, {
    projectId: project.id,
    type: "task",
    title: "Fix login",
  });
  return assign(db, orgId, OWNER, item.id, item.version, {
    responsibleAccountId: ENGINEER.accountId,
    executingAgentId: "agent-eng",
  });
}

function conv(state: SubjectConversation["state"], over: Partial<SubjectConversation> = {}) {
  return {
    id: "conv-work",
    ownerAccountId: ENGINEER.accountId,
    agentId: "agent-eng",
    state,
    lastActivityAt: new Date().toISOString(),
    ...over,
  };
}

function phase(
  orgId: string,
  item: Item,
  p: RunLifecyclePayload["phase"],
  over: Partial<RunLifecyclePayload> = {},
): RunLifecyclePayload {
  return {
    orgId,
    accountId: ENGINEER.accountId,
    agentId: "agent-eng",
    conversationId: "conv-work",
    runId: "run-1",
    phase: p,
    subject: { kind: "item", id: item.id },
    ...over,
  };
}

/** An `offer_declined` delivery: no run, no conversation. */
function declined(
  orgId: string,
  item: Item,
  reason: NonNullable<RunLifecyclePayload["reason"]>,
  agentId = "agent-eng",
): RunLifecyclePayload {
  return {
    orgId,
    accountId: ENGINEER.accountId,
    agentId,
    phase: "offer_declined",
    subject: { kind: "item", id: item.id },
    reason,
  };
}

async function reload(item: Item): Promise<Item> {
  return db.selectFrom("items").selectAll().where("id", "=", item.id).executeTakeFirstOrThrow();
}

describe("run state", () => {
  it("lifecycle phases update agent_state and invalidate", async () => {
    const org = "org-life-1";
    const item = await assigned(org, "LFA");
    const fake = noticeCtx(db, {});

    fake.conversations.set(item.id, [conv("running")]);
    await onRunLifecycle(fake.ctx, phase(org, item, "started"));
    let now = await reload(item);
    expect(now.agent_state).toBe("working");
    expect(now.agent_conversation_id).toBe("conv-work");
    expect(now.version).toBe(item.version);
    expect(fake.invalidations).toContainEqual({ orgId: org, contribution: "projects" });

    fake.conversations.set(item.id, [conv("waiting")]);
    await onRunLifecycle(fake.ctx, phase(org, item, "waiting", { waitingOn: "input" }));
    expect((await reload(item)).agent_state).toBe("waiting");

    fake.conversations.set(item.id, [conv("running")]);
    await onRunLifecycle(fake.ctx, phase(org, item, "resumed", { waitingOn: "input" }));
    expect((await reload(item)).agent_state).toBe("working");

    fake.conversations.set(item.id, [conv("idle")]);
    await onRunLifecycle(fake.ctx, phase(org, item, "finished"));
    now = await reload(item);
    expect(now.agent_state).toBe("idle");

    // A repeated delivery changes nothing and refreshes nothing.
    const before = fake.invalidations.length;
    await onRunLifecycle(fake.ctx, phase(org, item, "finished"));
    expect(fake.invalidations.length).toBe(before);
  });

  it("a stale started after the run finished never turns idle back to working", async () => {
    const org = "org-life-2";
    const item = await assigned(org, "LFB");
    const fake = noticeCtx(db, {});
    fake.conversations.set(item.id, [conv("idle")]);
    await onRunLifecycle(fake.ctx, phase(org, item, "finished"));
    await onRunLifecycle(fake.ctx, phase(org, item, "started"));
    expect((await reload(item)).agent_state).toBe("idle");
  });

  it("events of a pair or conversation that no longer executes the item are ignored", async () => {
    const org = "org-life-3";
    const item = await assigned(org, "LFC");
    const fake = noticeCtx(db, {});
    fake.conversations.set(item.id, [
      conv("running"),
      conv("running", { id: "conv-old", agentId: "agent-old" }),
    ]);
    await onRunLifecycle(
      fake.ctx,
      phase(org, item, "started", { agentId: "agent-old", conversationId: "conv-old" }),
    );
    // A conversation of the right agent but another owner (a forwarded chat) does not count.
    fake.conversations.set(item.id, [conv("running", { ownerAccountId: OWNER.accountId })]);
    await onRunLifecycle(fake.ctx, phase(org, item, "started"));
    // Another org, another kind.
    await onRunLifecycle(fake.ctx, phase("org-other", item, "started"));
    await onRunLifecycle(
      fake.ctx,
      phase(org, item, "started", { subject: { kind: "page", id: item.id } }),
    );
    expect((await reload(item)).agent_state).toBeNull();
    expect(fake.invalidations).toHaveLength(0);
  });

  it("a new assignment clears the run state", async () => {
    const org = "org-life-4";
    const item = await assigned(org, "LFD");
    const fake = noticeCtx(db, {});
    fake.conversations.set(item.id, [conv("running")]);
    await onRunLifecycle(fake.ctx, phase(org, item, "started"));
    const now = await reload(item);
    await assign(db, org, OWNER, item.id, now.version, {
      responsibleAccountId: ENGINEER.accountId,
      executingAgentId: null,
    });
    const after = await reload(item);
    expect(after.agent_state).toBeNull();
    expect(after.agent_conversation_id).toBeNull();
  });

  it("offer_declined marks declined", async () => {
    const org = "org-life-5";
    const item = await assigned(org, "LFE");
    const fake = noticeCtx(db, {});
    const offer = declined(org, item, "declined");
    await onRunLifecycle(fake.ctx, offer);
    await onRunLifecycle(fake.ctx, offer);
    const now = await reload(item);
    expect(now.agent_state).toBe("declined");
    expect(now.executing_agent_id).toBe("agent-eng");
    const entries = await db
      .selectFrom("activity")
      .selectAll()
      .where("item_id", "=", item.id)
      .where("kind", "=", "agent_declined")
      .execute();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.detail).toEqual({
      accountId: ENGINEER.accountId,
      agentId: "agent-eng",
      reason: "declined",
    });
    expect(fake.invalidations).toContainEqual({ orgId: org, contribution: "projects" });
  });

  it("an undelivered offer takes the agent off; the person keeps the item", async () => {
    const org = "org-life-6";
    const item = await assigned(org, "LFF");
    const fake = noticeCtx(db, {});
    const undelivered = declined(org, item, "undelivered");
    await onRunLifecycle(fake.ctx, undelivered);
    await onRunLifecycle(fake.ctx, undelivered);
    const now = await reload(item);
    expect(now.responsible_account_id).toBe(ENGINEER.accountId);
    expect(now.executing_agent_id).toBeNull();
    expect(now.version).toBe(item.version + 1);
    const kinds = (
      await db.selectFrom("activity").select("kind").where("item_id", "=", item.id).execute()
    ).map((a) => a.kind);
    expect(kinds.filter((k) => k === "agent_declined")).toHaveLength(1);
    expect(kinds.filter((k) => k === "assigned")).toHaveLength(2);
    const types = (await outboxOf(db, org, item.id)).map((r) => r.type);
    expect(types).toContain("item.unassigned");
  });

  it("an offer declined for a pair that no longer has the item is ignored", async () => {
    const org = "org-life-7";
    const item = await assigned(org, "LFG");
    const fake = noticeCtx(db, {});
    await onRunLifecycle(fake.ctx, declined(org, item, "off", "agent-old"));
    expect((await reload(item)).agent_state).toBeNull();
  });
});
