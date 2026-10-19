import { randomUUID } from "node:crypto";
import { definePlugin, type PluginContext } from "@capybara-hq/plugin-sdk";
import { z } from "zod";

/** 部署级配置：每次递增的步长，默认 1。 */
const DeploymentConfig = z.object({
  step: z.number().int().positive().default(1),
});

type Db = PluginContext["db"];

/** counters 行 `default` 加 step 并返回新值。调用方须已处于事务中。 */
async function bump(db: Db, step: number): Promise<number> {
  const row = await db
    .insertInto("counters")
    .values({ name: "default", n: step })
    .onConflict((oc) => oc.column("name").doUpdateSet((eb) => ({ n: eb("counters.n", "+", step) })))
    .returning("n")
    .executeTakeFirstOrThrow();
  return Number(row.n);
}

/** 一次递增：同一事务里加计数并记一条事件，返回新值。 */
export async function applyInc(db: Db, step: number): Promise<number> {
  return db.transaction().execute(async (trx) => {
    const n = await bump(trx, step);
    await trx.insertInto("events").values({ delta: step }).execute();
    return n;
  });
}

/**
 * 延迟任务的递增。队列是至少一次投递（失败会重试，最多 3 次），同一个 jobId 的处理可能执行多次，
 * 所以靠 events.job_id 的唯一约束去重：同一事务里先 `INSERT ... ON CONFLICT DO NOTHING`，
 * 只有真的插入了一行才递增；重复投递时插入为空，计数不变。返回是否本次生效。
 */
export async function applyDelayedInc(db: Db, jobId: string, step: number): Promise<boolean> {
  return db.transaction().execute(async (trx) => {
    const ins = await trx
      .insertInto("events")
      .values({ job_id: jobId, delta: step })
      .onConflict((oc) => oc.column("job_id").doNothing())
      .returning("id")
      .executeTakeFirst();
    if (ins === undefined) return false;
    await bump(trx, step);
    return true;
  });
}

/**
 * 参考插件：多副本安全的计数器。
 * - 持久计数放 ctx.db（PG，事务内原子更新）；kv 只适合带 TTL 的临时状态；
 * - 延迟任务走 ctx.queue，handler 用 jobId + 唯一约束保证幂等；
 * - 通过 provide 对外暴露 counter@1 能力。
 */
export default definePlugin({
  name: "example-counter",
  version: "0.1.0",
  sdk: "^0.1.0",
  provides: ["counter@1"],
  config: { deployment: DeploymentConfig },
  migrations: "../migrations",
  permissions: {
    http: [
      { method: "POST", path: "/inc" },
      { method: "GET", path: "/count" },
      { method: "POST", path: "/inc-later" },
    ],
  },
  setup(ctx) {
    const { step } = DeploymentConfig.parse(ctx.config);

    const current = async (): Promise<number> => {
      const row = await ctx.db
        .selectFrom("counters")
        .select("n")
        .where("name", "=", "default")
        .executeTakeFirst();
      return row === undefined ? 0 : Number(row.n);
    };

    ctx.queue.define<{ jobId: string }>("delayed-inc", async ({ jobId }) => {
      await applyDelayedInc(ctx.db, jobId, step);
    });

    ctx.http.route("POST", "/inc", async () =>
      Response.json({ count: await applyInc(ctx.db, step) }),
    );
    ctx.http.route("GET", "/count", async () => Response.json({ count: await current() }));
    ctx.http.route("POST", "/inc-later", async () => {
      const jobId = randomUUID();
      await ctx.queue.add("delayed-inc", { jobId }, { delayMs: 200, jobId });
      return Response.json({ jobId });
    });

    ctx.provide("counter@1", { get: current });
  },
});
