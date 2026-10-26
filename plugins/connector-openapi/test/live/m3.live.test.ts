import { fileURLToPath } from "node:url";
import {
  type ConversationEvent,
  createConversation as createConv,
  createDb,
  createLocalAccount,
  createOrg,
  eventsOf,
  type Kernel,
  type KernelDb,
  kernelDb,
  postMessage,
  type KernelRequest as Req,
  login as session,
  startTestKernel,
  startTestPostgres,
  startTestRedis,
  type TestContainer,
  testKernelConfig,
  waitFor,
} from "@capybara-hq/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * M3 真实服务验收（`CAPYBARA_TEST_LIVE_TOOLS=1 pnpm exec vitest run plugins/connector-openapi/test/live/m3.live.test.ts -t live`）。
 * 单副本内核加载 model-fake（`tool:` 指令脚本化工具调用）与 connector-openapi，全部经 HTTP 安装连接器、跑会话。
 * (Moved from the kernel's tests: Petstore.)
 *
 * - 开关：只在显式设置 `CAPYBARA_TEST_LIVE_TOOLS=1` 时运行 Petstore（公开服务，无需密钥）；
 *   普通 `pnpm test` 不访问外网。
 * - Petstore 是公共演示服务，偶有 5xx：每次调用遇 5xx 重试一次。
 */

const PLUGIN_DIR = fileURLToPath(new URL("../../", import.meta.url));
const CONNECTOR = fileURLToPath(new URL("../../src/index.ts", import.meta.url));
/** The scripted model provider (a devDependency): `tool:<key>:<json>` makes it call a tool. */
const MODEL_FAKE = "@capybara-hq/plugin-model-fake";

const LIVE = process.env.CAPYBARA_TEST_LIVE_TOOLS === "1";

if (!LIVE) {
  console.info("[m3-live] live tool services skipped (set CAPYBARA_TEST_LIVE_TOOLS=1 to run)");
}

type ToolResult = Extract<ConversationEvent, { type: "tool_result" }>["payload"];
interface ToolView {
  name: string;
  key: string;
  status: string;
  defaultPolicy: string;
  inputSchema: { properties?: Record<string, { enum?: unknown[] }>; required?: string[] };
}
interface AppView {
  id: string;
  tools: ToolView[];
}

const ofType = <T extends ConversationEvent["type"]>(evs: ConversationEvent[], type: T) =>
  evs.filter((e): e is Extract<ConversationEvent, { type: T }> => e.type === type);

let pgc: TestContainer | undefined;
let rd: TestContainer | undefined;
let k: Kernel | undefined;
let raw: ReturnType<typeof createDb> | undefined;
let db: KernelDb;
let req: Req;
let orgId: string;
const logLines: string[] = [];

beforeAll(async () => {
  if (!LIVE) return;
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  k = await startTestKernel(
    testKernelConfig(
      { pg: pgc.url, redis: rd.url },
      {
        extensions: [MODEL_FAKE, CONNECTOR],
        extensionPermissions: { autoApprove: true },
        roles: ["api", "worker"],
        tools: { timeoutMs: 90_000 },
      },
    ),
    { resolveFrom: PLUGIN_DIR, log: { level: "info", write: (l) => logLines.push(l) } },
  );
  raw = createDb(pgc.url, 3);
  db = kernelDb(raw);
  await createLocalAccount(db, "owner", "O");
  req = await session(k, "owner");
  orgId = await createOrg(req);
}, 180_000);

afterAll(async () => {
  await k?.stop();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

async function install(payload: Record<string, unknown>): Promise<AppView> {
  const res = await req({ method: "POST", url: `/api/v1/orgs/${orgId}/connectors`, payload });
  expect(res.statusCode, res.body.slice(0, 2000)).toBe(201);
  return (res.json() as { connector: AppView }).connector;
}

async function agentFor(connectorId: string, tools: "all" | string[]): Promise<string> {
  const res = await req({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/agents`,
    payload: {
      definition: {
        name: "Live",
        instructions: "Be helpful.",
        model: { provider: "model-fake", model: "fake-1" },
        tools: [{ kind: "connector", connectorId, tools }],
      },
      visibility: "org",
    },
  });
  expect(res.statusCode, res.body).toBe(201);
  return (res.json() as { agent: { id: string } }).agent.id;
}

const terminalTypes = ["run_finished", "run_failed", "run_aborted"];

/**
 * 发一条 `tool:` 指令并等本轮结束；途中出现审批请求时经 HTTP 批准（`approve: false` 时视为失败）。
 * 返回最后一条 tool_result 与本轮是否请求过审批。
 */
async function runTool(
  convId: string,
  key: string,
  input: unknown,
  opts: { approve?: boolean; timeoutMs?: number } = {},
): Promise<{ result: ToolResult; approved: boolean; evs: ConversationEvent[] }> {
  const seq = await postMessage(req, orgId, convId, `tool:${key}:${JSON.stringify(input)}`);
  let approved = false;
  const done = await waitFor(
    async () => {
      const evs = (await eventsOf(db, convId)).filter((e) => e.seq > seq);
      const asked = ofType(evs, "approval_requested");
      const decided = new Set(ofType(evs, "approval_decided").map((e) => e.payload.approvalId));
      const open = asked.find((a) => !decided.has(a.payload.approvalId));
      if (open && !approved) {
        expect(opts.approve, `unexpected approval for ${key}`).toBe(true);
        const res = await req({
          method: "POST",
          url: `/api/v1/orgs/${orgId}/approvals/${open.payload.approvalId}/decision`,
          payload: { decision: "approve" },
        });
        // 运行可能尚未进入 waiting：稍后再试
        if (res.statusCode === 200) approved = true;
        return null;
      }
      const term = evs.find((e) => terminalTypes.includes(e.type));
      return term ? evs : null;
    },
    opts.timeoutMs ?? 120_000,
    `run of ${key}`,
    200,
  );
  const term = done.find((e) => terminalTypes.includes(e.type)) as ConversationEvent;
  expect(term.type, JSON.stringify(term.payload)).toBe("run_finished");
  const result = ofType(done, "tool_result").at(-1)?.payload;
  expect(result?.toolKey).toBe(key);
  return { result: result as ToolResult, approved, evs: done };
}

/** 公共演示服务：结果是 HTTP 5xx（或连接失败）时重试一次，并记下重试。 */
const flaky: string[] = [];
async function runToolRetry5xx(
  convId: string,
  key: string,
  input: unknown,
  opts: { approve?: boolean } = {},
) {
  const first = await runTool(convId, key, input, opts);
  const transient =
    first.result.isError && /HTTP 5\d\d|timed out|ECONN|fetch failed/i.test(first.result.content);
  if (!transient) return first;
  flaky.push(`${key}: ${first.result.content.slice(0, 200)}`);
  console.warn(`[m3-live] ${key} transient failure, retrying once`);
  return runTool(convId, key, input, opts);
}

describe.skipIf(!LIVE)("live", { timeout: 300_000 }, () => {
  it("live Petstore OpenAPI（specUrl）：GET findByStatus 直接执行；POST addPet 审批后执行", async () => {
    const app = await install({
      name: "Petstore",
      slug: "petstore",
      connector: "openapi",
      endpoint: {
        specUrl: "https://petstore3.swagger.io/api/v3/openapi.json",
        // 文档里的 servers 是相对路径 `/api/v3`
        baseUrl: "https://petstore3.swagger.io/api/v3",
        operations: ["findPetsByStatus", "addPet", "getPetById"],
      },
      auth: { type: "api_key", ownership: "org", in: "header", name: "api_key" },
      credential: { token: "special-key" },
    });
    const policies = Object.fromEntries(app.tools.map((t) => [t.name, t.defaultPolicy]));
    expect(policies).toEqual({ findPetsByStatus: "allow", addPet: "ask", getPetById: "allow" });
    const agentId = await agentFor(app.id, "all");
    const convId = await createConv(req, orgId, agentId);

    const list = await runToolRetry5xx(convId, "petstore__findPetsByStatus", {
      query: { status: "available" },
    });
    console.info(
      `[m3-live] petstore findPetsByStatus isError=${list.result.isError} approval=${list.approved} head=${JSON.stringify(list.result.content.slice(0, 120))}`,
    );
    expect(list.approved).toBe(false);
    expect(list.result.isError, list.result.content.slice(0, 500)).toBe(false);
    expect(list.result.content).toContain("HTTP 200");

    const id = 9_000_000 + Math.floor(Math.random() * 999_999);
    const add = await runToolRetry5xx(
      convId,
      "petstore__addPet",
      { body: { id, name: "capybara-live", photoUrls: [], status: "available" } },
      { approve: true },
    );
    console.info(
      `[m3-live] petstore addPet isError=${add.result.isError} approval=${add.approved} head=${JSON.stringify(add.result.content.slice(0, 160))}`,
    );
    expect(add.approved).toBe(true);
    expect(ofType(add.evs, "approval_decided").map((e) => e.payload.decision)).toContain(
      "approved",
    );
    expect(add.result.isError, add.result.content.slice(0, 500)).toBe(false);
    expect(add.result.content).toContain("capybara-live");
    if (flaky.length > 0) console.warn(`[m3-live] petstore retries: ${flaky.join(" | ")}`);
  });
});
