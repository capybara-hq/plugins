import {
  type ExtensionContext,
  type UiActionArgs,
  type UiActionResult,
  type UiOrgRenderArgs,
  type UiRole,
  type UiView,
  validateUiView,
} from "@capybara-hq/plugin-sdk";
import { startTestPostgres, type TestContainer } from "@capybara-hq/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { EMBED_QUEUE, embedMemory } from "../src/embed.js";
import {
  type MemoryDetail,
  type MemoryNodesPage,
  type MemoryPageData,
  type MemorySearchHit,
  PAGE,
  pageAction,
  renderPage,
} from "../src/page.js";
import { get, put, rememberOwner, touch } from "../src/store.js";
import { fakeModels, fakeQueue, type QueuedJob } from "./fakes.js";
import { migrate, pluginDb } from "./helpers.js";

let pgc: TestContainer;
let db: ExtensionContext["db"];
let destroy: () => Promise<void>;
let jobs: QueuedJob[];

beforeAll(async () => {
  pgc = await startTestPostgres();
  await migrate(pgc.url);
  ({ db, destroy } = pluginDb(pgc.url));
}, 180_000);

afterAll(async () => {
  await destroy?.();
  await pgc?.stop();
});

const ORG = "org-1";
const ADMIN = "acc-admin";
const MIA = "acc-mia";
const BEN = "acc-ben";
const AGENT = "agent-1";
const AGENT2 = "agent-2";
const own = (accountId: string, agentId = AGENT) => ({ orgId: ORG, agentId, accountId });

beforeEach(async () => {
  for (const t of ["memories", "owners", "admin_access_log"]) await db.deleteFrom(t).execute();
  jobs = [];
  // the pairs the context provider has seen (it records the names at each run start)
  await rememberOwner(db, own(MIA), { agentName: "Helper", ownerName: "Mia" });
  await rememberOwner(db, own(MIA, AGENT2), { agentName: "Writer", ownerName: "Mia" });
  await rememberOwner(db, own(BEN), { agentName: "Helper", ownerName: "Ben" });
  await rememberOwner(db, own(ADMIN), { agentName: "Helper", ownerName: "Ada" });
});

const deps = () =>
  ({ db, models: fakeModels(), queue: fakeQueue(jobs) }) as Pick<
    ExtensionContext,
    "db" | "models" | "queue"
  >;

const renderArgs = (accountId: string, role: UiRole): UiOrgRenderArgs => ({
  scope: "org",
  slot: "org.page",
  orgId: ORG,
  accountId,
  role,
  locale: "en",
  signal: new AbortController().signal,
});

async function view(accountId: string, role: UiRole): Promise<MemoryPageData> {
  const v = await renderPage(db, renderArgs(accountId, role));
  expect(validateUiView(v, { component: true })).toEqual([]);
  return v.data as unknown as MemoryPageData;
}

async function act(
  accountId: string,
  role: UiRole,
  actionId: string,
  payload: Record<string, unknown>,
): Promise<UiActionResult> {
  const args: UiActionArgs = { ...renderArgs(accountId, role), actionId, payload };
  const r = await pageAction(deps(), args);
  if ("view" in r) expect(validateUiView(r.view, { component: true })).toEqual([]);
  return r;
}

function dataOf<T>(r: UiActionResult): T {
  if (!("view" in r)) throw new Error(`expected a view, got ${JSON.stringify(r)}`);
  return (r.view as UiView).data as unknown as T;
}

const write = (
  owner: { orgId: string; agentId: string; accountId: string },
  path: string,
  body = "x",
) => put(db, owner, { path, description: `About ${path}`, body, conversationId: "conv-1" });

const log = () =>
  db
    .selectFrom("admin_access_log")
    .select(["admin_account_id", "owner_account_id", "agent_id", "action", "memory_path"])
    .orderBy("at")
    .execute();

const recalls = async (owner: ReturnType<typeof own>, path: string) => {
  const row = await get(db, owner, path);
  return { count: row?.recallCount, at: row?.lastRecalledAt };
};

describe("memory page", { timeout: 60_000 }, () => {
  it("a member sees only their own memories, with link and semantic edges", async () => {
    const a = (
      await write(own(MIA), "user/coffee.md", "Loves espresso. See [[tea]] and [[user/none.md]]")
    ).row;
    const b = (await write(own(MIA), "user/tea.md", "Drinks a latte too")).row;
    await write(own(MIA), "project/launch.md", "Deadline is 2026-12-01");
    await write(own(BEN), "user/ben.md");
    await write(own(MIA, AGENT2), "user/other-agent.md");
    // coffee and tea are close in the fake vectors: they become semantic neighbours
    for (const row of [a, b]) await embedMemory(deps(), own(MIA), row);

    const data = await view(MIA, "member");
    expect(data.canAdmin).toBe(false);
    expect(data.editable).toBe(true);
    expect(data.members).toBeUndefined();
    expect(data.agents.map((x) => x.id).sort()).toEqual([AGENT, AGENT2]);
    expect(data.selection.accountId).toBe(MIA);
    const agentId = data.selection.agentId as string;
    const paths = data.nodes.map((n) => n.path);
    expect(data.total).toBe(paths.length);
    expect(paths.every((p) => p !== "user/ben.md")).toBe(true);

    // the agent with the memories above: select it explicitly
    const sel = dataOf<MemoryPageData>(await act(MIA, "member", "select", { agentId: AGENT }));
    expect(sel.nodes.map((n) => n.path)).toEqual([
      "project/launch.md",
      "user/coffee.md",
      "user/tea.md",
    ]);
    expect(sel.nodes[1]).toMatchObject({
      type: "user",
      dir: "user",
      recalls: 0,
      lastRecalledAt: null,
    });
    expect(sel.truncated).toBe(false);
    expect(sel.edges).toContainEqual({ from: a.id, to: b.id, kind: "link" });
    const semantic = sel.edges.filter((e) => e.kind === "semantic");
    expect(semantic).toHaveLength(1);
    expect([semantic[0]?.from, semantic[0]?.to].sort()).toEqual([a.id, b.id].sort());
    // dangling links are not edges
    expect(sel.edges.filter((e) => e.kind === "link")).toHaveLength(1);
    expect(await log()).toEqual([]);
    expect(agentId).toBeTruthy();
  });

  it("a member cannot reach another member by crafting the payload", async () => {
    const ben = (await write(own(BEN), "user/ben.md")).row;
    for (const [actionId, payload] of [
      ["select", { agentId: AGENT, accountId: BEN }],
      ["open", { agentId: AGENT, accountId: BEN, memoryId: ben.id }],
      ["search", { agentId: AGENT, accountId: BEN, query: "ben" }],
      ["delete", { agentId: AGENT, accountId: BEN, memoryId: ben.id }],
      ["edit", { agentId: AGENT, accountId: BEN, memoryId: ben.id, description: "d", body: "b" }],
    ] as const) {
      const r = await act(MIA, "member", actionId, payload);
      expect(r, actionId).toEqual({
        toast: {
          zh: "只有组织管理员可以查看其他成员的记忆。",
          en: "Only org admins can see another member's memories.",
        },
      });
    }
    // another member's memory id with the member's own owner ids: not found, untouched
    const open = await act(MIA, "member", "open", { agentId: AGENT, memoryId: ben.id });
    expect(open).toMatchObject({ toast: { en: "This memory no longer exists." } });
    const del = await act(MIA, "member", "delete", { agentId: AGENT, memoryId: ben.id });
    expect(del).toMatchObject({ toast: { en: "This memory no longer exists." } });
    expect(await get(db, own(BEN), "user/ben.md")).not.toBeNull();
    // an agent the member has no memories with is refused
    const r = await act(MIA, "member", "select", { agentId: "agent-unknown" });
    expect(r).toMatchObject({ toast: { en: "No memories for that agent or member." } });
    expect(await log()).toEqual([]);
  });

  it("an admin selects, opens and searches another member's memories: logged, no recalls", async () => {
    const row = (await write(own(BEN), "feedback/reply-in-chinese.md", "回复一律用中文")).row;
    const admin = await view(ADMIN, "admin");
    expect(admin.canAdmin).toBe(true);
    expect(admin.members?.map((m) => m.name).sort()).toEqual(["Ada", "Ben", "Mia"]);

    const sel = dataOf<MemoryPageData>(await act(ADMIN, "admin", "select", { accountId: BEN }));
    expect(sel.selection).toEqual({ agentId: AGENT, accountId: BEN });
    expect(sel.editable).toBe(false);
    expect(sel.nodes.map((n) => n.path)).toEqual(["feedback/reply-in-chinese.md"]);

    const opened = dataOf<{ detail: MemoryDetail }>(
      await act(ADMIN, "admin", "open", { agentId: AGENT, accountId: BEN, memoryId: row.id }),
    );
    expect(opened.detail).toMatchObject({
      id: row.id,
      path: "feedback/reply-in-chinese.md",
      body: "回复一律用中文",
      createdIn: "conv-1",
      links: [],
    });
    const found = dataOf<{ hits: MemorySearchHit[] }>(
      await act(ADMIN, "admin", "search", { agentId: AGENT, accountId: BEN, query: "中文" }),
    );
    expect(found.hits.map((h) => h.path)).toEqual(["feedback/reply-in-chinese.md"]);
    // the admin's views never count as recalls
    expect(await recalls(own(BEN), row.path)).toEqual({ count: 0, at: null });
    expect(await log()).toEqual([
      {
        admin_account_id: ADMIN,
        owner_account_id: BEN,
        agent_id: AGENT,
        action: "view",
        memory_path: null,
      },
      {
        admin_account_id: ADMIN,
        owner_account_id: BEN,
        agent_id: AGENT,
        action: "view",
        memory_path: "feedback/reply-in-chinese.md",
      },
      {
        admin_account_id: ADMIN,
        owner_account_id: BEN,
        agent_id: AGENT,
        action: "view",
        memory_path: null,
      },
    ]);
  });

  it("an admin cannot edit another member's memory, but deletes it (logged)", async () => {
    const row = (await write(own(BEN), "user/ben.md", "Ben")).row;
    const edit = await act(ADMIN, "owner", "edit", {
      agentId: AGENT,
      accountId: BEN,
      memoryId: row.id,
      description: "changed",
      body: "changed",
    });
    expect(edit).toEqual({
      toast: {
        zh: "管理员不能编辑其他成员的记忆。",
        en: "Admins cannot edit another member's memories.",
      },
    });
    expect((await get(db, own(BEN), "user/ben.md"))?.body).toBe("Ben");

    const del = dataOf<MemoryPageData>(
      await act(ADMIN, "owner", "delete", { agentId: AGENT, accountId: BEN, memoryId: row.id }),
    );
    expect(del.nodes).toEqual([]);
    expect(await get(db, own(BEN), "user/ben.md")).toBeNull();
    expect(await log()).toEqual([
      {
        admin_account_id: ADMIN,
        owner_account_id: BEN,
        agent_id: AGENT,
        action: "delete",
        memory_path: "user/ben.md",
      },
    ]);
  });

  it("a member opens, searches, edits and deletes their own; page views are not recalls", async () => {
    const row = (await write(own(MIA), "user/coffee.md", "Loves espresso")).row;
    await write(own(MIA), "user/tea.md", "See [[coffee]]");
    const opened = dataOf<{ detail: MemoryDetail }>(
      await act(MIA, "member", "open", { agentId: AGENT, memoryId: row.id }),
    );
    expect(opened.detail.body).toBe("Loves espresso");
    const found = dataOf<{ hits: MemorySearchHit[] }>(
      await act(MIA, "member", "search", { agentId: AGENT, query: "espresso" }),
    );
    expect(found.hits.map((h) => h.id)).toEqual([row.id]);
    expect(await recalls(own(MIA), row.path)).toEqual({ count: 0, at: null });

    jobs.length = 0;
    const edited = dataOf<{ detail: MemoryDetail }>(
      await act(MIA, "member", "edit", {
        agentId: AGENT,
        memoryId: row.id,
        description: "Coffee order",
        body: "Flat white",
      }),
    );
    expect(edited.detail).toMatchObject({
      id: row.id,
      description: "Coffee order",
      body: "Flat white",
    });
    // the changed text is re-embedded through the queue
    expect(jobs).toMatchObject([{ name: EMBED_QUEUE, data: { memoryId: row.id } }]);
    const bad = await act(MIA, "member", "edit", {
      agentId: AGENT,
      memoryId: row.id,
      description: "two\nlines",
      body: "x",
    });
    expect(bad).toMatchObject({ toast: { en: expect.stringContaining("Cannot save:") } });

    const del = dataOf<MemoryPageData>(
      await act(MIA, "member", "delete", { agentId: AGENT, memoryId: row.id }),
    );
    expect(del.nodes.map((n) => n.path)).toEqual(["user/tea.md"]);
    expect(await log()).toEqual([]);
  });

  it("a page past the data limit is truncated and `more` returns the rest with their edges", async () => {
    const body = "y".repeat(10);
    const rows = [];
    for (let i = 0; i < 300; i++) {
      const n = String(i).padStart(3, "0");
      rows.push(
        (
          await write(
            own(MIA),
            `project/p${n}.md`,
            i > 0 ? `[[p${String(i - 1).padStart(3, "0")}]]` : body,
          )
        ).row,
      );
    }
    await touch(db, own(MIA), [rows[0]?.id as string]);
    const first = dataOf<MemoryPageData>(await act(MIA, "member", "select", { agentId: AGENT }));
    expect(first.total).toBe(300);
    expect(first.truncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThanOrEqual(32_768);
    const nodes = [...first.nodes];
    const edges = [...first.edges];
    let cursor = first.cursor;
    while (cursor !== null) {
      const next = dataOf<MemoryNodesPage>(
        await act(MIA, "member", "more", { agentId: AGENT, cursor }),
      );
      expect(next.nodes.length).toBeGreaterThan(0);
      nodes.push(...next.nodes);
      edges.push(...next.edges);
      cursor = next.cursor;
    }
    expect(nodes.map((n) => n.path)).toEqual(rows.map((r) => r.path));
    expect(nodes[0]?.recalls).toBe(1);
    expect(edges).toHaveLength(299);
    expect(new Set(edges.map((e) => `${e.from}>${e.to}`)).size).toBe(299);
  });

  it("a memoryId that is not a UUID is not found (never reaches the database)", async () => {
    await write(own(MIA), "user/coffee.md", "Loves espresso");
    const missing = await act(MIA, "member", "open", {
      agentId: AGENT,
      memoryId: "00000000-0000-4000-8000-000000000000",
    });
    expect(missing).toMatchObject({ toast: expect.anything() });
    for (const memoryId of ["-".repeat(36), "0".repeat(36), `${"a".repeat(8)}-${"b".repeat(27)}`]) {
      for (const actionId of ["open", "edit", "delete"]) {
        expect(
          await act(MIA, "member", actionId, {
            agentId: AGENT,
            memoryId,
            description: "d",
            body: "b",
          }),
        ).toEqual(missing);
      }
    }
  });

  it("the first view of a member with no memories yet has no agent and no nodes", async () => {
    const data = await view("acc-new", "member");
    expect(data).toMatchObject({
      agents: [],
      selection: { agentId: null, accountId: "acc-new" },
      nodes: [],
    });
    expect(PAGE).toBe("overview");
  });
});
