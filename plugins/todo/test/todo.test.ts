import { fileURLToPath } from "node:url";
import type {
  PluginContext,
  ToolCallContext,
  ToolHandler,
  ToolSpec,
} from "@capybara-hq/plugin-sdk";
import { createDualReplicaHarness, type Harness, startTestPostgres } from "@capybara-hq/testing";
import { Kysely, PostgresDialect } from "kysely";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import todo, { readTodos, renderTodos, writeHandler } from "../src/index.js";

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
function replicaDb(h: Harness): PluginContext["db"] {
  const db = new Kysely<never>({
    dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: h.dbUrl, max: 2 }) }),
  });
  pools.push(db);
  return db.withSchema("plugin_todo") as unknown as PluginContext["db"];
}

const call = (conversationId: string): ToolCallContext => ({
  orgId: "org",
  accountId: "acc",
  agentId: "agent",
  conversationId,
  callId: "call-1",
  signal: new AbortController().signal,
});

const text = (r: Awaited<ReturnType<ToolHandler>>): string =>
  "content" in r && r.content[0]?.type === "text" ? r.content[0].text : "";

describe("todo 插件", () => {
  it("注册 write 工具，默认策略 allow（模型可见名 todo__write）", () => {
    const registered: { spec: ToolSpec; handler: ToolHandler }[] = [];
    todo.setup({
      db: {},
      tools: {
        register: (spec: ToolSpec, handler: ToolHandler) => registered.push({ spec, handler }),
      },
    } as unknown as PluginContext);
    expect(registered).toHaveLength(1);
    expect(registered[0]?.spec.name).toBe("write");
    expect(registered[0]?.spec.defaultPolicy).toBe("allow");
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
    const h = await createDualReplicaHarness({ plugins: [PLUGIN], pgUrl: pgc.url });
    harnesses.push(h);
    const a = replicaDb(h);
    const b = replicaDb(h);
    const writeA = writeHandler(a);
    const writeB = writeHandler(b);

    const first = [
      { content: "Plan", status: "in_progress", activeForm: "Planning" },
      { content: "Build", status: "pending", activeForm: "Building" },
    ];
    const r1 = await writeA({ todos: first }, call("conv-1"));
    expect(text(r1)).toBe("Todo list updated (2 items):\n[>] Planning\n[ ] Build");
    expect(await readTodos(b, "conv-1")).toEqual(first);

    const second = [
      { content: "Plan", status: "completed", activeForm: "Planning" },
      { content: "Build", status: "in_progress", activeForm: "Building" },
    ];
    await writeB({ todos: second }, call("conv-1"));
    expect(await readTodos(a, "conv-1")).toEqual(second);

    expect(await readTodos(a, "conv-2")).toEqual([]);
    await writeA({ todos: [] }, call("conv-1"));
    expect(await readTodos(b, "conv-1")).toEqual([]);
  });

  it("并发写同一会话：整表覆盖，最终是某一次完整的清单", async () => {
    const h = await createDualReplicaHarness({ plugins: [PLUGIN], pgUrl: pgc.url });
    harnesses.push(h);
    const a = replicaDb(h);
    const b = replicaDb(h);
    const mk = (n: number) => [
      { content: `task ${n}`, status: "pending" as const, activeForm: `Doing ${n}` },
    ];
    await Promise.all([
      writeHandler(a)({ todos: mk(1) }, call("c")),
      writeHandler(b)({ todos: mk(2) }, call("c")),
    ]);
    const final = await readTodos(a, "c");
    expect([mk(1), mk(2)]).toContainEqual(final);
  });

  it("参数不合法 -> ToolError，写入不发生", async () => {
    const h = await createDualReplicaHarness({ plugins: [PLUGIN], pgUrl: pgc.url });
    harnesses.push(h);
    const a = replicaDb(h);
    await expect(
      writeHandler(a)({ todos: [{ content: "x", status: "bogus", activeForm: "y" }] }, call("c")),
    ).rejects.toThrow(/Invalid todos/);
    expect(await readTodos(a, "c")).toEqual([]);
  });
});
