import { TriggerError, type TriggerEvent } from "@capybara-hq/plugin-sdk";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { comment, createItem, link, transition, updateItem } from "../../src/domain/items.js";
import {
  DRAIN_QUEUE,
  type DrainJob,
  type EmitterCtx,
  emitting,
  registerDrainQueue,
} from "../../src/events/emitter.js";
import type { CollabDb } from "../../src/store/db.js";
import type { Actor } from "../../src/store/types.js";
import { domainDb, GUEST, OWNER, outboxOf, teamProject } from "../domain/setup.js";

let db: CollabDb;
let close: () => Promise<void>;
beforeAll(async () => {
  ({ db, close } = await domainDb());
});
afterAll(async () => {
  await close();
});

type Job = { name: string; data: DrainJob; opts?: { delayMs?: number; jobId?: string } };

/**
 * A ctx with the kernel's emit dedupe, a recording queue, a switch for a kernel outage and a rule
 * for refusals (by cause kind: "handle" / "accountId" / "none").
 */
function fakeCtx() {
  const emitted: TriggerEvent[] = [];
  const keys = new Set<string>();
  const jobs: Job[] = [];
  const warnings: string[] = [];
  const handlers = new Map<string, (data: DrainJob) => Promise<void>>();
  const state: {
    queueDown: boolean;
    failing: boolean;
    refuse: (cause: string, e: TriggerEvent) => TriggerError | null;
  } = { queueDown: false, failing: false, refuse: () => null };
  const ctx = {
    db,
    log: {
      info() {},
      warn(msg: string) {
        warnings.push(msg);
      },
      error() {},
    },
    triggers: {
      async emit(e: TriggerEvent) {
        if (state.failing) throw new Error("kernel unavailable");
        const kind = e.cause ? (Object.keys(e.cause)[0] ?? "none") : "none";
        const refusal = state.refuse(kind, e);
        if (refusal) throw refusal;
        const key = `${e.orgId}/${e.type}/${e.dedupeKey}`;
        const duplicate = keys.has(key);
        keys.add(key);
        if (!duplicate) emitted.push(e);
        return { eventId: key, duplicate };
      },
      async causeOf() {
        return "unused";
      },
    },
    queue: {
      define(name: string, handler: (data: DrainJob) => Promise<void>) {
        handlers.set(name, handler);
      },
      async add(name: string, data: DrainJob, opts?: { delayMs?: number; jobId?: string }) {
        if (state.queueDown) throw new Error("queue unavailable");
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
  registerDrainQueue(ctx);
  const runJob = (job: Job | undefined) => {
    const handler = handlers.get(DRAIN_QUEUE);
    if (!handler || !job) throw new Error("no drain job");
    return handler(job.data);
  };
  return { ctx, emitted, jobs, warnings, state, runJob };
}

const agentActor = (handle: string): Actor => ({
  accountId: OWNER.accountId,
  agentId: "agent-pm",
  conversationId: "conv-1",
  causeHandle: handle,
});

const assignedToOwner = { responsibleAccountId: OWNER.accountId, executingAgentId: "agent-pm" };

describe("collab emitter", () => {
  it("every domain write leaves exactly one outbox row with a stable dedupeKey", async () => {
    const org = "org-emit-1";
    const { ctx, emitted, jobs } = fakeCtx();
    const project = await teamProject(db, org, "EM");
    const other = await createItem(db, org, OWNER, {
      projectId: project.id,
      type: "task",
      title: "other",
    });
    await db
      .updateTable("event_outbox")
      .set({ emitted_at: sql`now()` })
      .where("org_id", "=", org)
      .execute();
    const item = await emitting(ctx, org, () =>
      createItem(db, org, OWNER, { projectId: project.id, type: "task", title: "one" }),
    );
    // Intent first: the org's drain job of this minute was queued before the write.
    expect(jobs[0]).toMatchObject({ name: DRAIN_QUEUE, data: { orgId: org, step: 0 } });
    expect(jobs[0]?.opts?.jobId).toMatch(/^collab-drain-org-emit-1-\d+$/);
    expect(jobs[0]?.opts?.delayMs).toBeGreaterThanOrEqual(60_000);
    const updated = await emitting(ctx, org, () =>
      updateItem(db, org, OWNER, item.id, item.version, { title: "renamed" }),
    );
    const { item: moved } = (await emitting(ctx, org, () =>
      transition(db, org, OWNER, item.id, updated.version, "in_progress"),
    )) as { item: { version: number } };
    const note = await emitting(ctx, org, () => comment(db, org, OWNER, item.id, "hi"));
    await emitting(ctx, org, () =>
      link(db, org, OWNER, { fromId: item.id, toId: other.id, kind: "relates" }),
    );

    const rows = await outboxOf(db, org, item.id);
    const linkActivity = await db
      .selectFrom("activity")
      .select("id")
      .where("item_id", "=", item.id)
      .where("kind", "=", "linked")
      .executeTakeFirstOrThrow();
    expect(rows.map((r) => r.dedupe_key)).toEqual([
      `item.created-${item.id}-${item.version}`,
      `item.updated-${item.id}-${updated.version}`,
      `item.status_changed-${item.id}-${moved.version}`,
      `item.commented-${note.id}`,
      `item.updated-link-${linkActivity.id}`,
    ]);
    expect(rows.every((r) => r.emitted_at !== null)).toBe(true);
    expect(emitted.map((e) => e.dedupeKey)).toEqual(rows.map((r) => r.dedupe_key));
    expect(emitted[0]).toMatchObject({
      orgId: org,
      type: "item.created",
      subject: { kind: "item", id: item.id, title: "EM-2 one" },
      facts: { projectKey: "EM", itemType: "task", status: "todo" },
      cause: { accountId: OWNER.accountId },
    });
    expect(emitted[0]?.summary).toBe('EM-2 "one" was created by Li.');
    // A later write emits only its own rows; nothing is emitted twice.
    await emitting(ctx, org, async () => null);
    expect(emitted).toHaveLength(5);
  });

  it("tool-originated writes emit with the cause handle of the call", async () => {
    const org = "org-emit-2";
    const { ctx, emitted } = fakeCtx();
    const project = await teamProject(db, org, "TL");
    const item = await emitting(ctx, org, () =>
      createItem(db, org, agentActor("handle-7"), {
        projectId: project.id,
        type: "task",
        title: "by agent",
        ...assignedToOwner,
      }),
    );
    expect(emitted.map((e) => e.type).sort()).toEqual(["item.assigned", "item.created"]);
    for (const e of emitted) expect(e.cause).toEqual({ handle: "handle-7" });
    const assigned = emitted.find((e) => e.type === "item.assigned");
    expect(assigned?.audience).toEqual({ accountId: OWNER.accountId, agentId: "agent-pm" });
    expect(assigned?.summary).toBe(
      'TL-1 "by agent" was assigned to Li with PM by PM (agent of Li).',
    );
    const rows = await outboxOf(db, org, item.id);
    expect(rows[0]?.cause_handle).toBe("handle-7");
    // The handle is the outbox row's, never the item's history.
    const activity = await db
      .selectFrom("activity")
      .select("actor")
      .where("org_id", "=", org)
      .where("item_id", "=", item.id)
      .execute();
    for (const a of activity) expect(a.actor).not.toHaveProperty("causeHandle");
  });

  it("the drain job ladder recovers after an outage longer than the queue's attempts", async () => {
    const org = "org-emit-3";
    const { ctx, emitted, jobs, state, runJob } = fakeCtx();
    const project = await teamProject(db, org, "RT");
    state.failing = true;
    // The write itself succeeds: the event is owed, not lost.
    const item = await emitting(ctx, org, () =>
      createItem(db, org, agentActor("handle-9"), {
        projectId: project.id,
        type: "task",
        title: "later",
        ...assignedToOwner,
      }),
    );
    expect(emitted).toHaveLength(0);
    // The failed request-path emit queued a retry drain a minute out (its bucket job may be past).
    expect(jobs[1]).toMatchObject({ data: { orgId: org, step: 0 }, opts: { delayMs: 60_000 } });
    expect(jobs[1]?.opts?.jobId).toMatch(/^collab-drain-org-emit-3-\d+-retry$/);
    for (let i = 0; i < 6; i++) await runJob(jobs.at(-1));
    expect(jobs.slice(2).map((j) => j.opts?.delayMs)).toEqual([
      120_000, 240_000, 480_000, 960_000, 1_920_000, 3_600_000,
    ]);
    expect(jobs.slice(2).map((j) => j.data.step)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(new Set(jobs.map((j) => j.opts?.jobId)).size).toBe(jobs.length);
    const [row] = await outboxOf(db, org, item.id);
    expect(row?.attempts).toBeGreaterThanOrEqual(7);
    expect(row?.failed_at).toBeNull();

    state.failing = false;
    const before = jobs.length;
    await runJob(jobs.at(-1));
    expect(emitted).toHaveLength(2);
    for (const e of emitted) expect(e.cause).toEqual({ handle: "handle-9" });
    // Nothing pending: the ladder stops.
    expect(jobs).toHaveLength(before);
  });

  it("a crash after the commit is rescued by the drain job alone; a rollback leaves it nothing", async () => {
    const org = "org-emit-4";
    const { ctx, emitted, jobs, runJob } = fakeCtx();
    const project = await teamProject(db, org, "CR");
    let id = "";
    await expect(
      emitting(ctx, org, async () => {
        id = (await createItem(db, org, OWNER, { projectId: project.id, type: "task", title: "x" }))
          .id;
        throw new Error("process died");
      }),
    ).rejects.toThrow("process died");
    expect(emitted).toHaveLength(0);
    await runJob(jobs[0]);
    expect(emitted.map((e) => e.subject.id)).toEqual([id]);
    expect(jobs).toHaveLength(1);

    const rollbackOrg = "org-emit-4b";
    const rolled = fakeCtx();
    const p2 = await teamProject(db, rollbackOrg, "RB");
    await expect(
      emitting(rolled.ctx, rollbackOrg, () =>
        createItem(db, rollbackOrg, GUEST, { projectId: p2.id, type: "task", title: "no" }),
      ),
    ).rejects.toThrow();
    await rolled.runJob(rolled.jobs[0]);
    expect(rolled.emitted).toHaveLength(0);
    expect(rolled.jobs).toHaveLength(1);
  });

  it("a refused cause degrades to the account, then to none; a permanent refusal fails the row", async () => {
    const org = "org-emit-5";
    const { ctx, emitted, warnings, state, jobs, runJob } = fakeCtx();
    const project = await teamProject(db, org, "IV");
    state.refuse = (cause) =>
      cause === "none" ? null : new TriggerError("invalid_event", `${cause} refused`);
    await emitting(ctx, org, () =>
      createItem(db, org, agentActor("handle-bad"), {
        projectId: project.id,
        type: "task",
        title: "weak",
        ...assignedToOwner,
      }),
    );
    expect(emitted.length).toBe(2);
    for (const e of emitted) expect(e.cause).toBeUndefined();

    state.refuse = () => new TriggerError("invalid_event", "refused");
    const lost = await emitting(ctx, org, () =>
      createItem(db, org, OWNER, { projectId: project.id, type: "task", title: "lost" }),
    );
    const [row] = await outboxOf(db, org, lost.id);
    expect(row?.failed_at).not.toBeNull();
    expect(row?.emitted_at).toBeNull();
    expect(warnings).toContain("collab event given up");

    state.refuse = (_, e) =>
      e.subject.title.endsWith("undeclared") ? new TriggerError("type_not_declared", "no") : null;
    const undeclared = await emitting(ctx, org, () =>
      createItem(db, org, OWNER, { projectId: project.id, type: "task", title: "undeclared" }),
    );
    expect((await outboxOf(db, org, undeclared.id))[0]?.failed_at).not.toBeNull();
    // Failed rows are never retried.
    state.refuse = () => null;
    const count = emitted.length;
    await runJob(jobs.at(-1));
    expect(emitted).toHaveLength(count);
  });

  it("an old handle falls back to the account; a row older than a day is given up", async () => {
    const org = "org-emit-6";
    const { ctx, emitted, jobs, state, runJob } = fakeCtx();
    const project = await teamProject(db, org, "EX");
    state.failing = true;
    const oldItem = await emitting(ctx, org, () =>
      createItem(db, org, agentActor("handle-old"), {
        projectId: project.id,
        type: "task",
        title: "old",
        ...assignedToOwner,
      }),
    );
    const staleItem = await emitting(ctx, org, () =>
      createItem(db, org, OWNER, { projectId: project.id, type: "task", title: "stale" }),
    );
    state.failing = false;
    await db
      .updateTable("event_outbox")
      .set({ created_at: sql<Date>`now() - interval '23 hours 30 minutes'` })
      .where("org_id", "=", org)
      .execute();
    await db
      .updateTable("event_outbox")
      .set({ created_at: sql<Date>`now() - interval '25 hours'` })
      .where("org_id", "=", org)
      .where(sql<boolean>`subject->>'id' = ${staleItem.id}`)
      .execute();
    await runJob(jobs.at(-1));
    expect(emitted.map((e) => e.subject.id)).toEqual([oldItem.id, oldItem.id]);
    for (const e of emitted) expect(e.cause).toEqual({ accountId: OWNER.accountId });
    expect((await outboxOf(db, org, staleItem.id))[0]?.failed_at).not.toBeNull();
  });

  it("emitter retries with the same dedupeKey", async () => {
    const org = "org-emit-7";
    const { ctx, emitted, jobs, runJob } = fakeCtx();
    const project = await teamProject(db, org, "DD");
    const item = await emitting(ctx, org, () =>
      createItem(db, org, OWNER, { projectId: project.id, type: "task", title: "once" }),
    );
    const [row] = await outboxOf(db, org, item.id);
    if (!row) throw new Error("no row");
    // An emit whose result was lost (emitted_at never set) is sent again with the same key; the
    // kernel answers duplicate and no second event exists.
    await db
      .updateTable("event_outbox")
      .set({ emitted_at: null })
      .where("id", "=", row.id)
      .execute();
    await runJob(jobs[0]);
    expect(emitted).toHaveLength(1);
    expect((await outboxOf(db, org, item.id))[0]?.emitted_at).not.toBeNull();
  });

  it("the drain job prunes settled rows past their keep time", async () => {
    const org = "org-emit-8";
    const { jobs, runJob, ctx } = fakeCtx();
    const row = (key: string, settled: Record<string, unknown>) => ({
      org_id: org,
      type: "item.updated",
      subject: JSON.stringify({ kind: "item", id: key, title: key }),
      dedupe_key: key,
      actor: JSON.stringify(OWNER),
      ...settled,
    });
    await db
      .insertInto("event_outbox")
      .values([
        row("emitted-old", { emitted_at: sql`now() - interval '8 days'` }),
        row("emitted-new", { emitted_at: sql`now() - interval '1 day'` }),
        row("failed-old", { failed_at: sql`now() - interval '31 days'` }),
        row("failed-new", { failed_at: sql`now() - interval '2 days'` }),
      ])
      .execute();
    await emitting(ctx, org, async () => null);
    await runJob(jobs[0]);
    const left = await db
      .selectFrom("event_outbox")
      .select("dedupe_key")
      .where("org_id", "=", org)
      .orderBy("dedupe_key")
      .execute();
    expect(left.map((r) => r.dedupe_key)).toEqual(["emitted-new", "failed-new"]);
  });

  it("a drain whose next step cannot be queued throws for the queue's retry", async () => {
    const org = "org-emit-9";
    const { ctx, emitted, jobs, state, runJob } = fakeCtx();
    const project = await teamProject(db, org, "QD");
    state.failing = true;
    await emitting(ctx, org, () =>
      createItem(db, org, OWNER, { projectId: project.id, type: "task", title: "queued" }),
    );
    state.queueDown = true;
    await expect(runJob(jobs[0])).rejects.toThrow("queue unavailable");
    // A failed request-path emit with the queue down still returns the write.
    const item = await emitting({ ...ctx, queue: { ...ctx.queue, add: async () => {} } }, org, () =>
      createItem(db, org, OWNER, { projectId: project.id, type: "task", title: "second" }),
    );
    expect(item.title).toBe("second");
    expect(emitted).toHaveLength(0);
  });

  it("excerpts never split an emoji, so the write and its event go through", async () => {
    const org = "org-emit-10";
    const { ctx, emitted } = fakeCtx();
    const project = await teamProject(db, org, "EJ");
    // The emoji's two UTF-16 units sit at 499 and 500: a plain slice(0, 500) would split it.
    const text = `${"a".repeat(499)}😀${"b".repeat(600)}`;
    const item = await emitting(ctx, org, () =>
      createItem(db, org, OWNER, {
        projectId: project.id,
        type: "task",
        title: "emoji",
        description: text,
      }),
    );
    await emitting(ctx, org, () => comment(db, org, OWNER, item.id, text));
    expect(emitted.map((e) => e.type)).toEqual(["item.created", "item.commented"]);
    for (const e of emitted) expect(e.summary).toContain(`${"a".repeat(499)}😀`);
  });
});
