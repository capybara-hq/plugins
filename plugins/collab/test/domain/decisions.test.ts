import type {
  ExtensionContext,
  InboxPost,
  ToolCallContext,
  ToolHandler,
  ToolResult,
  ToolSpec,
  UiActionResult,
} from "@capybara-hq/plugin-sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DECISIONS_QUEUE,
  type DecisionJob,
  INBOX_ANSWER,
  registerDecisionQueue,
  runDecisionJob,
} from "../../src/decisions-queue.js";
import "../../src/decisions/actions.js";
import { askDecision } from "../../src/domain/decisions.js";
import { createItem, transition } from "../../src/domain/items.js";
import type { CollabDb } from "../../src/store/db.js";
import type { Decision, Item, Project } from "../../src/store/types.js";
import { registerTools } from "../../src/tools/index.js";
import { dispatchAction } from "../../src/ui/actions.js";
import { domainDb, ENGINEER, OWNER, OWNER_AGENT, outboxOf, teamProject } from "./setup.js";

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
    jobs,
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
    const decision = await askDecision(db, ORG, OWNER_AGENT, {
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
    const decision = await askDecision(db, ORG, ENGINEER, {
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
      // Only the confirmer may answer.
      const payload = { decisionId: id, optionId: choice };
      expect(await f.click(ENGINEER.accountId, payload)).toMatchObject({
        toast: { en: "Not answered: Only the gate's confirmer can answer it." },
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
    const decision = await askDecision(db, ORG, OWNER_AGENT, {
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
});
