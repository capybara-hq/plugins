import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createItem, transition } from "../../src/domain/items.js";
import "../../src/page/actions.js";
import type {
  ActivityEntry,
  ItemActivityResult,
  ItemByConversationResult,
  ItemDetailResult,
  ProjectBoardResult,
  ProjectItemsResult,
  ProjectSettingsResult,
  QueryName,
} from "../../src/page/contract.js";
import type { CollabDb } from "../../src/store/db.js";
import {
  domainDb,
  ENGINEER,
  GUEST,
  NO_DECISION_JOBS,
  OWNER,
  QA,
  teamProject,
} from "../domain/setup.js";
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
const STRANGER = "acct-stranger";

/** A requirement moved to review by the engineer (no gates on the way). */
async function inReview(org: string, key: string) {
  const project = await teamProject(db, org, key);
  let item = await createItem(db, org, OWNER, {
    projectId: project.id,
    type: "requirement",
    title: "Export reports as PDF",
  });
  for (const to of ["drafting", "review"]) {
    const out = await transition(db, org, ENGINEER, item.id, item.version, to, {
      decisions: NO_DECISION_JOBS,
    });
    if (!("item" in out)) throw new Error("unexpected gate");
    item = out.item;
  }
  return { project, item };
}

it("watch action changes only the viewer's subscription", async () => {
  const org = "watch-page";
  const project = await teamProject(db, org, "WP");
  const item = await createItem(db, org, OWNER, {
    projectId: project.id,
    type: "task",
    title: "Watch",
  });
  const fake = pageCtx(db, AGENTS);
  const detail = (accountId: string) =>
    fake.query<ItemDetailResult>(org, accountId, "item.detail", { key: "WP-1" });

  expect((await detail(OWNER.accountId)).watching).toBe(false);
  expect(
    await fake.act(org, OWNER.accountId, "item.watch", { itemId: item.id, watching: true }),
  ).toMatchObject({ invalidate: ["item.detail"] });
  expect((await detail(OWNER.accountId)).watching).toBe(true);
  expect((await detail(ENGINEER.accountId)).watching).toBe(false);
  await fake.act(org, OWNER.accountId, "item.watch", { itemId: item.id, watching: false });
  expect((await detail(OWNER.accountId)).watching).toBe(false);
});

describe("page queries", () => {
  it("board query returns locked gate columns and ≤ 500 cards", async () => {
    const org = "org-page-board";
    const project = await teamProject(db, org, "BRD");
    await db
      .insertInto("items")
      .values(
        Array.from({ length: 505 }, (_, i) => ({
          org_id: org,
          project_id: project.id,
          number: i + 1,
          type: "requirement",
          title: `Item ${i + 1}`,
          status_key: "backlog",
          requester_account_id: OWNER.accountId,
          responsible_account_id: ENGINEER.accountId,
          executing_agent_id: "agent-eng",
          closed_at: null,
          fields: "{}",
        })),
      )
      .execute();
    const fake = pageCtx(db, AGENTS);
    const board = await fake.query<ProjectBoardResult>(org, ENGINEER.accountId, "project.board", {
      project: "BRD",
    });
    expect(board.type).toBe("requirement");
    expect(board.cards).toHaveLength(500);
    expect(board.truncated).toBe(true);
    const locked = Object.fromEntries(board.columns.map((c) => [c.key, c.locked]));
    expect(locked).toMatchObject({ backlog: false, drafting: false, ready: true, done: true });
    expect(board.columns.find((c) => c.key === "ready")?.gate).toEqual({ confirmer: "owner" });
    expect(board.cards[0]).toMatchObject({
      responsible: { id: ENGINEER.accountId, name: "Zhang" },
      agent: { id: "agent-eng", name: "Engineer agent" },
      version: 1,
    });
    expect(board.canEdit).toBe(true);
    expect(JSON.stringify(board).length).toBeLessThan(1024 * 1024);

    const filtered = await fake.query<ProjectBoardResult>(
      org,
      ENGINEER.accountId,
      "project.board",
      { project: "BRD", filter: { q: "Item 50" } },
    );
    // "Item 50" matches 50 and 500–505 by title, and number 50 by key.
    expect(filtered.cards.map((c) => c.key).sort()).toContain("BRD-50");
    expect(filtered.truncated).toBe(false);

    const table = await fake.query<ProjectItemsResult>(org, GUEST.accountId, "project.items", {
      project: "BRD",
      page: 2,
      pageSize: 500,
      sort: { field: "key", dir: "asc" },
    });
    expect(table.pageSize).toBe(100);
    expect(table.total).toBe(505);
    expect(table.rows[0]?.key).toBe("BRD-101");
    expect(table.canEdit).toBe(false);
  });

  it("non-member gets not found for every query", async () => {
    const org = "org-page-hidden";
    const { item } = await inReview(org, "HID");
    await db
      .updateTable("items")
      .set({ agent_conversation_id: "conv-hid" })
      .where("id", "=", item.id)
      .execute();
    const fake = pageCtx(db, AGENTS);
    fake.conversations.set(item.id, [
      {
        id: "conv-hid",
        ownerAccountId: ENGINEER.accountId,
        agentId: "agent-eng",
        state: "idle",
        lastActivityAt: new Date().toISOString(),
      },
    ]);
    const asked: [QueryName, object][] = [
      ["project.board", { project: "HID" }],
      ["project.items", { project: "HID" }],
      ["item.detail", { key: "HID-1" }],
      ["item.activity", { key: "HID-1" }],
      ["item.conversations", { key: "HID-1" }],
      ["project.settings", { project: "HID" }],
      ["people.search", { query: "", project: "HID" }],
      ["agents.usable", { project: "HID", accountId: ENGINEER.accountId }],
    ];
    for (const [query, params] of asked) {
      // A missing project or item reads exactly like a hidden one.
      expect(await fake.query(org, STRANGER, query, params as never)).toEqual({ notFound: true });
      expect(await fake.query("other-org", ENGINEER.accountId, query, params as never)).toEqual({
        notFound: true,
      });
    }
    const list = await fake.query<{ projects: unknown[] }>(org, STRANGER, "projects.list");
    expect(list.projects).toEqual([]);
    const panel = { component: "item-panel", conversationId: "conv-hid" };
    expect(await fake.query(org, STRANGER, "item.byConversation", {}, panel)).toEqual({
      item: null,
    });
    // A member sees it through the conversation's subject.
    const seen = await fake.query<ItemByConversationResult>(
      org,
      QA.accountId,
      "item.byConversation",
      {},
      panel,
    );
    expect(seen.item?.key).toBe("HID-1");
    // A conversation the kernel does not list for the item shows nothing.
    fake.conversations.set(item.id, []);
    expect(await fake.query(org, QA.accountId, "item.byConversation", {}, panel)).toEqual({
      item: null,
    });
    await db
      .updateTable("items")
      .set({ responsible_account_id: ENGINEER.accountId, executing_agent_id: "agent-eng" })
      .where("id", "=", item.id)
      .execute();
    const agentSection = { component: "agent-items", agentId: "agent-eng" };
    expect(await fake.query(org, STRANGER, "agent.items", {}, agentSection)).toMatchObject({
      items: [],
    });
    const own = await fake.query<{ items: { key: string }[] }>(
      org,
      ENGINEER.accountId,
      "agent.items",
      {},
      agentSection,
    );
    expect(own.items.map((i) => i.key)).toEqual(["HID-1"]);
    await expect(fake.query(org, ENGINEER.accountId, "nope" as QueryName)).rejects.toThrow(
      /unknown query/,
    );
  });

  it("item detail and activity show decisions, comments and pages", async () => {
    const org = "org-page-detail";
    const { item } = await inReview(org, "DET");
    const fake = pageCtx(db, AGENTS);
    for (let i = 0; i < 52; i++) {
      expect(
        await fake.act(org, QA.accountId, "item.comment", { itemId: item.id, body: `Note ${i}` }),
      ).toEqual({ invalidate: ["item.activity", "item.detail"] });
    }
    const first = await fake.query<ItemActivityResult>(org, OWNER.accountId, "item.activity", {
      key: "DET-1",
    });
    expect(first.entries).toHaveLength(50);
    expect(first.entries[0]).toMatchObject({
      kind: "commented",
      comment: "Note 51",
      actor: { person: { name: "Chen" }, agent: null },
    });
    const second = await fake.query<ItemActivityResult>(org, OWNER.accountId, "item.activity", {
      key: "DET-1",
      before: first.next,
    });
    const kinds = second.entries.map((e: ActivityEntry) => e.kind);
    expect(kinds).toEqual([
      "commented",
      "commented",
      "status_changed",
      "status_changed",
      "created",
    ]);
    expect(second.next).toBeNull();
    const detail = await fake.query<ItemDetailResult>(org, ENGINEER.accountId, "item.detail", {
      key: "DET-1",
    });
    expect(detail.item).toMatchObject({ key: "DET-1", statusKey: "review", version: item.version });
    expect(detail.statuses.map((s) => s.key)).toContain("ready");
    expect(detail.decisions).toEqual([]);
  });
});

describe("page actions", () => {
  it("move into a gate returns a toast and creates a gate decision", async () => {
    const org = "org-page-gate";
    const { item } = await inReview(org, "GAT");
    const fake = pageCtx(db, AGENTS);
    const out = await fake.act(org, ENGINEER.accountId, "item.move", {
      itemId: item.id,
      version: item.version,
      to: "ready",
    });
    expect(out.toast?.zh).toContain("已请 Wang 确认");
    expect(out.invalidate).toContain("project.board");
    const gate = await db
      .selectFrom("decisions")
      .selectAll()
      .where("item_id", "=", item.id)
      .executeTakeFirstOrThrow();
    expect(gate).toMatchObject({
      kind: "gate",
      state: "open",
      addressee_account_id: OWNER.accountId,
      gate_target: "ready",
    });
    const after = await db
      .selectFrom("items")
      .selectAll()
      .where("id", "=", item.id)
      .executeTakeFirstOrThrow();
    expect(after.status_key).toBe("review");
    // The confirmer's inbox got the request (the decision's notify follow-up ran at once).
    expect(fake.posts.some((p) => p.accountId === OWNER.accountId)).toBe(true);
    const board = await fake.query<ProjectBoardResult>(org, OWNER.accountId, "project.board", {
      project: "GAT",
    });
    expect(board.cards[0]).toMatchObject({ pendingGate: "ready", openDecisions: 1 });
    const detail = await fake.query<ItemDetailResult>(org, OWNER.accountId, "item.detail", {
      key: "GAT-1",
    });
    expect(detail.decisions[0]).toMatchObject({ kind: "gate", canAnswer: true });

    // gate.confirm by a non-confirmer is refused, and nothing moves.
    const refused = await fake.act(org, ENGINEER.accountId, "gate.confirm", {
      decisionId: gate.id,
      approve: true,
    });
    expect(refused.toast?.zh).toBe("只有确认人可以处理这个确认请求。");
    // The confirmer approves: the item moves and is handed to engineering with its agent.
    const ok = await fake.act(org, OWNER.accountId, "gate.confirm", {
      decisionId: gate.id,
      approve: true,
    });
    // Success answers no toast (a toast means refusal).
    expect(ok.toast).toBeUndefined();
    const moved = await db
      .selectFrom("items")
      .selectAll()
      .where("id", "=", item.id)
      .executeTakeFirstOrThrow();
    expect(moved).toMatchObject({
      status_key: "ready",
      responsible_account_id: ENGINEER.accountId,
      executing_agent_id: "agent-eng",
    });
  });

  it("the confirmer's own drop into a gated column moves the item", async () => {
    const org = "org-page-gate-owner";
    const { item } = await inReview(org, "GAO");
    const fake = pageCtx(db, AGENTS);
    const out = await fake.act(org, OWNER.accountId, "item.move", {
      itemId: item.id,
      version: item.version,
      to: "ready",
    });
    expect(out.toast).toBeUndefined();
    const moved = await db
      .selectFrom("items")
      .select("status_key")
      .where("id", "=", item.id)
      .executeTakeFirstOrThrow();
    expect(moved.status_key).toBe("ready");
  });

  it("version conflict returns a conflict toast and invalidates", async () => {
    const org = "org-page-conflict";
    const { item } = await inReview(org, "CON");
    const fake = pageCtx(db, AGENTS);
    const out = await fake.act(org, ENGINEER.accountId, "item.move", {
      itemId: item.id,
      version: item.version - 1,
      to: "drafting",
    });
    expect(out.toast?.zh).toContain("刚被其他人修改");
    expect(out.invalidate).toContain("project.board");
    const update = await fake.act(org, ENGINEER.accountId, "item.update", {
      itemId: item.id,
      version: item.version - 1,
      title: "New",
    });
    expect(update.toast?.en).toContain("changed the item");
    // Model-facing domain text never reaches a person.
    expect(JSON.stringify(update)).not.toContain("Read it again");
    // Malformed input is a toast too.
    expect(
      (await fake.act(org, ENGINEER.accountId, "item.move", { itemId: "x", version: 1, to: "a" }))
        .toast?.zh,
    ).toBe("无法完成这个操作，请刷新页面后重试。");
  });

  it("create and assign check the agent against the responsible person's usable agents", async () => {
    const org = "org-page-agents";
    const project = await teamProject(db, org, "AGT");
    const fake = pageCtx(db, AGENTS);
    const refused = await fake.act(org, OWNER.accountId, "item.create", {
      projectId: project.id,
      type: "task",
      title: "Write tests",
      responsibleAccountId: ENGINEER.accountId,
      agentId: "agent-qa",
    });
    expect(refused.toast?.en).toContain("cannot use this agent");
    const created = await fake.act(org, OWNER.accountId, "item.create", {
      projectId: project.id,
      type: "task",
      title: "Write tests",
      responsibleAccountId: ENGINEER.accountId,
      agentId: "agent-eng",
    });
    expect(created.toast).toBeUndefined();
    const item = await db
      .selectFrom("items")
      .selectAll()
      .where("org_id", "=", org)
      .executeTakeFirstOrThrow();
    expect(
      (
        await fake.act(org, OWNER.accountId, "item.assign", {
          itemId: item.id,
          version: item.version,
          responsibleAccountId: QA.accountId,
          agentId: "agent-eng",
        })
      ).toast?.en,
    ).toContain("cannot use this agent");
    expect(
      await fake.act(org, OWNER.accountId, "item.assign", {
        itemId: item.id,
        version: item.version,
        responsibleAccountId: QA.accountId,
        agentId: "agent-qa",
      }),
    ).toMatchObject({ invalidate: expect.arrayContaining(["project.board"]) });
    // Guests cannot write.
    expect(
      (await fake.act(org, GUEST.accountId, "item.comment", { itemId: item.id, body: "hi" })).toast
        ?.en,
    ).toBe("You are not allowed to do this.");
    const usable = await fake.query<{ agents: { id: string }[] }>(
      org,
      OWNER.accountId,
      "agents.usable",
      { project: "AGT", accountId: QA.accountId },
    );
    expect(usable.agents.map((a) => a.id)).toEqual(["agent-qa"]);
  });

  it("member settings: default agent must be usable, labels owner-only, gates re-address", async () => {
    const org = "org-page-members";
    const { project, item } = await inReview(org, "MEM");
    const fake = pageCtx(db, AGENTS);
    const bad = await fake.act(org, ENGINEER.accountId, "member.function", {
      projectId: project.id,
      accountId: ENGINEER.accountId,
      defaultAgentId: "agent-qa",
    });
    expect(bad.toast?.en).toContain("cannot use that agent");
    const label = await fake.act(org, ENGINEER.accountId, "member.function", {
      projectId: project.id,
      accountId: ENGINEER.accountId,
      functionLabel: "qa",
    });
    expect(label.toast?.en).toBe("You are not allowed to do this.");
    expect(
      await fake.act(org, OWNER.accountId, "member.add", {
        projectId: project.id,
        accountId: "acct-nobody",
        role: "member",
      }),
    ).toMatchObject({ toast: { en: "Only active members of the organization can be added." } });
    expect(
      (
        await fake.act(org, OWNER.accountId, "member.add", {
          projectId: project.id,
          accountId: "acct-new",
          role: "member",
          functionLabel: "design",
        })
      ).toast,
    ).toBeUndefined();

    // A gate request to the owner, then the owner hands the ready gate to the newcomer.
    await fake.act(org, ENGINEER.accountId, "item.move", {
      itemId: item.id,
      version: item.version,
      to: "ready",
    });
    const saved = await fake.act(org, OWNER.accountId, "settings.save", {
      projectId: project.id,
      name: "Renamed",
      statuses: [
        { type: "requirement", key: "ready", gate: { confirmer: "member", accountId: "acct-new" } },
      ],
    });
    expect(saved.toast).toBeUndefined();
    const gate = await db
      .selectFrom("decisions")
      .selectAll()
      .where("item_id", "=", item.id)
      .executeTakeFirstOrThrow();
    expect(gate.address_gen).toBe(1);
    const settings = await fake.query<ProjectSettingsResult>(
      org,
      ENGINEER.accountId,
      "project.settings",
      { project: "MEM" },
    );
    expect(settings.project.name).toBe("Renamed");
    expect(settings.canEdit).toBe(false);
    const ready = settings.types
      .find((t) => t.key === "requirement")
      ?.statuses.find((s) => s.key === "ready");
    expect(ready?.gate).toEqual({ confirmer: "member", accountId: "acct-new" });
    expect(settings.members.find((m) => m.person.id === ENGINEER.accountId)).toMatchObject({
      canSetAgent: true,
      defaultAgent: { id: "agent-eng", name: "Engineer agent" },
    });
    expect(
      (
        await fake.act(org, ENGINEER.accountId, "settings.save", {
          projectId: project.id,
          name: "Mine",
        })
      ).toast?.en,
    ).toBe("You are not allowed to do this.");
    expect(
      (await fake.act(org, OWNER.accountId, "gate.confirm", { decisionId: gate.id, approve: true }))
        .toast?.zh,
    ).toBe("只有确认人可以处理这个确认请求。");
  });

  it("project.create makes the clicking person owner; org guests may not", async () => {
    const org = "org-page-create";
    const fake = pageCtx(db, AGENTS);
    expect(
      (await fake.act(org, GUEST.accountId, "project.create", { key: "NEW", name: "N" }, "guest"))
        .toast?.en,
    ).toBe("You are not allowed to do this.");
    expect(
      await fake.act(org, ENGINEER.accountId, "project.create", { key: "NEW", name: "New" }),
    ).toEqual({ invalidate: ["projects.list"] });
    expect(
      (await fake.act(org, OWNER.accountId, "project.create", { key: "NEW", name: "Again" })).toast
        ?.en,
    ).toContain("be unused");
    const list = await fake.query<{ projects: { key: string; role: string }[] }>(
      org,
      ENGINEER.accountId,
      "projects.list",
    );
    expect(list.projects).toMatchObject([{ key: "NEW", role: "owner" }]);
  });
});
