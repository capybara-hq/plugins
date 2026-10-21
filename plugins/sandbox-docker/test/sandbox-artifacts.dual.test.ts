import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  createDualReplicaHarness,
  type Harness,
  replicaOf,
  startTestPostgres,
  startTestRedis,
  startTestS3,
  type TestContainer,
  type TestS3,
} from "@capybara-hq/testing";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDockerSandbox } from "../../../../plugins/sandbox-docker/src/index.js";
import {
  buildTestImages,
  docker,
  dockerAvailable,
  type SocketProxy,
  startSocketProxy,
  type TestImages,
} from "../../../../plugins/sandbox-docker/test/docker-env.js";
import type { ConversationEvent } from "../../src/conversations/events.js";
import { type KernelDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { AccountsService } from "../../src/identity/accounts.js";
import { UNKNOWN_RESULT_TEXT } from "../../src/runtime/context/pairing.js";
import { MAINTENANCE_QUEUE_NAME } from "../../src/runtime/maintenance.js";
import { runJobId } from "../../src/runtime/run-queue.js";
import { SANDBOX_SUSPEND_JOB } from "../../src/sandbox/lifecycle.js";
import { SANDBOX_LOCK_TTL_MS } from "../../src/sandbox/sandbox.service.js";
import {
  SANDBOX_RECREATED_NOTICE,
  SANDBOX_STARTED_NOTICE,
} from "../../src/tools/builtins/sandbox/common.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import { eventsOf, PW, waitFor, waitForTerminal } from "../helpers/runs.js";

/**
 * M5 第二段验收（双副本）：两个独立进程的内核副本（api / worker）共享 PG / Redis，加载 model-fake、
 * object-store-s3（SeaweedFS）与真实的 sandbox-docker 插件（runc，经 docker/sandbox-proxy 的 socket 代理，
 * 出站 none），全部经 HTTP 操作：
 *
 * 1. 预签名直传附件（CSV）→ finalize；
 * 2. 带附件发消息，agent 用 `sandbox_bash` 处理 /workspace/attachments 里的附件（首次使用，创建沙箱）；
 * 3. `sandbox_deliver` 交付产物 → `artifact_created` → 下载路由 302 到预签名地址，内容一致；
 * 4. `sandbox_bash` 执行中（命令比锁的 TTL 长）杀掉执行这次运行的副本 → 存活副本接手运行（结果未知），之后的
 *    调用等被杀副本持有的沙箱锁过期（TTL 60 秒）后复用同一个容器，文件还在、没有「重建」提示；接手时先杀掉
 *    被杀副本留在沙箱里的命令（fix wave S2 I2），新命令单独运行；
 * 5. 空闲到期（把 last_used_at 拨回去）后由维护任务休眠 → 状态 suspended、容器已停止 → 下一次调用
 *    透明恢复，文件还在、没有提示，状态回到 running。
 *
 * 没有 Docker 时整组跳过。
 */

const SANDBOX_DOCKER = fileURLToPath(
  new URL("../../../../plugins/sandbox-docker/src/index.ts", import.meta.url),
);
const S3_PLUGIN = fileURLToPath(
  new URL("../../../../plugins/object-store-s3/src/index.ts", import.meta.url),
);

const SANDBOX_TOOLS = ["sandbox_bash", "sandbox_read", "sandbox_deliver"];
const CSV = "fruit,qty\napple,3\npear,5\nplum,7\n";
const TOTAL = "total=15";

type Json = Record<string, unknown>;
type Res = { status: number; json: Json; location: string | null };
type ToolResult = Extract<ConversationEvent, { type: "tool_result" }>["payload"];

const ofType = <T extends ConversationEvent["type"]>(evs: ConversationEvent[], type: T) =>
  evs.filter((e): e is Extract<ConversationEvent, { type: T }> => e.type === type);

describe.skipIf(!dockerAvailable)("M5 第二段双副本验收（沙箱 + 产物）", () => {
  const network = `capybara-sandbox-seg2-${randomUUID().slice(0, 8)}`;
  let pgc: TestContainer;
  let rdc: TestContainer;
  let s3: TestS3;
  let images: TestImages;
  let proxy: SocketProxy;
  let h: Harness;
  let raw: ReturnType<typeof createDb>;
  let db: KernelDb;
  let redis: Redis;
  let maint: Queue;
  let base = "";
  const cookies = new Map<string, string>();
  const conversations: string[] = [];

  /** 指定副本发请求（带登录 cookie，不跟随重定向）。 */
  async function at(i: 0 | 1, method: string, path: string, body?: unknown): Promise<Res> {
    const res = await fetch(`http://127.0.0.1:${h.replicas[i].port}${path}`, {
      method,
      redirect: "manual",
      headers: {
        "x-capybara-csrf": "1",
        cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join("; "),
        ...(body !== undefined && { "content-type": "application/json" }),
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
    expect(replicaOf(res)).toBe(i);
    for (const c of res.headers.getSetCookie()) {
      const [pair = ""] = c.split(";");
      const eq = pair.indexOf("=");
      cookies.set(pair.slice(0, eq), pair.slice(eq + 1));
    }
    const text = await res.text();
    return {
      status: res.status,
      location: res.headers.get("location"),
      json: (text === "" ? {} : JSON.parse(text)) as Json,
    };
  }

  beforeAll(async () => {
    [pgc, rdc, s3, images, proxy] = await Promise.all([
      startTestPostgres(),
      startTestRedis(),
      startTestS3(),
      buildTestImages(),
      startSocketProxy(),
    ]);
    redis = new Redis(rdc.url);
    await redis.flushdb();
    h = await createDualReplicaHarness({
      plugins: [MODEL_FAKE, S3_PLUGIN, SANDBOX_DOCKER],
      pgUrl: pgc.url,
      redisUrl: rdc.url,
      pluginConfig: {
        "object-store-s3": {
          endpoint: s3.endpoint,
          region: s3.region,
          bucket: s3.bucket,
          accessKeyId: s3.accessKey,
          secretAccessKey: s3.secretKey,
          forcePathStyle: true,
        },
        "sandbox-docker": {
          endpoint: proxy.endpoint,
          network,
          egressProxyImage: images.egressImage,
        },
      },
      config: {
        auth: { cookieSecure: false },
        // 短锁期与 stalled 检测间隔：被杀副本持有的运行任务约 1.5 秒后由存活副本接手
        runtime: { jobLockMs: 1000, stalledIntervalMs: 500 },
        sandbox: {
          image: images.sandboxImage,
          limits: { memoryMb: 512, egress: "none", suspendAfterIdleMinutes: 1 },
        },
      },
    });
    raw = createDb(h.dbUrl, 3);
    db = kernelDb(raw);
    maint = new Queue(MAINTENANCE_QUEUE_NAME, { connection: new Redis(rdc.url) });

    await new AccountsService(db).createLocal({ login: "owner", password: PW, displayName: "O" });
    const login = await at(0, "POST", "/api/v1/auth/login", { login: "owner", password: PW });
    expect(login.status).toBe(200);
    const org = await at(1, "POST", "/api/v1/orgs", { name: "Acme" });
    expect(org.status, JSON.stringify(org.json)).toBe(201);
    base = `/api/v1/orgs/${(org.json.org as { id: string }).id}`;
  }, 600_000);

  afterAll(async () => {
    await h?.stop();
    if (proxy && images) {
      const p = createDockerSandbox({
        endpoint: proxy.endpoint,
        runtime: "runc",
        network,
        egressProxyImage: images.egressImage,
      });
      for (const c of conversations) {
        await p.destroyByName?.(`cap-${c}`, AbortSignal.timeout(60_000)).catch(() => undefined);
      }
    }
    await docker("network", "rm", network).catch(() => undefined);
    await maint?.close();
    redis?.disconnect();
    await raw?.destroy();
    await Promise.all([pgc?.stop(), rdc?.stop(), s3?.stop(), proxy?.stop()]);
    await images?.remove();
  }, 180_000);

  /** 预签名直传一个附件并 finalize，返回 id（建、finalize 分别打在两个副本上）。 */
  async function uploadAttachment(name: string, contentType: string, bytes: Buffer) {
    const c = await at(0, "POST", `${base}/attachments`, {
      name,
      contentType,
      size: bytes.length,
    });
    expect(c.status, JSON.stringify(c.json)).toBe(201);
    const id = c.json.id as string;
    const up = c.json.upload as {
      method: "PUT" | "POST";
      url: string;
      headers: Record<string, string>;
      fields?: Record<string, string>;
    };
    let res: Response;
    if (up.method === "PUT") {
      res = await fetch(up.url, { method: "PUT", headers: up.headers, body: bytes });
    } else {
      const form = new FormData();
      for (const [k, v] of Object.entries(up.fields ?? {})) form.append(k, v);
      form.append("file", new Blob([new Uint8Array(bytes)], { type: contentType }));
      res = await fetch(up.url, { method: "POST", headers: up.headers, body: form });
    }
    expect(res.status, await res.clone().text()).toBeLessThan(300);
    const f = await at(1, "POST", `${base}/attachments/${id}/finalize`);
    expect(f.status, JSON.stringify(f.json)).toBe(200);
    return id;
  }

  /** 第 n 个终态（须为 run_finished）对应 run 的事件与最后一条 tool_result。 */
  async function finished(convId: string, n: number, timeoutMs = 120_000) {
    const term = await waitForTerminal(db, convId, n, timeoutMs);
    const last = term[n - 1] as ConversationEvent;
    expect(last.type, JSON.stringify(last.payload)).toBe("run_finished");
    const evs = (await eventsOf(db, convId)).filter((e) => e.runId === last.runId);
    const result = ofType(evs, "tool_result").at(-1)?.payload;
    expect(result).toBeDefined();
    return { evs, result: result as ToolResult };
  }

  async function send(i: 0 | 1, convId: string, key: string, input: unknown) {
    const r = await at(i, "POST", `${base}/conversations/${convId}/messages`, {
      text: `tool:${key}:${JSON.stringify(input)}`,
    });
    expect(r.status, JSON.stringify(r.json)).toBe(202);
  }

  const containerOf = async (convId: string) =>
    JSON.parse(await docker("inspect", `cap-${convId}`))[0] as {
      Id: string;
      State: { Running: boolean };
    };

  const sandboxRow = (convId: string) =>
    db
      .selectFrom("sandboxes")
      .select(["status", "handle", "generation"])
      .where("conversation_id", "=", convId)
      .executeTakeFirstOrThrow();

  it("附件 → sandbox_bash 处理 → 交付产物 → 杀执行副本后续跑复用沙箱 → 空闲休眠后恢复", async () => {
    const ag = await at(0, "POST", `${base}/agents`, {
      definition: {
        name: "Analyst",
        instructions: "Use the sandbox.",
        model: { provider: "model-fake", model: "fake-1" },
        tools: SANDBOX_TOOLS.map((name) => ({ kind: "builtin", name })),
      },
      visibility: "org",
    });
    expect(ag.status, JSON.stringify(ag.json)).toBe(201);
    const agentId = (ag.json.agent as { id: string }).id;
    const conv = await at(1, "POST", `${base}/conversations`, { agentId });
    expect(conv.status, JSON.stringify(conv.json)).toBe(201);
    const convId = (conv.json.conversation as { id: string }).id;
    conversations.push(convId);
    const convPath = `${base}/conversations/${convId}`;

    // ---- 1. 上传附件 ----
    const fileId = await uploadAttachment("fruit.csv", "text/csv", Buffer.from(CSV));
    // 附件单独一条消息发出（model-fake 把文本附件的正文拼进最后一条用户文本，`tool:` 指令须独占一条）
    const m1 = await at(1, "POST", `${convPath}/messages`, {
      text: "echo:here is the data",
      files: [fileId],
    });
    expect(m1.status, JSON.stringify(m1.json)).toBe(202);
    const [t1] = await waitForTerminal(db, convId, 1, 30_000);
    expect(t1?.type).toBe("run_finished");
    // 只是登记了附件，还没有沙箱
    expect((await at(0, "GET", `${convPath}/sandbox`)).status).toBe(404);

    // ---- 2. sandbox_bash 处理附件（首次使用：创建沙箱，附件同步到 /workspace/attachments） ----
    await send(0, convId, "sandbox_bash", {
      command:
        "mkdir -p /workspace/out && awk -F, 'NR>1{s+=$2} END{print \"total=\" s}' " +
        "/workspace/attachments/fruit.csv | tee /workspace/out/summary.txt",
    });
    const r2 = await finished(convId, 2);
    expect(r2.result.isError, r2.result.content).toBe(false);
    expect(r2.result.content.startsWith(SANDBOX_STARTED_NOTICE)).toBe(true);
    expect(r2.result.content).toContain(TOTAL);
    const status2 = await at(1, "GET", `${convPath}/sandbox`);
    expect(status2.status).toBe(200);
    expect(status2.json.status).toBe("running");
    const c2 = await containerOf(convId);
    expect(c2.State.Running).toBe(true);
    const row2 = await sandboxRow(convId);

    // ---- 3. 交付产物 → artifact_created → 下载 ----
    await send(1, convId, "sandbox_deliver", {
      path: "/workspace/out/summary.txt",
      name: "summary.txt",
    });
    const r3 = await finished(convId, 3);
    expect(r3.result.isError, r3.result.content).toBe(false);
    expect(r3.result.content).toMatch(/^Delivered summary\.txt \(9 bytes, text\/plain\)/);
    const [art] = ofType(r3.evs, "artifact_created");
    expect(art?.payload).toMatchObject({
      name: "summary.txt",
      contentType: "text/plain",
      size: TOTAL.length + 1,
      sourcePath: "/workspace/out/summary.txt",
    });
    const artifactId = art?.payload.artifactId as string;
    const dl = await at(0, "GET", `${convPath}/artifacts/${artifactId}/download`);
    expect(dl.status).toBe(302);
    const got = await fetch(dl.location as string);
    expect(got.status).toBe(200);
    expect(await got.text()).toBe(`${TOTAL}\n`);

    // ---- 4. sandbox_bash 执行中杀掉执行这次运行的副本，另一个副本续跑 ----
    // 命令比锁的 TTL（60 秒）长、在默认超时（120 秒）之内：接手时它还在跑，必须由接手方杀掉
    await send(0, convId, "sandbox_bash", {
      command: "touch /workspace/step4-started && sleep 300 && touch /workspace/step4-finished",
    });
    // 命令确实在容器里跑起来了（沙箱锁在执行副本手里）
    await waitFor(
      async () =>
        (await docker("exec", `cap-${convId}`, "ls", "/workspace"))
          .split("\n")
          .includes("step4-started"),
      60_000,
      "step 4 command running",
      200,
    );
    const running = await db
      .selectFrom("runs")
      .select(["id", "job_id", "trigger_seq"])
      .where("conversation_id", "=", convId)
      .where("status", "=", "running")
      .execute();
    expect(running).toHaveLength(1);
    const run = running[0] as (typeof running)[number];
    const jobId = run.job_id ?? runJobId(convId, Number(run.trigger_seq));
    const processedBy = await redis.hget(`bull:cap-kernel-runs:${jobId}`, "pb");
    const victim = h.replicas.find((r) => processedBy?.endsWith(`-${r.pid}`));
    expect(victim, `processedBy=${processedBy}`).toBeDefined();
    const victimIndex = (victim as { index: 0 | 1 }).index;
    const survivor: 0 | 1 = victimIndex === 0 ? 1 : 0;
    expect(await redis.exists(`capk:sandbox:${convId}`)).toBe(1);
    const killedAt = Date.now();
    await h.kill(victimIndex);

    // 存活副本接手：这次调用结果未知（不重复执行），模型收尾
    const r4 = await finished(convId, 4, 60_000);
    expect(r4.evs[0]?.runId).toBe(run.id);
    expect(r4.result).toMatchObject({
      toolKey: "sandbox_bash",
      isError: true,
      content: UNKNOWN_RESULT_TEXT,
    });
    expect(ofType(r4.evs, "tool_call_started")).toHaveLength(1);
    const takeoverMs = Date.now() - killedAt;

    // 存活副本上的下一次调用：等被杀副本的沙箱锁过期，然后复用同一个容器
    await send(survivor, convId, "sandbox_bash", {
      command:
        "cat /workspace/out/summary.txt && ls /workspace && echo leftover=$(pgrep -fc '^sleep 300' || true)",
    });
    const r4b = await finished(convId, 5, 150_000);
    const reuseMs = Date.now() - killedAt;
    expect(r4b.result.isError, r4b.result.content).toBe(false);
    expect(r4b.result.content).not.toContain(SANDBOX_STARTED_NOTICE);
    expect(r4b.result.content).not.toContain(SANDBOX_RECREATED_NOTICE);
    expect(r4b.result.content.startsWith(`${TOTAL}\n`)).toBe(true);
    expect(r4b.result.content).toContain("step4-started");
    expect(r4b.result.content).toContain("attachments");
    // 被杀副本留下的 sleep 300 在接手时已被杀掉：新命令单独运行，旧命令也不会再跑完
    expect(r4b.result.content).toContain("leftover=0");
    expect(r4b.result.content).not.toContain("step4-finished");
    // 锁要等到 TTL 过期才能拿到（被杀副本最后一次续租后最多 TTL）
    expect(reuseMs).toBeLessThan(SANDBOX_LOCK_TTL_MS + 30_000);
    const c4 = await containerOf(convId);
    expect(c4.Id).toBe(c2.Id);
    const row4 = await sandboxRow(convId);
    expect(row4.status).toBe("running");
    expect(row4.handle).toEqual(row2.handle);

    // ---- 5. 空闲到期 → 维护任务休眠 → 下一次调用恢复 ----
    // suspendAfterIdleMinutes 最小 1 分钟：把 last_used_at 拨回 2 分钟前（PG 时钟），再立即触发扫描任务
    await sql`UPDATE capybara.sandboxes SET last_used_at = now() - interval '2 minutes'
      WHERE conversation_id = ${convId}`.execute(raw);
    await maint.add(SANDBOX_SUSPEND_JOB, {}, { removeOnComplete: true });
    await waitFor(
      async () => (await at(survivor, "GET", `${convPath}/sandbox`)).json.status === "suspended",
      60_000,
      "sandbox suspended",
      250,
    );
    expect((await containerOf(convId)).State.Running).toBe(false);

    await send(survivor, convId, "sandbox_read", { path: "/workspace/out/summary.txt" });
    const r5 = await finished(convId, 6);
    expect(r5.result.isError, r5.result.content).toBe(false);
    expect(r5.result.content).not.toContain(SANDBOX_STARTED_NOTICE);
    expect(r5.result.content).not.toContain(SANDBOX_RECREATED_NOTICE);
    expect(r5.result.content).toContain(TOTAL);
    const status5 = await at(survivor, "GET", `${convPath}/sandbox`);
    expect(status5.json.status).toBe("running");
    const c5 = await containerOf(convId);
    expect(c5.Id).toBe(c2.Id);
    expect(c5.State.Running).toBe(true);
    expect((await sandboxRow(convId)).handle).toEqual(row2.handle);

    // 整个过程只创建过一个沙箱（不同于「重建」：没有 recreated 提示，容器 id 不变）
    const notices = ofType(await eventsOf(db, convId), "tool_result").filter((e) =>
      e.payload.content.includes(SANDBOX_STARTED_NOTICE),
    );
    expect(notices).toHaveLength(1);
    console.info(
      `[m5-segment2] takeover ${takeoverMs}ms after kill, sandbox reused ${reuseMs}ms after kill`,
    );
    // 运行结束后没有遗留的活动运行
    const active = await db
      .selectFrom("runs")
      .select("id")
      .where("status", "in", ["queued", "running", "waiting"])
      .execute();
    expect(active).toEqual([]);
  }, 420_000);
});
