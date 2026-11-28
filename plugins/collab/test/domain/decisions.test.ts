import type {
  ExtensionContext,
  InboxPost,
  ToolCallContext,
  ToolHandler,
  ToolResult,
  ToolSpec,
  UiActionResult,
} from "@capybara-hq/plugin-sdk";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DECISIONS_QUEUE,
  type DecisionJob,
  decisionHooks,
  INBOX_ANSWER,
  registerDecisionQueue,
  runDecisionJob,
} from "../../src/decisions-queue.js";
import "../../src/decisions/actions.js";
import { type AskDecisionInput, askDecision } from "../../src/domain/decisions.js";
import { createItem, transition } from "../../src/domain/items.js";
import { addMember, removeMember } from "../../src/domain/projects.js";
import type { CollabDb } from "../../src/store/db.js";
import type { Actor, Decision, Item, Project } from "../../src/store/types.js";
import { registerTools } from "../../src/tools/index.js";
import { dispatchAction } from "../../src/ui/actions.js";
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

const ORG = "org-decisions";
const DEC_ASK = "decision_ask";
const DEC_TRANSITION = "item_transition";

interface Posted extends InboxPost {
  itemId: string;
  resolved: boolean;
}

/** A stand-in ctx: real database; queue, inbox, people, agents and triggers recorded in memory. */
function fakeCtx(db: CollabDb) {
  const jobs: { name: string; data: unknown; opts?: { delayMs?: number; jobId?: string } }[] = [];
  const handlers = new Map<string, (data: unknown) => Promise<void>>();
  const inbox: Posted[] = [];
  const tools = new Map<string, { spec: ToolSpec; handler: ToolHandler }>();
  let n = 0;
  const refuse: { code?: string } = {};
  const ctx = {
    db,
    log: { info() {}, warn() {}, error() {} },
    queue: {
      define: (name: string, handler: (data: unknown) => Promise<void>) => {
        handlers.set(name, handler);
      },
      add: async (name: string, data: unknown, opts?: { delayMs?: number; jobId?: string }) => {
        jobs.push({ name, data, ...(opts ? { opts } : {}) });
      },
    },
    inbox: {
      post: async (p: InboxPost) => {
        if (refuse.code) throw Object.assign(new Error("refused"), { code: refuse.code });
        const open = inbox.find(
          (i) => !i.resolved && i.accountId === p.accountId && i.dedupeKey === p.dedupeKey,
        );
        if (open) return { itemId: open.itemId };
        n += 1;
        const itemId = `inbox-${n}`;
        inbox.push({ ...p, itemId, resolved: false });
        return { itemId };
      },
      resolve: async ({ itemId }: { orgId: string; itemId: string }) => {
        const it = inbox.find((i) => i.itemId === itemId);
        if (it) it.resolved = true;
      },
    },
    people: {
      get: async ({ accountIds }: { accountIds: string[] }) =>
        accountIds.map((id) => ({ id, name: `Name of ${id}`, avatar: null, active: true })),
      search: async () => [],
    },
    agents: {
      usableBy: async ({ accountId }: { accountId: string }) =>
        accountId === ENGINEER.accountId
          ? [{ id: "agent-eng", name: "Engineer", avatar: null }]
          : [{ id: "agent-pm", name: "PM", avatar: null }],
    },
    conversations: { bySubject: async () => [] },
    triggers: {
      emit: async () => ({ eventId: "e", duplicate: false }),
      causeOf: async () => "handle",
    },
    tools: {
      register: (spec: ToolSpec, handler: ToolHandler) => tools.set(spec.name, { spec, handler }),
    },
  } as unknown as ExtensionContext;
  registerDecisionQueue(ctx);
  registerTools(ctx);
  return {
    ctx,
    refuse,
    jobs,
    /** The decision hooks of one write, as the tools and actions build them. */
    follow: () => decisionHooks(ctx, ORG),
    inbox,
    tools,
    /** Runs a queued job's handler, like the queue would (at least once). */
    run: (data: DecisionJob) => {
      const h = handlers.get(DECISIONS_QUEUE);
      if (!h) throw new Error("queue not defined");
      return h(data);
    },
    tool: async (name: string, input: unknown, call: Partial<ToolCallContext> = {}) => {
      const t = tools.get(name);
      if (!t) throw new Error(`no tool ${name}`);
      return (await t.handler(input, {
        orgId: ORG,
        accountId: OWNER.accountId,
        ownerAccountId: OWNER.accountId,
        agentId: OWNER_AGENT.agentId,
        callId: "call-1",
        conversationId: OWNER_AGENT.conversationId,
        rootConversationId: OWNER_AGENT.conversationId,
        signal: new AbortController().signal,
        ...call,
      } as ToolCallContext)) as ToolResult;
    },
    /** A person clicks an inbox button. */
    click: (accountId: string, payload: unknown): Promise<UiActionResult> =>
      dispatchAction({ ctx, db }, {
        scope: "org",
        orgId: ORG,
        accountId,
        role: "member",
        actionId: INBOX_ANSWER,
        payload,
      } as never),
  };
}

function textOf(r: ToolResult): string {
  return r.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
}

async function decisionOf(db: CollabDb, id: string): Promise<Decision> {
  return db
    .selectFrom("decisions")
    .selectAll()
    .where("org_id", "=", ORG)
    .where("id", "=", id)
    .executeTakeFirstOrThrow();
}

function decisionIdIn(text: string): string {
  const m = /decision ([0-9a-f-]{36})/.exec(text);
  if (!m?.[1]) throw new Error(`no decision id in: ${text}`);
  return m[1];
}

describe("decisions and gates", () => {
  let db: CollabDb;
  let close: () => Promise<void>;
  let project: Project;
  let seq = 0;

  beforeAll(async () => {
    ({ db, close } = await domainDb());
    project = await teamProject(db, ORG, "DEC");
  });
  afterAll(async () => close());

  /** A task held by the owner and their PM agent (the asking pair). */
  async function ownersTask(): Promise<Item> {
    seq += 1;
    return createItem(db, ORG, OWNER, {
      projectId: project.id,
      type: "task",
      title: `Task ${seq}`,
      responsibleAccountId: OWNER.accountId,
      executingAgentId: OWNER_AGENT.agentId,
    });
  }

  const keyOf = (item: Item) => `DEC-${item.number}`;
  /** Asks directly in the domain (no inbox jobs: these tests click the answer themselves). */
  const ask = (actor: Actor, input: AskDecisionInput) =>
    askDecision(db, ORG, actor, input, { decisions: NO_DECISION_JOBS });

  it("answer emits decision.answered directed to the asking agent", async () => {
    const f = fakeCtx(db);
    const item = await ownersTask();
    const out = await f.tool(DEC_ASK, {
      key: keyOf(item),
      question: "Which export format first?",
      options: [
        { id: "pdf", label: "PDF" },
        { id: "csv", label: "CSV" },
      ],
      recommendation: { optionId: "pdf", why: "Customers asked for it." },
      blocking: true,
    });
    const text = textOf(out);
    expect(text).toContain(
      "Asked Name of acct-owner. Stop work that depends on this answer; the answer will arrive in this conversation.",
    );
    const id = decisionIdIn(text);
    // Intent first: the notify job is queued (deterministic id), and the item is posted at once.
    expect(f.jobs.map((j) => j.opts?.jobId)).toContain(`collab-decision-notify-${id}`);
    const [posted] = f.inbox;
    expect(posted).toMatchObject({
      accountId: OWNER.accountId,
      kind: "collab.decision",
      dedupeKey: id,
      link: `/p/collab/projects?item=${keyOf(item)}`,
    });
    expect(posted?.actions?.map((a) => a.id)).toEqual(["pdf", "csv"]);
    expect((await decisionOf(db, id)).inbox_item_ids).toEqual([posted?.itemId]);
    // The notify job finds the item already posted: nothing more.
    await f.run({ orgId: ORG, decisionId: id, step: "notify" });
    expect(f.inbox).toHaveLength(1);

    const answer = posted?.actions?.[1]?.uiAction.payload;
    expect(await f.click(OWNER.accountId, answer)).toEqual({
      toast: { zh: "已答复。", en: "Answered." },
    });
    const rows = (await outboxOf(db, ORG, item.id)).filter((r) => r.type === "decision.answered");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.audience).toEqual({
      accountId: OWNER.accountId,
      agentId: OWNER_AGENT.agentId,
    });
    expect(rows[0]?.dedupe_key).toBe(`decision.answered-${item.id}-${id}`);
    expect(JSON.stringify(rows[0]?.detail)).toContain('Answer: \\"CSV\\" (csv)');
    expect(f.inbox.every((i) => i.resolved)).toBe(true);
    expect((await decisionOf(db, id)).state).toBe("answered");
  });

  it("a non-blocking ask tells the agent to proceed", async () => {
    const f = fakeCtx(db);
    const item = await ownersTask();
    const out = await f.tool(DEC_ASK, {
      key: keyOf(item),
      question: "Name the file?",
      blocking: false,
      addressee: ENGINEER.accountId,
    });
    expect(textOf(out)).toContain(
      "Asked Name of acct-eng. Proceed with the recommended option; the answer will arrive in this conversation.",
    );
    // A free-text question has no buttons: the person answers on the item's page.
    expect(f.inbox[0]?.actions).toBeUndefined();
  });

  it("only a person can answer", async () => {
    const f = fakeCtx(db);
    // The tool path has no answer tool.
    expect([...f.tools.keys()].filter((n) => n.includes("answer"))).toEqual([]);
    expect([...f.tools.keys()]).toContain(DEC_ASK);

    const item = await ownersTask();
    const decision = await ask(OWNER_AGENT, {
      itemId: item.id,
      question: "Ship on Friday?",
      options: [
        { id: "yes", label: "Yes" },
        { id: "no", label: "No" },
      ],
      blocking: true,
    });
    const payload = { decisionId: decision.id, optionId: "yes" };
    // Another member is not the addressee.
    const refused = await f.click(ENGINEER.accountId, payload);
    expect(refused).toMatchObject({ toast: { zh: "只有被询问的人可以答复这个决策。" } });
    expect((await decisionOf(db, decision.id)).state).toBe("open");
    // The addressee (a person, through the UI action) answers; a second click changes nothing.
    expect(await f.click(OWNER.accountId, payload)).toMatchObject({ toast: { en: "Answered." } });
    expect(await f.click(OWNER.accountId, { ...payload, optionId: "no" })).toMatchObject({
      toast: { en: "This decision was already answered." },
    });
    const after = await decisionOf(db, decision.id);
    expect(after.answer).toMatchObject({ optionId: "yes", accountId: OWNER.accountId });
    const rows = (await outboxOf(db, ORG, item.id)).filter((r) => r.type === "decision.answered");
    expect(rows).toHaveLength(1);
  });

  it("a person's own question is answered as an item update (no asking agent)", async () => {
    const f = fakeCtx(db);
    const item = await ownersTask();
    const decision = await ask(ENGINEER, {
      itemId: item.id,
      question: "OK?",
      options: [{ id: "ok", label: "OK" }],
      blocking: false,
    });
    await f.click(OWNER.accountId, { decisionId: decision.id, optionId: "ok" });
    const rows = await outboxOf(db, ORG, item.id);
    expect(rows.filter((r) => r.type === "decision.answered")).toHaveLength(0);
    expect(rows.find((r) => r.dedupe_key === `item.updated-decision-${decision.id}`)).toBeDefined();
  });

  /** A requirement in review held by the owner and the PM agent. */
  async function requirementInReview(): Promise<Item> {
    seq += 1;
    let item = await createItem(db, ORG, OWNER, {
      projectId: project.id,
      type: "requirement",
      title: `Requirement ${seq}`,
      responsibleAccountId: OWNER.accountId,
      executingAgentId: OWNER_AGENT.agentId,
    });
    for (const to of ["drafting", "review"]) {
      const out = await transition(db, ORG, OWNER, item.id, item.version, to);
      if (!("item" in out)) throw new Error("expected a move");
      item = out.item;
    }
    return item;
  }

  it("approving a gate moves the item, rejecting keeps it", async () => {
    const f = fakeCtx(db);
    for (const choice of ["approve", "reject"] as const) {
      const item = await requirementInReview();
      const out = await f.tool(DEC_TRANSITION, {
        key: keyOf(item),
        to: "ready",
        version: item.version,
      });
      const id = decisionIdIn(textOf(out));
      // The gate's notify job was queued inside the write; the owner (confirmer) got the item.
      expect(f.jobs.map((j) => j.opts?.jobId)).toContain(`collab-decision-notify-${id}`);
      const posted = f.inbox.find((i) => i.dedupeKey === id);
      expect(posted).toMatchObject({ accountId: OWNER.accountId, kind: "collab.decision" });
      expect(posted?.actions?.map((a) => a.id)).toEqual(["approve", "reject"]);
      expect(posted?.actions?.map((a) => a.label)).toEqual([
        { zh: "批准", en: "Approve" },
        { zh: "驳回", en: "Reject" },
      ]);
      // Only the confirmer may answer.
      const payload = { decisionId: id, optionId: choice };
      expect(await f.click(ENGINEER.accountId, payload)).toMatchObject({
        toast: {
          zh: "只有确认人可以处理这个确认请求。",
          en: "Only its confirmer can answer this request.",
        },
      });
      expect(await f.click(OWNER.accountId, payload)).toMatchObject({
        toast: { en: "Answered." },
      });
      const now = await db
        .selectFrom("items")
        .selectAll()
        .where("id", "=", item.id)
        .executeTakeFirstOrThrow();
      const rows = await outboxOf(db, ORG, item.id);
      if (choice === "approve") {
        expect(now.status_key).toBe("ready");
        // Entering ready handed the item to engineering: the asking pair is gone, so the answer
        // is an item update and the old pair gets item.unassigned.
        expect(now.responsible_account_id).toBe(ENGINEER.accountId);
        expect(rows.some((r) => r.type === "item.unassigned")).toBe(true);
        expect(rows.some((r) => r.dedupe_key === `item.updated-decision-${id}`)).toBe(true);
      } else {
        expect(now.status_key).toBe("review");
        expect(now.version).toBe(item.version + 1); // only the gate request bumped it
        const answered = rows.filter((r) => r.type === "decision.answered");
        expect(answered).toHaveLength(1);
        expect(answered[0]?.audience).toEqual({
          accountId: OWNER.accountId,
          agentId: OWNER_AGENT.agentId,
        });
      }
      expect(posted?.resolved).toBe(true);
      // A repeated click is a no-op.
      expect(await f.click(OWNER.accountId, payload)).toMatchObject({
        toast: { en: "This decision was already answered." },
      });
    }
  });

  it("deadline reminds then escalates once", async () => {
    const f = fakeCtx(db);
    const item = await ownersTask();
    const out = await f.tool(DEC_ASK, {
      key: keyOf(item),
      question: "Approve the budget?",
      options: [
        { id: "yes", label: "Yes" },
        { id: "no", label: "No" },
      ],
      blocking: true,
      addressee: ENGINEER.accountId,
      deadlineHours: 2,
    });
    const id = decisionIdIn(textOf(out));
    const byId = new Map(f.jobs.map((j) => [j.opts?.jobId, j]));
    expect(byId.get(`collab-decision-remind-${id}`)?.opts?.delayMs).toBe(2 * 3600 * 1000);
    expect(byId.get(`collab-decision-escalate-${id}`)?.opts?.delayMs).toBe(26 * 3600 * 1000);
    expect([...byId.keys()].every((k) => !k?.includes(":"))).toBe(true);

    // At least once: each step runs twice and posts once.
    await f.run({ orgId: ORG, decisionId: id, step: "remind" });
    await f.run({ orgId: ORG, decisionId: id, step: "remind" });
    await f.run({ orgId: ORG, decisionId: id, step: "escalate" });
    await f.run({ orgId: ORG, decisionId: id, step: "escalate" });
    const kinds = f.inbox.map((i) => `${i.kind}:${i.accountId}`);
    expect(kinds).toEqual([
      `collab.decision:${ENGINEER.accountId}`,
      `collab.decision.reminder:${ENGINEER.accountId}`,
      `collab.decision.escalated:${OWNER.accountId}`,
    ]);
    expect(f.inbox[2]?.body).toContain("Name of acct-eng has not answered");
    expect(f.inbox[2]?.actions).toBeUndefined();
    const d = await decisionOf(db, id);
    expect(d.reminded_at).not.toBeNull();
    expect(d.escalated_at).not.toBeNull();
    expect(d.inbox_item_ids).toHaveLength(3);

    // The reminder's button answers too; every item of the decision is resolved.
    const payload = f.inbox[1]?.actions?.[0]?.uiAction.payload;
    expect(await f.click(ENGINEER.accountId, payload)).toMatchObject({
      toast: { en: "Answered." },
    });
    expect(f.inbox.every((i) => i.resolved)).toBe(true);
  });

  it("deadline jobs skip an answered decision and one that was never written", async () => {
    const f = fakeCtx(db);
    const item = await ownersTask();
    const decision = await ask(OWNER_AGENT, {
      itemId: item.id,
      question: "Now?",
      options: [{ id: "y", label: "Y" }],
      blocking: false,
      deadlineHours: 1,
    });
    await f.click(OWNER.accountId, { decisionId: decision.id, optionId: "y" });
    await runDecisionJob(f.ctx, { orgId: ORG, decisionId: decision.id, step: "remind" });
    await runDecisionJob(f.ctx, { orgId: ORG, decisionId: decision.id, step: "escalate" });
    // A rolled-back ask leaves its jobs nothing to do.
    await f.run({
      orgId: ORG,
      decisionId: "00000000-0000-4000-8000-000000000000",
      step: "notify",
    });
    expect(f.inbox).toHaveLength(0);
  });

  it("a gate the item moved past is canceled at answer time, nothing moves", async () => {
    const f = fakeCtx(db);
    const item = await requirementInReview();
    const out = await f.tool(DEC_TRANSITION, {
      key: keyOf(item),
      to: "ready",
      version: item.version,
    });
    const id = decisionIdIn(textOf(out));
    // A move that bypassed the domain (the domain itself cancels on every move).
    await db
      .updateTable("items")
      .set({ status_key: "drafting" })
      .where("id", "=", item.id)
      .execute();
    expect(await f.click(OWNER.accountId, { decisionId: id, optionId: "approve" })).toEqual({
      toast: { zh: "事项已进入其他状态。", en: "The item moved on." },
    });
    expect((await decisionOf(db, id)).state).toBe("canceled");
    const now = await db
      .selectFrom("items")
      .selectAll()
      .where("id", "=", item.id)
      .executeTakeFirstOrThrow();
    expect(now.status_key).toBe("drafting");
    expect(f.inbox.find((i) => i.dedupeKey === id)?.resolved).toBe(true);
  });

  it("a direct move by the confirmer cancels the open gate", async () => {
    const f = fakeCtx(db);
    const item = await requirementInReview();
    const out = await f.tool(DEC_TRANSITION, {
      key: keyOf(item),
      to: "ready",
      version: item.version,
    });
    const id = decisionIdIn(textOf(out));
    const fresh = await db
      .selectFrom("items")
      .selectAll()
      .where("id", "=", item.id)
      .executeTakeFirstOrThrow();
    const follow = f.follow();
    await transition(db, ORG, OWNER, item.id, fresh.version, "ready", { decisions: follow.hooks });
    // A repeatable job: its id carries the minute bucket, and it runs after that minute's writes.
    const resolveJob = f.jobs.find((j) =>
      j.opts?.jobId?.startsWith(`collab-decision-resolve-${id}-b`),
    );
    expect(resolveJob?.opts?.delayMs).toBeGreaterThanOrEqual(60_000);
    await follow.flush();
    expect((await decisionOf(db, id)).state).toBe("canceled");
    expect(f.inbox.find((i) => i.dedupeKey === id)?.resolved).toBe(true);
    // A move without hooks that would cancel a gate refuses (a programming error).
    const other = await requirementInReview();
    await f.tool(DEC_TRANSITION, { key: keyOf(other), to: "ready", version: other.version });
    const v = (
      await db
        .selectFrom("items")
        .select("version")
        .where("id", "=", other.id)
        .executeTakeFirstOrThrow()
    ).version;
    await expect(transition(db, ORG, OWNER, other.id, v, "drafting")).rejects.toThrow(
      /decision hooks/,
    );
  });

  for (const how of ["removed", "demoted"] as const) {
    it(`a ${how} addressee's question goes to the project owner, who answers`, async () => {
      const f = fakeCtx(db);
      const team = await teamProject(db, ORG, how === "removed" ? "DRM" : "DDM");
      const item = await createItem(db, ORG, OWNER, {
        projectId: team.id,
        type: "task",
        title: "Readdress",
        responsibleAccountId: OWNER.accountId,
        executingAgentId: OWNER_AGENT.agentId,
      });
      const out = await f.tool(DEC_ASK, {
        key: `${team.key}-${item.number}`,
        question: "Which database?",
        options: [{ id: "pg", label: "PostgreSQL" }],
        blocking: true,
        addressee: ENGINEER.accountId,
      });
      const id = decisionIdIn(textOf(out));
      const first = f.inbox.find((i) => i.dedupeKey === id);
      expect(first?.accountId).toBe(ENGINEER.accountId);
      // The engineer may not answer for the owner, and the owner not for the engineer yet.
      expect(await f.click(OWNER.accountId, { decisionId: id, optionId: "pg" })).toMatchObject({
        toast: { en: "Only the person asked can answer this decision." },
      });
      const follow = f.follow();
      if (how === "removed") {
        await removeMember(db, ORG, OWNER, team.id, ENGINEER.accountId, follow.hooks);
      } else {
        await addMember(
          db,
          ORG,
          OWNER,
          team.id,
          ENGINEER.accountId,
          { role: "guest" },
          follow.hooks,
        );
      }
      expect(
        f.jobs.some((j) => j.opts?.jobId?.startsWith(`collab-decision-notify-${id}-1-b`)),
      ).toBe(true);
      await follow.flush();
      const d = await decisionOf(db, id);
      expect(d.addressee_account_id).toBe(OWNER.accountId);
      expect(d.address_gen).toBe(1);
      expect(first?.resolved).toBe(true);
      const second = f.inbox.find((i) => i.dedupeKey === `${id}-1`);
      expect(second).toMatchObject({ accountId: OWNER.accountId, resolved: false });
      expect(await f.click(OWNER.accountId, second?.actions?.[0]?.uiAction.payload)).toMatchObject({
        toast: { en: "Answered." },
      });
    });
  }

  it("a reminder goes to the addressee computed at that moment", async () => {
    const f = fakeCtx(db);
    const team = await teamProject(db, ORG, "DRR");
    const item = await createItem(db, ORG, OWNER, {
      projectId: team.id,
      type: "task",
      title: "Remind fresh",
    });
    const decision = await ask(OWNER, {
      itemId: item.id,
      question: "Go?",
      options: [{ id: "go", label: "Go" }],
      blocking: false,
      addressee: QA.accountId,
      deadlineHours: 1,
    });
    // Demoted behind the domain's back (no hooks ran): the reminder notices.
    await db
      .updateTable("project_members")
      .set({ role: "guest" })
      .where("project_id", "=", team.id)
      .where("account_id", "=", QA.accountId)
      .execute();
    await f.run({ orgId: ORG, decisionId: decision.id, step: "remind" });
    expect(f.inbox.map((i) => `${i.kind}:${i.accountId}`)).toEqual([
      `collab.decision.reminder:${OWNER.accountId}`,
    ]);
    expect((await decisionOf(db, decision.id)).addressee_account_id).toBe(OWNER.accountId);
  });

  it("an option id the inbox would refuse is refused at ask", async () => {
    const f = fakeCtx(db);
    const item = await ownersTask();
    for (const id of ["-x", "_a", "a.b", "x".repeat(33)]) {
      await expect(
        f.tool(DEC_ASK, {
          key: keyOf(item),
          question: `Bad id ${id}?`,
          options: [{ id, label: "Bad" }],
          blocking: false,
        }),
      ).rejects.toThrow(/starts with a letter or digit/);
    }
    expect(f.inbox).toHaveLength(0);
  });

  it("an asker has at most 5 open questions per item; the same question is not asked twice", async () => {
    const f = fakeCtx(db);
    const item = await ownersTask();
    const ids: string[] = [];
    for (let i = 1; i <= 5; i++) {
      const out = await f.tool(DEC_ASK, { key: keyOf(item), question: `Q${i}?`, blocking: false });
      ids.push(decisionIdIn(textOf(out)));
    }
    const again = await f.tool(DEC_ASK, { key: keyOf(item), question: "Q2?", blocking: false });
    expect(textOf(again)).toContain(`You already asked`);
    expect(decisionIdIn(textOf(again))).toBe(ids[1]);
    await expect(
      f.tool(DEC_ASK, { key: keyOf(item), question: "Q6?", blocking: false }),
    ).rejects.toThrow(/5 open questions/);
    // Another asker (the person themselves) is counted apart.
    await ask(OWNER, { itemId: item.id, question: "Mine?", options: [], blocking: false });
  });

  it("a decision open for 30 days expires once", async () => {
    const f = fakeCtx(db);
    const item = await ownersTask();
    const out = await f.tool(DEC_ASK, {
      key: keyOf(item),
      question: "Still needed?",
      options: [{ id: "yes", label: "Yes" }],
      blocking: false,
    });
    const id = decisionIdIn(textOf(out));
    const job = f.jobs.find((j) => j.opts?.jobId === `collab-decision-expire-${id}`);
    expect(job?.opts?.delayMs).toBe(30 * 24 * 3600 * 1000);
    // Too early: nothing happens.
    await f.run({ orgId: ORG, decisionId: id, step: "expire" });
    expect((await decisionOf(db, id)).state).toBe("open");
    await db
      .updateTable("decisions")
      .set({ created_at: sql<Date>`now() - interval '31 days'` })
      .where("id", "=", id)
      .execute();
    await f.run({ orgId: ORG, decisionId: id, step: "expire" });
    await f.run({ orgId: ORG, decisionId: id, step: "expire" });
    expect((await decisionOf(db, id)).state).toBe("expired");
    const activity = await db
      .selectFrom("activity")
      .select("kind")
      .where("item_id", "=", item.id)
      .where("kind", "=", "decision_expired")
      .execute();
    expect(activity).toHaveLength(1);
    const rows = await outboxOf(db, ORG, item.id);
    expect(rows.filter((r) => r.dedupe_key === `item.updated-decision-${id}`)).toHaveLength(1);
    expect(f.inbox.every((i) => i.resolved)).toBe(true);
    expect(await f.click(OWNER.accountId, { decisionId: id, optionId: "yes" })).toMatchObject({
      toast: { en: "This decision expired." },
    });
  });

  it("closing an item cancels its open questions and tells the asking pair", async () => {
    const f = fakeCtx(db);
    const item = await ownersTask();
    const out = await f.tool(DEC_ASK, {
      key: keyOf(item),
      question: "Keep the legacy endpoint?",
      options: [
        { id: "yes", label: "Yes" },
        { id: "no", label: "No" },
      ],
      blocking: true,
    });
    const id = decisionIdIn(textOf(out));
    expect(f.inbox.find((i) => i.dedupeKey === id)?.resolved).toBe(false);
    const follow = f.follow();
    await transition(db, ORG, OWNER, item.id, item.version, "canceled", {
      decisions: follow.hooks,
    });
    await follow.flush();
    expect((await decisionOf(db, id)).state).toBe("canceled");
    expect(f.inbox.find((i) => i.dedupeKey === id)?.resolved).toBe(true);
    const activity = await db
      .selectFrom("activity")
      .select(["kind", "detail"])
      .where("item_id", "=", item.id)
      .where("kind", "=", "decision_canceled")
      .execute();
    expect(activity).toHaveLength(1);
    expect(activity[0]?.detail).toMatchObject({ decisionId: id, reason: "closed" });
    const rows = (await outboxOf(db, ORG, item.id)).filter(
      (r) => r.dedupe_key === `item.updated-decision-${id}`,
    );
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows[0]?.detail)).toContain(`was canceled: ${keyOf(item)} was closed.`);
    expect(await f.click(OWNER.accountId, { decisionId: id, optionId: "yes" })).toMatchObject({
      toast: { en: "The item moved on." },
    });
  });

  it("closing the last child asks the requester to accept the parent", async () => {
    const f = fakeCtx(db);
    seq += 1;
    // The engineer asked for the requirement: they accept it.
    let parent = await createItem(db, ORG, ENGINEER, {
      projectId: project.id,
      type: "requirement",
      title: `Parent ${seq}`,
    });
    const follow = f.follow();
    for (const to of ["drafting", "review", "ready", "in_progress"]) {
      const out = await transition(db, ORG, OWNER, parent.id, parent.version, to, {
        decisions: follow.hooks,
      });
      if (!("item" in out)) throw new Error("expected a move");
      parent = out.item;
    }
    let child = await createItem(db, ORG, OWNER, {
      projectId: project.id,
      type: "task",
      title: `Child ${seq}`,
      parentId: parent.id,
    });
    for (const to of ["in_progress", "testing", "done"]) {
      const out = await transition(db, ORG, OWNER, child.id, child.version, to, {
        decisions: follow.hooks,
      });
      if (!("item" in out)) throw new Error("expected a move");
      child = out.item;
    }
    await follow.flush();
    const now = await db
      .selectFrom("items")
      .selectAll()
      .where("id", "=", parent.id)
      .executeTakeFirstOrThrow();
    expect(now.status_key).toBe("acceptance");
    const gate = await db
      .selectFrom("decisions")
      .selectAll()
      .where("item_id", "=", parent.id)
      .where("state", "=", "open")
      .executeTakeFirstOrThrow();
    expect(gate).toMatchObject({
      kind: "gate",
      gate_from: "acceptance",
      gate_target: "done",
      addressee_account_id: ENGINEER.accountId,
    });
    const posted = f.inbox.find((i) => i.dedupeKey === gate.id);
    expect(posted?.accountId).toBe(ENGINEER.accountId);
    expect(
      await f.click(ENGINEER.accountId, { decisionId: gate.id, optionId: "approve" }),
    ).toMatchObject({
      toast: { en: "Answered." },
    });
    const done = await db
      .selectFrom("items")
      .selectAll()
      .where("id", "=", parent.id)
      .executeTakeFirstOrThrow();
    expect(done.status_key).toBe("done");
  });

  it("a permanent inbox refusal marks the step done instead of retrying", async () => {
    const f = fakeCtx(db);
    const item = await ownersTask();
    const decision = await ask(OWNER_AGENT, {
      itemId: item.id,
      question: "Refused?",
      options: [],
      blocking: false,
    });
    f.refuse.code = "org_disabled";
    await f.run({ orgId: ORG, decisionId: decision.id, step: "notify", gen: 0 });
    expect((await decisionOf(db, decision.id)).notified_at).not.toBeNull();
    f.refuse.code = "unavailable";
    const other = await ask(OWNER_AGENT, {
      itemId: item.id,
      question: "Transient?",
      options: [],
      blocking: false,
    });
    await expect(
      f.run({ orgId: ORG, decisionId: other.id, step: "notify", gen: 0 }),
    ).rejects.toThrow();
    expect((await decisionOf(db, other.id)).notified_at).toBeNull();
  });

  /** A team project whose task workflow gates in_progress on the responsible person. */
  async function responsibleGated(key: string) {
    const team = await teamProject(db, ORG, key);
    const wf = await db
      .selectFrom("workflows")
      .select("id")
      .where("project_id", "=", team.id)
      .where("item_type", "=", "task")
      .executeTakeFirstOrThrow();
    await db
      .updateTable("statuses")
      .set({ gate: JSON.stringify({ confirmer: "responsible" }) })
      .where("workflow_id", "=", wf.id)
      .where("key", "=", "in_progress")
      .execute();
    const item = await createItem(db, ORG, OWNER, {
      projectId: team.id,
      type: "task",
      title: "Gated on the responsible person",
      responsibleAccountId: ENGINEER.accountId,
      executingAgentId: "agent-eng",
    });
    const out = await transition(
      db,
      ORG,
      { ...ENGINEER, agentId: "agent-eng", conversationId: "c-eng" },
      item.id,
      item.version,
      "in_progress",
      { decisions: NO_DECISION_JOBS },
    );
    if (!("gate" in out)) throw new Error("expected a gate");
    expect(out.gate.addressee_account_id).toBe(ENGINEER.accountId);
    return { team, item, gate: out.gate };
  }

  it("a responsible gate falls back to the owner when the responsible person is a guest", async () => {
    const f = fakeCtx(db);
    const { team, item, gate } = await responsibleGated("DRG");
    // Demoted behind the domain's back: the confirmer is computed as the owner.
    await db
      .updateTable("project_members")
      .set({ role: "guest" })
      .where("project_id", "=", team.id)
      .where("account_id", "=", ENGINEER.accountId)
      .execute();
    expect(
      await f.click(OWNER.accountId, { decisionId: gate.id, optionId: "approve" }),
    ).toMatchObject({
      toast: { en: "Answered." },
    });
    const now = await db
      .selectFrom("items")
      .selectAll()
      .where("id", "=", item.id)
      .executeTakeFirstOrThrow();
    expect(now.status_key).toBe("in_progress");
  });

  it("demoting a member to guest hands their items to the owner and re-addresses their gates", async () => {
    const f = fakeCtx(db);
    const { team, item, gate } = await responsibleGated("DRH");
    const follow = f.follow();
    await addMember(db, ORG, OWNER, team.id, ENGINEER.accountId, { role: "guest" }, follow.hooks);
    await follow.flush();
    const now = await db
      .selectFrom("items")
      .selectAll()
      .where("id", "=", item.id)
      .executeTakeFirstOrThrow();
    expect(now.responsible_account_id).toBe(OWNER.accountId);
    expect(now.executing_agent_id).toBeNull();
    const rows = await outboxOf(db, ORG, item.id);
    expect(rows.some((r) => r.type === "item.unassigned")).toBe(true);
    const activity = await db
      .selectFrom("activity")
      .select("kind")
      .where("item_id", "=", item.id)
      .where("kind", "=", "assigned")
      .execute();
    expect(activity.length).toBeGreaterThan(0);
    expect((await decisionOf(db, gate.id)).addressee_account_id).toBe(OWNER.accountId);
    expect(f.inbox.find((i) => i.accountId === OWNER.accountId)?.actions?.map((a) => a.id)).toEqual(
      ["approve", "reject"],
    );
    expect(
      await f.click(OWNER.accountId, { decisionId: gate.id, optionId: "approve" }),
    ).toMatchObject({
      toast: { en: "Answered." },
    });
  });

  it("the resolve step retries a transient inbox failure and drops a permanent one", async () => {
    const f = fakeCtx(db);
    const item = await ownersTask();
    const decision = await ask(OWNER_AGENT, {
      itemId: item.id,
      question: "Resolve?",
      options: [{ id: "y", label: "Y" }],
      blocking: false,
    });
    await f.run({ orgId: ORG, decisionId: decision.id, step: "notify", gen: 0 });
    await db
      .updateTable("decisions")
      .set({ state: "canceled" })
      .where("id", "=", decision.id)
      .execute();
    const resolve = f.ctx.inbox.resolve;
    f.ctx.inbox.resolve = async () => {
      throw Object.assign(new Error("down"), { code: "unavailable" });
    };
    await expect(f.run({ orgId: ORG, decisionId: decision.id, step: "resolve" })).rejects.toThrow(
      "down",
    );
    f.ctx.inbox.resolve = async () => {
      throw Object.assign(new Error("gone"), { code: "not_found" });
    };
    await f.run({ orgId: ORG, decisionId: decision.id, step: "resolve" });
    f.ctx.inbox.resolve = resolve;
  });
});
