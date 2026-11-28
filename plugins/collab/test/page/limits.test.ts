import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { comment, createItem, transition } from "../../src/domain/items.js";
import "../../src/page/actions.js";
import type {
  ItemActivityResult,
  ItemCommentResult,
  ItemDetailResult,
  ProjectBoardResult,
} from "../../src/page/contract.js";
import type { CollabDb } from "../../src/store/db.js";
import { domainDb, ENGINEER, NO_DECISION_JOBS, OWNER, QA, teamProject } from "../domain/setup.js";
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
  "acct-new": [{ id: "agent-new", name: "New agent" }],
};
const STRANGER = "acct-stranger";
/** A 3-byte UTF-8 character: the worst case per character for CJK text. */
const cjk = (n: number) => "测".repeat(n);
const bytes = (v: unknown) => Buffer.byteLength(JSON.stringify(v), "utf8");
const BUDGET = 900 * 1024;

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

async function itemRow(id: string) {
  return db.selectFrom("items").selectAll().where("id", "=", id).executeTakeFirstOrThrow();
}

describe("result size budgets", () => {
  it("board with maximal CJK cards stays under the budget and says truncated", async () => {
    const org = "org-limit-board";
    const project = await teamProject(db, org, "LBD");
    await db
      .insertInto("items")
      .values(
        Array.from({ length: 500 }, (_, i) => ({
          org_id: org,
          project_id: project.id,
          number: i + 1,
          type: "requirement",
          title: cjk(200),
          labels: Array.from({ length: 20 }, () => cjk(50)),
          status_key: "backlog",
          requester_account_id: OWNER.accountId,
          closed_at: null,
          fields: "{}",
        })),
      )
      .execute();
    const fake = pageCtx(db, AGENTS);
    const board = await fake.query<ProjectBoardResult>(org, OWNER.accountId, "project.board", {
      project: "LBD",
    });
    expect(board.truncated).toBe(true);
    expect(board.cards.length).toBeGreaterThan(100);
    expect(board.cards.length).toBeLessThan(500);
    expect(bytes(board)).toBeLessThan(BUDGET);
  });

  it("activity clips long comments; item.comment returns the whole body", async () => {
    const org = "org-limit-activity";
    const { item } = await inReview(org, "LAC");
    for (let i = 0; i < 52; i++) await comment(db, org, QA, item.id, cjk(20_000));
    const fake = pageCtx(db, AGENTS);
    const page = await fake.query<ItemActivityResult>(org, OWNER.accountId, "item.activity", {
      key: "LAC-1",
    });
    expect(bytes(page)).toBeLessThan(BUDGET);
    expect(page.next).not.toBeNull();
    const first = page.entries[0];
    expect(first?.clipped).toBe(true);
    expect([...(first?.comment ?? "")]).toHaveLength(4000);
    const full = await fake.query<ItemCommentResult>(org, OWNER.accountId, "item.comment", {
      key: "LAC-1",
      commentId: String(first?.detail.commentId),
    });
    expect(full.body).toBe(cjk(20_000));
    expect(
      await fake.query(org, STRANGER, "item.comment", {
        key: "LAC-1",
        commentId: String(first?.detail.commentId),
      }),
    ).toEqual({ notFound: true });
  });

  it("detail with many maximal decisions stays under the budget and says truncated", async () => {
    const org = "org-limit-detail";
    const { item } = await inReview(org, "LDT");
    await db
      .insertInto("decisions")
      .values(
        Array.from({ length: 120 }, (_, i) => ({
          org_id: org,
          item_id: item.id,
          kind: "question" as const,
          asker: JSON.stringify({ accountId: OWNER.accountId }),
          addressee_account_id: ENGINEER.accountId,
          question: cjk(2000),
          options: JSON.stringify(
            Array.from({ length: 10 }, (_, j) => ({ id: `o${i}-${j}`, label: cjk(100) })),
          ),
        })),
      )
      .execute();
    const fake = pageCtx(db, AGENTS);
    const detail = await fake.query<ItemDetailResult>(org, OWNER.accountId, "item.detail", {
      key: "LDT-1",
    });
    expect(detail.truncated).toBe(true);
    expect(detail.decisions.length).toBeGreaterThan(10);
    expect(detail.decisions.length).toBeLessThan(120);
    expect(bytes(detail)).toBeLessThan(BUDGET);
  });
});

describe("fix round 1 actions", () => {
  it("update with a reassignment to a just-demoted member saves nothing and invalidates", async () => {
    const org = "org-fix-demoted";
    const { project, item } = await inReview(org, "FDM");
    const fake = pageCtx(db, AGENTS);
    expect(
      await fake.act(org, OWNER.accountId, "member.add", {
        projectId: project.id,
        accountId: QA.accountId,
        role: "guest",
      }),
    ).not.toHaveProperty("toast");
    const out = await fake.act(org, OWNER.accountId, "item.update", {
      itemId: item.id,
      version: item.version,
      title: "Changed",
      responsibleAccountId: QA.accountId,
      agentId: null,
    });
    expect(out.toast?.en).toContain("owner or member");
    expect(out.invalidate).toContain("item.detail");
    const after = await itemRow(item.id);
    expect(after.title).toBe("Export reports as PDF");
    expect(after.version).toBe(item.version);
  });

  it("writes check the project role before any agent lookup", async () => {
    const org = "org-fix-role-first";
    const { project, item } = await inReview(org, "FRF");
    const fake = pageCtx(db, AGENTS);
    const calls: [string, object][] = [
      [
        "item.create",
        {
          projectId: project.id,
          type: "task",
          title: "x",
          responsibleAccountId: ENGINEER.accountId,
          agentId: "agent-eng",
        },
      ],
      [
        "item.assign",
        {
          itemId: item.id,
          version: item.version,
          responsibleAccountId: ENGINEER.accountId,
          agentId: "agent-eng",
        },
      ],
      [
        "item.update",
        {
          itemId: item.id,
          version: item.version,
          responsibleAccountId: ENGINEER.accountId,
          agentId: "agent-eng",
        },
      ],
      [
        "member.function",
        { projectId: project.id, accountId: ENGINEER.accountId, defaultAgentId: "agent-eng" },
      ],
      ["member.add", { projectId: project.id, accountId: "acct-new", role: "member" }],
    ];
    for (const [action, payload] of calls) {
      const out = await fake.act(org, STRANGER, action, payload);
      expect(out.toast?.en, action).toContain("not a member");
    }
    expect(fake.agentReads).toEqual([]);
  });

  it("settings.save refuses rule targets that cannot work", async () => {
    const org = "org-fix-settings";
    const { project } = await inReview(org, "FST");
    const fake = pageCtx(db, AGENTS);
    const save = (statuses: object[]) =>
      fake.act(org, OWNER.accountId, "settings.save", { projectId: project.id, statuses });
    expect(
      (
        await save([
          { type: "requirement", key: "ready", gate: { confirmer: "member", accountId: STRANGER } },
        ])
      ).toast?.en,
    ).toContain("owner or member");
    expect(
      (
        await save([
          {
            type: "task",
            key: "testing",
            defaultAssignment: { accountId: "acct-guest", agentId: "agent-qa" },
          },
        ])
      ).toast?.en,
    ).toContain("owner or member");
    expect(
      (
        await save([
          {
            type: "task",
            key: "testing",
            defaultAssignment: { functionLabel: "qa", agentId: "agent-eng" },
          },
        ])
      ).toast?.en,
    ).toContain("cannot use this agent");
    expect(
      await save([
        {
          type: "task",
          key: "testing",
          defaultAssignment: { accountId: QA.accountId, agentId: "agent-qa" },
        },
      ]),
    ).not.toHaveProperty("toast");
  });

  it("a function gate several members carry asks each of them; the first answer wins", async () => {
    const org = "org-fix-function-gate";
    const { project, item } = await inReview(org, "FFG");
    const fake = pageCtx(db, AGENTS);
    await fake.act(org, OWNER.accountId, "member.add", {
      projectId: project.id,
      accountId: "acct-new",
      role: "member",
      functionLabel: "engineering",
    });
    await fake.act(org, OWNER.accountId, "settings.save", {
      projectId: project.id,
      statuses: [
        {
          type: "requirement",
          key: "ready",
          gate: { confirmer: "function", functionLabel: "engineering" },
        },
      ],
    });
    const drop = await fake.act(org, QA.accountId, "item.move", {
      itemId: item.id,
      version: item.version,
      to: "ready",
    });
    expect(drop.toast?.zh).toContain("已请 Zhang、Newcomer 确认");
    expect(drop.toast?.en).toContain("asked Zhang, Newcomer");
    const gate = await db
      .selectFrom("decisions")
      .selectAll()
      .where("item_id", "=", item.id)
      .executeTakeFirstOrThrow();
    const asked = fake.posts
      .filter((p) => p.kind === "collab.decision")
      .map((p) => p.accountId)
      .sort();
    expect(asked).toEqual(["acct-eng", "acct-new"]);
    const withIds = await db
      .selectFrom("decisions")
      .select("inbox_item_ids")
      .where("id", "=", gate.id)
      .executeTakeFirstOrThrow();
    expect(withIds.inbox_item_ids).toHaveLength(2);
    // The owner is not a confirmer of a function gate.
    expect(
      (await fake.act(org, OWNER.accountId, "gate.confirm", { decisionId: gate.id, approve: true }))
        .toast?.zh,
    ).toBe("只有确认人可以处理这个确认请求。");
    expect(
      await fake.act(org, "acct-new", "gate.confirm", { decisionId: gate.id, approve: true }),
    ).not.toHaveProperty("toast");
    expect((await itemRow(item.id)).status_key).toBe("ready");
    expect(
      (
        await fake.act(org, ENGINEER.accountId, "gate.confirm", {
          decisionId: gate.id,
          approve: true,
        })
      ).toast?.en,
    ).toBe("This decision was already answered.");
  });

  it("only a permitted answerer closes a gate the item moved past", async () => {
    const org = "org-fix-stale-gate";
    const { item } = await inReview(org, "FSG");
    const fake = pageCtx(db, AGENTS);
    await fake.act(org, ENGINEER.accountId, "item.move", {
      itemId: item.id,
      version: item.version,
      to: "ready",
    });
    const gate = await db
      .selectFrom("decisions")
      .selectAll()
      .where("item_id", "=", item.id)
      .executeTakeFirstOrThrow();
    // The item moved on without the move's own cancel (e.g. an older write path).
    await db
      .updateTable("items")
      .set({ status_key: "drafting" })
      .where("id", "=", item.id)
      .execute();
    const refused = await fake.act(org, QA.accountId, "gate.confirm", {
      decisionId: gate.id,
      approve: true,
    });
    expect(refused.toast?.zh).toBe("只有确认人可以处理这个确认请求。");
    const still = await db
      .selectFrom("decisions")
      .select("state")
      .where("id", "=", gate.id)
      .executeTakeFirstOrThrow();
    expect(still.state).toBe("open");
    const owner = await fake.act(org, OWNER.accountId, "gate.confirm", {
      decisionId: gate.id,
      approve: true,
    });
    expect(owner.toast?.en).toBe("The item moved on.");
    expect((await itemRow(item.id)).status_key).toBe("drafting");
  });
});
