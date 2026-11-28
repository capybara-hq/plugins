import type { ToolCallContext, TriggerEvent } from "@capybara-hq/plugin-sdk";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { comment, createItem, transition, updateItem } from "../../src/domain/items.js";
import {
  EMIT_QUEUE,
  type EmitJob,
  type EmitterCtx,
  emitting,
  registerEmitQueue,
  toolActor,
} from "../../src/events/emitter.js";
import type { CollabDb } from "../../src/store/db.js";
import { domainDb, OWNER, outboxOf, teamProject } from "../domain/setup.js";

let db: CollabDb;
let close: () => Promise<void>;
beforeAll(async () => {
  ({ db, close } = await domainDb());
});
afterAll(async () => {
  await close();
});

/** A ctx with the kernel's emit dedupe, a recording queue and a switch that makes emits fail. */
function fakeCtx() {
  const emitted: TriggerEvent[] = [];
  const keys = new Set<string>();
  const jobs: { name: string; data: EmitJob; opts?: { delayMs?: number; jobId?: string } }[] = [];
  const handlers = new Map<string, (data: EmitJob) => Promise<void>>();
  const state = { failing: false };
  const ctx = {
    db,
    log: { info() {}, warn() {}, error() {} },
    triggers: {
      async emit(e: TriggerEvent) {
        if (state.failing) throw new Error("kernel unavailable");
        const key = `${e.orgId}/${e.type}/${e.dedupeKey}`;
        const duplicate = keys.has(key);
        keys.add(key);
        if (!duplicate) emitted.push(e);
        return { eventId: key, duplicate };
      },
      async causeOf(call: ToolCallContext) {
        return `handle-${call.callId}`;
      },
    },
    queue: {
      define(name: string, handler: (data: EmitJob) => Promise<void>) {
        handlers.set(name, handler);
      },
      async add(name: string, data: EmitJob, opts?: { delayMs?: number; jobId?: string }) {
        jobs.push({ name, data, ...(opts ? { opts } : {}) });
      },
    },
    people: {
      async get({ accountIds }: { orgId: string; accountIds: string[] }) {
        return accountIds.map((id) => ({
          id,
          name: id === OWNER.accountId ? "Li" : id,
          avatar: null,
          active: true,
        }));
      },
      async search() {
        return [];
      },
    },
    agents: {
      async usableBy() {
        return [{ id: "agent-pm", name: "PM", avatar: null }];
      },
    },
  } as unknown as EmitterCtx;
  registerEmitQueue(ctx);
  const runJob = (data: EmitJob) => {
    const handler = handlers.get(EMIT_QUEUE);
    if (!handler) throw new Error("no emit queue");
    return handler(data);
  };
  return { ctx, emitted, jobs, state, runJob };
}

function call(callId: string): ToolCallContext {
  return {
    orgId: "unused",
    accountId: OWNER.accountId,
    agentId: "agent-pm",
    conversationId: "conv-1",
    rootConversationId: "conv-1",
    callId,
    signal: new AbortController().signal,
  } as ToolCallContext;
}

describe("collab emitter", () => {
  it("every domain write leaves exactly one outbox row with a stable dedupeKey", async () => {
    const org = "org-emit-1";
    const { ctx, emitted } = fakeCtx();
    const project = await teamProject(db, org, "EM");
    const item = await emitting(ctx, org, () =>
      createItem(db, org, OWNER, { projectId: project.id, type: "task", title: "one" }),
    );
    const updated = await emitting(ctx, org, () =>
      updateItem(db, org, OWNER, item.id, item.version, { title: "renamed" }),
    );
    const { item: moved } = (await emitting(ctx, org, () =>
      transition(db, org, OWNER, item.id, updated.version, "in_progress"),
    )) as { item: { version: number } };
    const note = await emitting(ctx, org, () => comment(db, org, OWNER, item.id, "hi"));

    const rows = await outboxOf(db, org, item.id);
    expect(rows.map((r) => r.dedupe_key)).toEqual([
      `item.created-${item.id}-${item.version}`,
      `item.updated-${item.id}-${updated.version}`,
      `item.status_changed-${item.id}-${moved.version}`,
      `item.commented-${note.id}`,
    ]);
    expect(rows.every((r) => r.emitted_at !== null)).toBe(true);
    expect(emitted.map((e) => e.dedupeKey)).toEqual(rows.map((r) => r.dedupe_key));
    // The event carries the row as written.
    expect(emitted[0]).toMatchObject({
      orgId: org,
      type: "item.created",
      subject: { kind: "item", id: item.id, title: "EM-1 one" },
      facts: { projectKey: "EM", itemType: "task", status: "todo" },
      cause: { accountId: OWNER.accountId },
    });
    expect(emitted[0]?.summary).toBe('EM-1 "one" was created. By Li.');
    // Another write's drain emits nothing again.
    await emitting(ctx, org, async () => null);
    expect(emitted).toHaveLength(4);
  });

  it("tool-originated writes emit with the cause handle of the call", async () => {
    const org = "org-emit-2";
    const { ctx, emitted, jobs } = fakeCtx();
    const project = await teamProject(db, org, "TL");
    const actor = await toolActor(ctx, call("call-7"));
    expect(actor).toEqual({
      accountId: OWNER.accountId,
      agentId: "agent-pm",
      conversationId: "conv-1",
      causeHandle: "handle-call-7",
    });
    const item = await emitting(ctx, org, () =>
      createItem(db, org, actor, {
        projectId: project.id,
        type: "task",
        title: "by agent",
        responsibleAccountId: OWNER.accountId,
        executingAgentId: "agent-pm",
      }),
    );
    expect(emitted.map((e) => e.type).sort()).toEqual(["item.assigned", "item.created"]);
    for (const e of emitted) expect(e.cause).toEqual({ handle: "handle-call-7" });
    expect(emitted.find((e) => e.type === "item.assigned")?.audience).toEqual({
      accountId: OWNER.accountId,
      agentId: "agent-pm",
    });
    expect(emitted[0]?.summary).toMatch(/By PM \(agent of Li\)\.$/);
    // Each row owes a queue job keyed by its id.
    const rows = await outboxOf(db, org, item.id);
    expect(jobs.map((j) => j.opts?.jobId).sort()).toEqual(
      rows.map((r) => `collab-emit-${r.id}`).sort(),
    );
    expect(jobs.every((j) => j.name === EMIT_QUEUE && j.data.orgId === org)).toBe(true);
    // The handle is the outbox row's, never the item's history.
    expect(rows[0]?.cause_handle).toBe("handle-call-7");
    const activity = await db
      .selectFrom("activity")
      .select("actor")
      .where("org_id", "=", org)
      .where("item_id", "=", item.id)
      .execute();
    for (const a of activity) expect(a.actor).not.toHaveProperty("causeHandle");
  });

  it("a failed emit is retried by the queue job with the stored cause", async () => {
    const org = "org-emit-3";
    const { ctx, emitted, jobs, state, runJob } = fakeCtx();
    const project = await teamProject(db, org, "RT");
    const actor = await toolActor(ctx, call("call-9"));
    state.failing = true;
    // The write itself succeeds: the event is owed, not lost.
    const item = await emitting(ctx, org, () =>
      createItem(db, org, actor, {
        projectId: project.id,
        type: "task",
        title: "later",
        responsibleAccountId: OWNER.accountId,
        executingAgentId: "agent-pm",
      }),
    );
    const ui = await emitting(ctx, org, () =>
      createItem(db, org, OWNER, { projectId: project.id, type: "task", title: "by hand" }),
    );
    expect(emitted).toHaveLength(0);
    const [row] = await outboxOf(db, org, item.id);
    expect(row?.emitted_at).toBeNull();
    expect(row?.attempts).toBeGreaterThanOrEqual(1);
    // While the kernel is down the job fails, so the queue retries it.
    const job = jobs.find((j) => j.data.outboxId === row?.id);
    if (!job) throw new Error("no job");
    await expect(runJob(job.data)).rejects.toThrow("kernel unavailable");

    state.failing = false;
    await runJob(job.data);
    const [uiRow] = await outboxOf(db, org, ui.id);
    const uiJob = jobs.find((j) => j.data.outboxId === uiRow?.id);
    if (!uiJob) throw new Error("no job");
    await runJob(uiJob.data);
    expect(emitted).toHaveLength(2);
    expect(emitted[0]).toMatchObject({
      dedupeKey: row?.dedupe_key,
      cause: { handle: "handle-call-9" },
    });
    expect(emitted[1]?.cause).toEqual({ accountId: OWNER.accountId });
    expect((await outboxOf(db, org, item.id))[0]?.emitted_at).not.toBeNull();
  });

  it("emitter retries with the same dedupeKey", async () => {
    const org = "org-emit-4";
    const { ctx, emitted, jobs, runJob } = fakeCtx();
    const project = await teamProject(db, org, "DD");
    const item = await emitting(ctx, org, () =>
      createItem(db, org, OWNER, { projectId: project.id, type: "task", title: "once" }),
    );
    const [row] = await outboxOf(db, org, item.id);
    if (!row) throw new Error("no row");
    // A job for an emitted row does nothing.
    const job = jobs.find((j) => j.data.outboxId === row.id);
    if (!job) throw new Error("no job");
    await runJob(job.data);
    expect(emitted).toHaveLength(1);
    // An emit whose result was lost (emitted_at never set) is sent again with the same key; the
    // kernel answers duplicate and no second event exists.
    await db
      .updateTable("event_outbox")
      .set({ emitted_at: null })
      .where("id", "=", row.id)
      .execute();
    await runJob(job.data);
    expect(emitted).toHaveLength(1);
    expect((await outboxOf(db, org, item.id))[0]?.emitted_at).not.toBeNull();
  });

  it("an expired handle falls back to the account", async () => {
    const org = "org-emit-5";
    const { ctx, emitted, jobs, state, runJob } = fakeCtx();
    const project = await teamProject(db, org, "EX");
    const actor = await toolActor(ctx, call("call-old"));
    state.failing = true;
    const item = await emitting(ctx, org, () =>
      createItem(db, org, actor, {
        projectId: project.id,
        type: "task",
        title: "old",
        responsibleAccountId: OWNER.accountId,
        executingAgentId: "agent-pm",
      }),
    );
    state.failing = false;
    const [row] = await outboxOf(db, org, item.id);
    await db
      .updateTable("event_outbox")
      .set({ created_at: sql<Date>`now() - interval '24 hours'` })
      .where("org_id", "=", org)
      .execute();
    const job = jobs.find((j) => j.data.outboxId === row?.id);
    if (!job) throw new Error("no job");
    await runJob(job.data);
    expect(emitted[0]?.cause).toEqual({ accountId: OWNER.accountId });
  });

  it("a row left without a job is emitted by the org's next write", async () => {
    const org = "org-emit-6";
    const { ctx, emitted } = fakeCtx();
    const project = await teamProject(db, org, "ST");
    // Written outside the emitter, as if the process died right after the commit.
    const stranded = await createItem(db, org, OWNER, {
      projectId: project.id,
      type: "task",
      title: "stranded",
    });
    await emitting(ctx, org, () =>
      createItem(db, org, OWNER, { projectId: project.id, type: "task", title: "next" }),
    );
    expect(emitted.map((e) => e.subject.id)).toContain(stranded.id);
  });
});
