import { fileURLToPath } from "node:url";
import type {
  ExtensionContext,
  ToolCallContext,
  ToolHandler,
  ToolSpec,
} from "@capybara-hq/plugin-sdk";
import { validateUiContributions, validateUiView } from "@capybara-hq/plugin-sdk";
import { createDualReplicaHarness, type Harness, startTestPostgres } from "@capybara-hq/testing";
import { Kysely, PostgresDialect } from "kysely";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import todo, {
  readSnapshot,
  readTodos,
  renderTodos,
  SNAPSHOTS_PER_CONVERSATION,
  tasksCardView,
  tasksSectionView,
  tasksView,
  writeHandler,
} from "../src/index.js";

const PLUGIN = fileURLToPath(new URL("../src/index.ts", import.meta.url));

let pgc: Awaited<ReturnType<typeof startTestPostgres>>;
const harnesses: Harness[] = [];
const pools: Kysely<never>[] = [];

beforeAll(async () => {
  pgc = await startTestPostgres();
});

afterEach(async () => {
  // 先关连接池再停 harness（后者会删库，池里的连接会被服务端终止）
  await Promise.all(pools.splice(0).map((p) => p.destroy()));
  await Promise.all(harnesses.splice(0).map((h) => h.stop()));
});

afterAll(async () => {
  await pgc?.stop();
});

/** 一个「副本」的 db：独立连接池指向同一个 plugin_todo schema（与真实副本里的 ctx.db 等价）。 */
function replicaDb(h: Harness): ExtensionContext["db"] {
  const db = new Kysely<never>({
    dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: h.dbUrl, max: 2 }) }),
  });
  pools.push(db);
  return db.withSchema("plugin_todo") as unknown as ExtensionContext["db"];
}

const call = (conversationId: string): ToolCallContext => ({
  orgId: "org",
  accountId: "acc",
  agentId: "agent",
  conversationId,
  callId: "call-1",
  signal: new AbortController().signal,
});

const noUi = { invalidate: async () => {} };

const text = (r: Awaited<ReturnType<ToolHandler>>): string =>
  "content" in r && r.content[0]?.type === "text" ? r.content[0].text : "";

// 双副本用例在用例里起两个副本子进程：全量并行跑时 5s 的本地默认值不够
describe("todo 插件", { timeout: 60_000 }, () => {
  it("registers write (allow, todo__write) and three places: panel, section, inline card", () => {
    const registered: { spec: ToolSpec; handler: ToolHandler }[] = [];
    const views: string[] = [];
    todo.setup({
      db: {},
      tools: {
        register: (spec: ToolSpec, handler: ToolHandler) => registered.push({ spec, handler }),
      },
      ui: { view: (id: string) => views.push(id) },
    } as unknown as ExtensionContext);
    expect(registered).toHaveLength(1);
    expect(registered[0]?.spec.name).toBe("write");
    expect(registered[0]?.spec.defaultPolicy).toBe("allow");
    expect(views).toEqual(["tasks-panel", "tasks-section", "tasks-card"]);
    const title = { zh: "任务", en: "Tasks" };
    expect(todo.ui).toEqual([
      { id: "tasks-panel", title, place: "panel", kind: "view", icon: "list-checks" },
      { id: "tasks-section", title, place: "section", kind: "view", icon: "list-checks" },
      { id: "tasks-card", title, place: "inline", kind: "view", icon: "list-checks" },
      // the old id answers as the panel for one release (open web pages keep working)
      { id: "tasks", title, place: "conversation", kind: "view", aliasOf: "tasks-panel" },
    ]);
    expect(todo.permissions?.ui).toEqual({
      views: ["tasks-panel", "tasks-section", "tasks-card", "tasks"],
    });
    expect(validateUiContributions(todo.ui, todo.permissions)).toEqual([]);
  });

  const THREE = [
    { content: "Plan", status: "completed" as const, activeForm: "Planning" },
    { content: "Build", status: "in_progress" as const, activeForm: "Building" },
    { content: "Ship", status: "pending" as const, activeForm: "Shipping" },
  ];

  it("the section: badge done/total, items open the panel at their item", () => {
    const v = tasksSectionView(THREE);
    expect(validateUiView(v)).toEqual([]);
    expect(v).toEqual({
      badge: "1/3",
      open: { contribution: "tasks-panel" },
      blocks: [
        {
          type: "checklist",
          items: [
            { text: "Plan", status: "completed", open: { contribution: "tasks-panel", item: "0" } },
            {
              text: "Building",
              status: "in_progress",
              open: { contribution: "tasks-panel", item: "1" },
            },
            { text: "Ship", status: "pending", open: { contribution: "tasks-panel", item: "2" } },
          ],
        },
      ],
    });
  });

  it("the inline card: the checklist with ⤢ opening the panel", () => {
    const v = tasksCardView(THREE);
    expect(validateUiView(v)).toEqual([]);
    expect(v.open).toEqual({ contribution: "tasks-panel" });
    expect(v.badge).toBe("1/3");
    expect(v.blocks).toHaveLength(1);
  });

  it("the panel: badge 已完成/总数, a checklist whose items carry ids (进行中显示 activeForm)", () => {
    expect(
      tasksView([
        { content: "Plan", status: "completed", activeForm: "Planning" },
        { content: "Build", status: "in_progress", activeForm: "Building" },
        { content: "Ship", status: "pending", activeForm: "Shipping" },
      ]),
    ).toEqual({
      badge: "1/3",
      blocks: [
        {
          type: "checklist",
          items: [
            { text: "Plan", status: "completed", id: "0" },
            { text: "Building", status: "in_progress", id: "1" },
            { text: "Ship", status: "pending", id: "2" },
          ],
        },
      ],
    });
    expect(tasksView([])).toEqual({ badge: "0/0", blocks: [{ type: "checklist", items: [] }] });
  });

  it("渲染：[x] / [>] / [ ]，进行中显示 activeForm", () => {
    expect(
      renderTodos([
        { content: "Plan", status: "completed", activeForm: "Planning" },
        { content: "Build", status: "in_progress", activeForm: "Building" },
        { content: "Ship", status: "pending", activeForm: "Shipping" },
      ]),
    ).toBe("Todo list updated (3 items):\n[x] Plan\n[>] Building\n[ ] Ship");
  });

  it("双副本：副本 A 写、副本 B 读一致；B 覆盖写后 A 读到新清单；会话互相隔离", async () => {
    const h = await createDualReplicaHarness({ extensions: [PLUGIN], pgUrl: pgc.url });
    harnesses.push(h);
    const a = replicaDb(h);
    const b = replicaDb(h);
    const invalidated: unknown[] = [];
    const ui = { invalidate: async (t: unknown) => void invalidated.push(t) };
    const writeA = writeHandler(a, ui);
    const writeB = writeHandler(b, ui);

    const first = [
      { content: "Plan", status: "in_progress", activeForm: "Planning" },
      { content: "Build", status: "pending", activeForm: "Building" },
    ];
    const r1 = await writeA({ todos: first }, call("conv-1"));
    expect(text(r1)).toBe("Todo list updated (2 items):\n[>] Planning\n[ ] Build");
    // 显示摘要（不进模型上下文）与写入后的刷新通知
    expect("display" in r1 && r1.display).toEqual({
      summary: { zh: "更新任务清单（2 项）", en: "Updated task list (2 items)" },
    });
    // the inline card under the call (display only), keyed by a snapshot of the list at this call
    const card1 = "card" in r1 ? r1.card : undefined;
    expect(card1).toEqual({ view: "tasks-card", key: expect.any(String) });
    const key1 = card1?.key as string;
    expect(await readSnapshot(b, "conv-1", key1)).toEqual(first);
    // a snapshot is scoped by its conversation
    expect(await readSnapshot(b, "conv-2", key1)).toBeNull();
    expect(invalidated).toEqual(
      ["tasks-panel", "tasks-section", "tasks-card", "tasks"].map((contribution) => ({
        orgId: "org",
        conversationId: "conv-1",
        contribution,
      })),
    );
    expect(await readTodos(b, "conv-1")).toEqual(first);

    const second = [
      { content: "Plan", status: "completed", activeForm: "Planning" },
      { content: "Build", status: "in_progress", activeForm: "Building" },
    ];
    const r2 = await writeB({ todos: second }, call("conv-1"));
    expect(await readTodos(a, "conv-1")).toEqual(second);
    // the first card keeps showing the list as of its call
    expect(await readSnapshot(a, "conv-1", key1)).toEqual(first);
    const key2 = ("card" in r2 ? r2.card?.key : undefined) as string;
    expect(key2).not.toBe(key1);
    expect(await readSnapshot(a, "conv-1", key2)).toEqual(second);

    expect(await readTodos(a, "conv-2")).toEqual([]);
    await writeA({ todos: [] }, call("conv-1"));
    expect(await readTodos(b, "conv-1")).toEqual([]);
  });

  it(`keeps the last ${SNAPSHOTS_PER_CONVERSATION} snapshots per conversation, with the org (final review m4)`, async () => {
    const h = await createDualReplicaHarness({ extensions: [PLUGIN], pgUrl: pgc.url });
    harnesses.push(h);
    const a = replicaDb(h);
    const write = writeHandler(a, noUi);
    const keys: string[] = [];
    for (let i = 0; i < SNAPSHOTS_PER_CONVERSATION + 3; i++) {
      const r = await write(
        { todos: [{ content: `t${i}`, status: "pending", activeForm: `T${i}` }] },
        call("capped"),
      );
      keys.push(("card" in r ? r.card?.key : undefined) as string);
    }
    await write({ todos: [] }, call("other"));
    const rows = (await (a as unknown as Kysely<Record<string, Record<string, unknown>>>)
      .selectFrom("snapshots")
      .select(["id", "org_id", "conversation_id"])
      .execute()) as { id: string; org_id: string; conversation_id: string }[];
    const capped = rows.filter((r) => r.conversation_id === "capped");
    expect(capped).toHaveLength(SNAPSHOTS_PER_CONVERSATION);
    expect(rows.every((r) => r.org_id === "org")).toBe(true);
    // the oldest are gone (their cards fall back to the current list), the newest stay
    expect(await readSnapshot(a, "capped", keys[0] as string)).toBeNull();
    expect(await readSnapshot(a, "capped", keys.at(-1) as string)).toEqual([
      {
        content: `t${SNAPSHOTS_PER_CONVERSATION + 2}`,
        status: "pending",
        activeForm: `T${SNAPSHOTS_PER_CONVERSATION + 2}`,
      },
    ]);
    expect(rows.filter((r) => r.conversation_id === "other")).toHaveLength(1);
  });

  it("并发写同一会话：整表覆盖，最终是某一次完整的清单", async () => {
    const h = await createDualReplicaHarness({ extensions: [PLUGIN], pgUrl: pgc.url });
    harnesses.push(h);
    const a = replicaDb(h);
    const b = replicaDb(h);
    const mk = (n: number) => [
      { content: `task ${n}`, status: "pending" as const, activeForm: `Doing ${n}` },
    ];
    await Promise.all([
      writeHandler(a, noUi)({ todos: mk(1) }, call("c")),
      writeHandler(b, noUi)({ todos: mk(2) }, call("c")),
    ]);
    const final = await readTodos(a, "c");
    expect([mk(1), mk(2)]).toContainEqual(final);
  });

  it("参数不合法 -> ToolError，写入不发生", async () => {
    const h = await createDualReplicaHarness({ extensions: [PLUGIN], pgUrl: pgc.url });
    harnesses.push(h);
    const a = replicaDb(h);
    await expect(
      writeHandler(a, noUi)(
        { todos: [{ content: "x", status: "bogus", activeForm: "y" }] },
        call("c"),
      ),
    ).rejects.toThrow(/Invalid todos/);
    expect(await readTodos(a, "c")).toEqual([]);
  });
});
