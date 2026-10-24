import { fileURLToPath } from "node:url";
import { createDualReplicaHarness, type Harness, startTestPostgres } from "@capybara-hq/testing";
import { Kysely, PostgresDialect } from "kysely";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { applyDelayedInc } from "../src/index.js";

const PLUGIN = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const BASE = "/plugins/example-counter";

let pgc: Awaited<ReturnType<typeof startTestPostgres>>;
const harnesses: Harness[] = [];

beforeAll(async () => {
  pgc = await startTestPostgres();
});

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((h) => h.stop()));
});

afterAll(async () => {
  await pgc?.stop();
});

async function start(extensionConfig?: Record<string, unknown>): Promise<Harness> {
  const h = await createDualReplicaHarness({
    extensions: [PLUGIN],
    pgUrl: pgc.url,
    ...(extensionConfig ? { extensionConfig } : {}),
  });
  harnesses.push(h);
  return h;
}

async function count(h: Harness): Promise<number> {
  const r = await h.request(`${BASE}/count`);
  return ((await r.json()) as { count: number }).count;
}

// biome-ignore lint/suspicious/noExplicitAny: 插件表结构由迁移定义，测试里不建类型
type AnyDb = Kysely<any>;

function plugin(h: Harness): AnyDb {
  return new Kysely<Record<string, never>>({
    dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: h.dbUrl, max: 2 }) }),
  }).withSchema("plugin_example_counter") as AnyDb;
}

async function eventRows(h: Harness): Promise<number> {
  const db = plugin(h);
  try {
    const r = await db
      .selectFrom("events")
      .select((eb) => eb.fn.countAll<string>().as("n"))
      .executeTakeFirstOrThrow();
    return Number(r.n);
  } finally {
    await db.destroy();
  }
}

// 每个用例都起两个副本子进程：全量并行跑时 5s 的本地默认值不够
describe("example-counter（双副本）", { timeout: 60_000 }, () => {
  it("交替 inc 5 次 → count 为 5，events 表 5 行", async () => {
    const h = await start();
    for (let i = 0; i < 5; i++) {
      const r = await h.request(`${BASE}/inc`, { method: "POST" });
      expect(r.status).toBe(200);
    }
    expect(await count(h)).toBe(5);
    expect(await eventRows(h)).toBe(5);
  });

  it("部署配置 step: 2 时 inc 3 次 → count 为 6", async () => {
    const h = await start({ "example-counter": { step: 2 } });
    for (let i = 0; i < 3; i++) await h.request(`${BASE}/inc`, { method: "POST" });
    expect(await count(h)).toBe(6);
  });

  it("inc-later：1 秒内 count 增加 1（任务可能在任一副本执行）", async () => {
    const h = await start();
    const r = await h.request(`${BASE}/inc-later`, { method: "POST" });
    expect(r.status).toBe(200);
    const deadline = Date.now() + 1000;
    let c = await count(h);
    while (c < 1 && Date.now() < deadline) {
      await new Promise((res) => setTimeout(res, 50));
      c = await count(h);
    }
    expect(c).toBe(1);
  });

  it("延迟任务按 jobId 幂等：同一 jobId 处理两次，计数只加一次", async () => {
    const h = await start();
    const db = plugin(h);
    try {
      expect(await applyDelayedInc(db, "job-1", 1)).toBe(true);
      expect(await applyDelayedInc(db, "job-1", 1)).toBe(false);
      expect(await applyDelayedInc(db, "job-2", 1)).toBe(true);
    } finally {
      await db.destroy();
    }
    expect(await count(h)).toBe(2);
    expect(await eventRows(h)).toBe(2);
  });
});
