import { definePlugin } from "@capybara-hq/plugin-sdk";
import { z } from "zod";

/** 部署级配置：每次递增的步长，默认 1。 */
const DeploymentConfig = z.object({
  step: z.number().int().positive().default(1),
});

const COUNT_KEY = "count";
const DAY_SECONDS = 86400;

/**
 * 参考插件：多副本安全的计数器。
 * - 计数放 ctx.kv（Redis，带 TTL），任一副本读到同一个值；
 * - 每次 inc 在插件自己的 schema 里记一行 events；
 * - 延迟任务走 ctx.queue，不用 setTimeout；
 * - 通过 provide 对外暴露 counter@1 能力。
 */
export default definePlugin({
  name: "example-counter",
  version: "0.1.0",
  sdk: "^0.1.0",
  provides: ["counter@1"],
  config: { deployment: DeploymentConfig },
  migrations: "../migrations",
  setup(ctx) {
    const { step } = DeploymentConfig.parse(ctx.config);

    // ctx.kv.incr 每次加 1，步长大于 1 时循环调用；每一步都是原子的，总数不会丢。
    const increment = async (): Promise<number> => {
      let value = 0;
      for (let i = 0; i < step; i++)
        value = await ctx.kv.incr(COUNT_KEY, { ttlSeconds: DAY_SECONDS });
      await ctx.db.insertInto("events").defaultValues().execute();
      return value;
    };
    const current = async (): Promise<number> => {
      const v = await ctx.kv.get(COUNT_KEY);
      return v === null ? 0 : Number(v);
    };

    ctx.queue.define("delayed-inc", async () => {
      await increment();
    });

    ctx.http.route("POST", "/inc", async () => Response.json({ count: await increment() }));
    ctx.http.route("GET", "/count", async () => Response.json({ count: await current() }));
    ctx.http.route("POST", "/inc-later", async () => {
      await ctx.queue.add("delayed-inc", {}, { delayMs: 200 });
      return Response.json({ queued: true });
    });

    ctx.provide("counter@1", { get: current });
  },
});
