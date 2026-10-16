import { fileURLToPath } from "node:url";
import { createDualReplicaHarness, type Harness, startTestPostgres } from "@capybara-hq/testing";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

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

async function start(pluginConfig?: Record<string, unknown>): Promise<Harness> {
  const h = await createDualReplicaHarness({
    plugins: [PLUGIN],
    pgUrl: pgc.url,
    ...(pluginConfig ? { pluginConfig } : {}),
  });
  harnesses.push(h);
  return h;
}

async function count(h: Harness): Promise<number> {
  const r = await h.request(`${BASE}/count`);
  return ((await r.json()) as { count: number }).count;
}

/** 本测试文件内同一时刻只有一个 harness 存活，所以唯一的 cap_* 库就是它的库。 */
async function eventRows(): Promise<number> {
  const admin = new pg.Client({ connectionString: pgc.url });
  await admin.connect();
  try {
    const dbs = await admin.query("SELECT datname FROM pg_database WHERE datname LIKE 'cap_%'");
    expect(dbs.rows).toHaveLength(1);
    const url = new URL(pgc.url);
    url.pathname = `/${dbs.rows[0].datname}`;
    const client = new pg.Client({ connectionString: url.toString() });
    await client.connect();
    try {
      const r = await client.query("SELECT count(*)::int AS n FROM plugin_example_counter.events");
      return r.rows[0].n;
    } finally {
      await client.end();
    }
  } finally {
    await admin.end();
  }
}

describe("example-counter（双副本）", () => {
  it("交替 inc 5 次 → count 为 5，events 表 5 行", async () => {
    const h = await start();
    for (let i = 0; i < 5; i++) {
      const r = await h.request(`${BASE}/inc`, { method: "POST" });
      expect(r.status).toBe(200);
    }
    expect(await count(h)).toBe(5);
    expect(await eventRows()).toBe(5);
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
});
