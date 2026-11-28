import type {
  ExtensionContext,
  InputRequired,
  ToolCallContext,
  ToolHandler,
  ToolSpec,
} from "@capybara-hq/plugin-sdk";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sweepNotices } from "../../src/notices.js";
import "../../src/page/actions.js";
import type { CollabDb } from "../../src/store/db.js";
import { registerTools } from "../../src/tools/index.js";
import { domainDb, ENGINEER, OWNER, QA, teamProject } from "../domain/setup.js";
import { pageCtx } from "./fake.js";

let db: CollabDb;
let close: () => Promise<void>;
beforeAll(async () => {
  ({ db, close } = await domainDb());
});
afterAll(async () => {
  await close();
});

const AGENTS = {
  [OWNER.accountId]: [{ id: "agent-pm", name: "PM agent" }],
  [ENGINEER.accountId]: [{ id: "agent-eng", name: "Engineer agent" }],
  [QA.accountId]: [{ id: "agent-qa", name: "QA agent" }],
};

async function itemOf(org: string) {
  return db.selectFrom("items").selectAll().where("org_id", "=", org).executeTakeFirstOrThrow();
}

describe("assignment notices on creation", () => {
  it("creating an item for someone else from the page tells them; for yourself does not", async () => {
    const org = "org-notice-create-ui";
    const project = await teamProject(db, org, "NCU");
    const fake = pageCtx(db, AGENTS);
    await fake.act(org, OWNER.accountId, "item.create", {
      projectId: project.id,
      type: "requirement",
      title: "Export PDF",
      responsibleAccountId: ENGINEER.accountId,
      agentId: "agent-eng",
    });
    const item = await itemOf(org);
    expect(fake.posts).toHaveLength(1);
    expect(fake.posts[0]).toMatchObject({
      accountId: ENGINEER.accountId,
      kind: "collab.assigned",
      title: { zh: "NCU-1 已指派给你：Export PDF", en: "NCU-1 assigned to you: Export PDF" },
      body: { zh: "Engineer agent正在处理。", en: "Engineer agent is working on it." },
    });
    const created = await db
      .selectFrom("activity")
      .selectAll()
      .where("item_id", "=", item.id)
      .where("kind", "=", "created")
      .executeTakeFirstOrThrow();
    expect(fake.posts[0]?.dedupeKey).toBe(`collab.assigned-${item.id}-${created.id}`);
    expect(created.notified_at).not.toBeNull();
    // Self-assigned and unassigned creations owe nothing (decided, never posted).
    await fake.act(org, ENGINEER.accountId, "item.create", {
      projectId: project.id,
      type: "requirement",
      title: "Mine",
      responsibleAccountId: ENGINEER.accountId,
    });
    await fake.act(org, OWNER.accountId, "item.create", {
      projectId: project.id,
      type: "requirement",
      title: "Nobody's",
    });
    expect(fake.posts).toHaveLength(1);
    const owed = await db
      .selectFrom("activity")
      .select("id")
      .where("org_id", "=", org)
      .where("notified_at", "is", null)
      .execute();
    expect(owed).toEqual([]);
  });

  it("a creation whose request-path notice was lost is posted by the drain's sweep once", async () => {
    const org = "org-notice-create-sweep";
    const project = await teamProject(db, org, "NCS");
    const fake = pageCtx(db, AGENTS);
    await fake.act(org, OWNER.accountId, "item.create", {
      projectId: project.id,
      type: "task",
      title: "Lost",
      responsibleAccountId: QA.accountId,
    });
    expect(fake.posts).toHaveLength(1);
    // Simulate the crash: owed again, and old enough for the sweep.
    await db
      .updateTable("activity")
      .set({ notified_at: null, created_at: sql`now() - interval '5 minutes'` })
      .where("org_id", "=", org)
      .execute();
    const again = pageCtx(db, AGENTS);
    expect(await sweepNotices(again.ctx, org)).toBe(0);
    expect(again.posts.map((p) => p.accountId)).toEqual([QA.accountId]);
    expect(await sweepNotices(again.ctx, org)).toBe(0);
    expect(again.posts).toHaveLength(1);
  });

  it("creating an item for someone else through the tool tells them", async () => {
    const org = "org-notice-create-tool";
    await teamProject(db, org, "NCT");
    const fake = pageCtx(db, AGENTS);
    const tools = new Map<string, ToolHandler>();
    registerTools({
      ...fake.ctx,
      tools: { register: (spec: ToolSpec, h: ToolHandler) => tools.set(spec.name, h) },
    } as unknown as ExtensionContext);
    const create = tools.get("item_create");
    if (!create) throw new Error("item_create not registered");
    const call = {
      orgId: org,
      accountId: OWNER.accountId,
      ownerAccountId: OWNER.accountId,
      agentId: "agent-pm",
      callId: "call-1",
      conversationId: "conv-1",
      rootConversationId: "conv-1",
      signal: new AbortController().signal,
    } as unknown as ToolCallContext;
    const input = { project: "NCT", type: "task", title: "Fix login", responsible: "Zhang" };
    const asked = (await create(input, call)) as InputRequired;
    await create(input, {
      ...call,
      resume: { state: asked.state, answer: { confirm: true }, outcome: "answered" },
    } as unknown as ToolCallContext);
    expect(fake.posts.map((p) => [p.accountId, p.title])).toEqual([
      [
        ENGINEER.accountId,
        { zh: "NCT-1 已指派给你：Fix login", en: "NCT-1 assigned to you: Fix login" },
      ],
    ]);
  });
});

describe("item.update with a reassignment", () => {
  it("updates the fields, then assigns at the version the update returned", async () => {
    const org = "org-update-assign";
    const project = await teamProject(db, org, "UPA");
    const fake = pageCtx(db, AGENTS);
    await fake.act(org, OWNER.accountId, "item.create", {
      projectId: project.id,
      type: "task",
      title: "Old",
    });
    const before = await itemOf(org);
    const refused = await fake.act(org, OWNER.accountId, "item.update", {
      itemId: before.id,
      version: before.version,
      title: "New",
      responsibleAccountId: QA.accountId,
      agentId: "agent-eng",
    });
    expect(refused.toast?.en).toContain("cannot use this agent");
    expect((await itemOf(org)).title).toBe("Old");
    const out = await fake.act(org, OWNER.accountId, "item.update", {
      itemId: before.id,
      version: before.version,
      title: "New",
      responsibleAccountId: QA.accountId,
      agentId: "agent-qa",
    });
    expect(out.toast).toBeUndefined();
    const after = await itemOf(org);
    expect(after).toMatchObject({
      title: "New",
      responsible_account_id: QA.accountId,
      executing_agent_id: "agent-qa",
      version: before.version + 2,
    });
    expect(fake.posts.at(-1)).toMatchObject({ accountId: QA.accountId, kind: "collab.assigned" });
    // Assignment only, with no field change, still works at the given version.
    const only = await fake.act(org, OWNER.accountId, "item.update", {
      itemId: after.id,
      version: after.version,
      responsibleAccountId: QA.accountId,
      agentId: null,
    });
    expect(only.toast).toBeUndefined();
    expect((await itemOf(org)).executing_agent_id).toBeNull();
    expect(
      (
        await fake.act(org, OWNER.accountId, "item.update", {
          itemId: after.id,
          version: after.version,
          agentId: "agent-qa",
        })
      ).toast?.zh,
    ).toBe("无法完成这个操作，请刷新页面后重试。");
  });
});

describe("panel lookup index", () => {
  it("the conversation lookup can use activity_conversation", async () => {
    const plan = await db.transaction().execute(async (tx) => {
      await sql`SET LOCAL enable_seqscan = off`.execute(tx);
      return sql<{ "QUERY PLAN": string }>`EXPLAIN ${tx
        .selectFrom("activity")
        .select("item_id")
        .where("org_id", "=", "o")
        .where(
          sql<boolean>`actor ? 'conversationId' AND actor->>'conversationId' = ${"c"}`,
        )}`.execute(tx);
    });
    expect(plan.rows.map((r) => r["QUERY PLAN"]).join("\n")).toContain("activity_conversation");
  });
});
