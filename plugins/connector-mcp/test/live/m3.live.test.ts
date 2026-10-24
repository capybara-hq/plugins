import { fileURLToPath } from "node:url";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ConversationEvent } from "../../src/conversations/events.js";
import { type KernelDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { AccountsService } from "../../src/identity/accounts.js";
import { createKernel, type Kernel } from "../../src/kernel.js";
import { createLogger } from "../../src/log.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import {
  createConv,
  createOrg,
  eventsOf,
  PW,
  postMessage,
  type Req,
  runConfig,
  session,
  waitFor,
} from "../helpers/runs.js";

/**
 * M3 真实服务验收（`CAPYBARA_TEST_LIVE_TOOLS=1 pnpm vitest run packages/kernel/test/tools/m3-live.test.ts -t live`）。
 * 单副本内核加载 model-fake（`tool:` 指令脚本化工具调用）、connector-mcp 与 connector-openapi，全部经 HTTP
 * 安装连接器、跑会话。
 *
 * - 开关：只在显式设置 `CAPYBARA_TEST_LIVE_TOOLS=1` 时运行 DeepWiki 与 Petstore（公开服务，无需密钥）；
 *   普通 `pnpm test` 不访问外网。
 * - GitHub：另需 `CAPYBARA_TEST_GITHUB_MCP_TOKEN`（PAT）与 `CAPYBARA_TEST_GITHUB_REPO`（owner/name），值以
 *   「替换为」开头视为未填。会在该仓库开一个 issue，用例结束时（无论成败）在 finally 里经 GitHub REST 关闭。
 *   令牌不打印。
 * - Petstore 是公共演示服务，偶有 5xx：每次调用遇 5xx 重试一次。
 */

const CONNECTOR_MCP = fileURLToPath(
  new URL("../../../../plugins/connector-mcp/src/index.ts", import.meta.url),
);
const CONNECTOR_OPENAPI = fileURLToPath(
  new URL("../../../../plugins/connector-openapi/src/index.ts", import.meta.url),
);

const filled = (v: string | undefined): v is string =>
  v !== undefined && v.trim() !== "" && !v.startsWith("替换为");
const LIVE = process.env.CAPYBARA_TEST_LIVE_TOOLS === "1";
const GH_TOKEN = process.env.CAPYBARA_TEST_GITHUB_MCP_TOKEN;
const GH_REPO = process.env.CAPYBARA_TEST_GITHUB_REPO;
const GITHUB = LIVE && filled(GH_TOKEN) && filled(GH_REPO) && /^[^/\s]+\/[^/\s]+$/.test(GH_REPO);

if (!LIVE) {
  console.info("[m3-live] live tool services skipped (set CAPYBARA_TEST_LIVE_TOOLS=1 to run)");
} else if (!GITHUB) {
  console.info(
    "[m3-live] GitHub MCP skipped: CAPYBARA_TEST_GITHUB_MCP_TOKEN / CAPYBARA_TEST_GITHUB_REPO not filled",
  );
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
  k = await createKernel(
    runConfig(
      { pg: pgc.url, redis: rd.url },
      {
        plugins: [MODEL_FAKE, CONNECTOR_MCP, CONNECTOR_OPENAPI],
        extensionPermissions: { autoApprove: true },
        roles: ["api", "worker"],
        tools: { timeoutMs: 90_000 },
      },
    ),
    { env: {}, logger: createLogger("info", { write: (l) => logLines.push(l) }) },
  );
  await k.start();
  raw = createDb(pgc.url, 3);
  db = kernelDb(raw);
  await new AccountsService(db).createLocal({ login: "owner", password: PW, displayName: "O" });
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

/**
 * 从创建 issue 的工具结果里取 issue 号：先按 JSON 解析（`number`，或 `html_url` / `url` 里的 `/issues/<n>`），
 * 否则在文本里找本仓库的 issue URL。取不到返回 undefined。
 */
function issueNumberOf(content: string, owner: string, repo: string): number | undefined {
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const urlRe = new RegExp(`/${esc(owner)}/${esc(repo)}/issues/(\\d+)(?![\\d/])`, "i");
  const fromUrl = (s: unknown) => {
    const m = typeof s === "string" ? urlRe.exec(s) : null;
    return m ? Number(m[1]) : undefined;
  };
  try {
    const j = JSON.parse(content) as Record<string, unknown>;
    if (typeof j.number === "number" && Number.isInteger(j.number)) return j.number;
    const n = fromUrl(j.html_url) ?? fromUrl(j.url);
    if (n !== undefined) return n;
  } catch {
    // 不是 JSON：按文本找
  }
  return fromUrl(content);
}

/**
 * 清理：经 GitHub REST 关闭测试 issue（幂等）。知道 issue 号就直接关；否则按唯一标题在最近的 open issue 里找。
 * 只打印状态码，不打印令牌；清理失败只告警，不掩盖用例本身的失败。
 */
async function closeIssuesViaRest(
  token: string,
  owner: string,
  repo: string,
  issueNumber: number | undefined,
  title: string,
): Promise<void> {
  const api = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  const headers = {
    authorization: `Bearer ${token}`,
    accept: "application/vnd.github+json",
    "user-agent": "capybara-live-test",
    "x-github-api-version": "2022-11-28",
  };
  try {
    let numbers: number[] = issueNumber === undefined ? [] : [issueNumber];
    if (numbers.length === 0) {
      const res = await fetch(`${api}/issues?state=open&sort=created&direction=desc&per_page=50`, {
        headers,
      });
      if (!res.ok) {
        console.warn(`[m3-live] cleanup: listing issues failed (HTTP ${res.status})`);
        return;
      }
      const list = (await res.json()) as { number: number; title: string }[];
      numbers = list.filter((i) => i.title === title).map((i) => i.number);
    }
    for (const n of numbers) {
      const res = await fetch(`${api}/issues/${n}`, {
        method: "PATCH",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ state: "closed" }),
      });
      console.info(`[m3-live] cleanup: closed issue #${n} via REST (HTTP ${res.status})`);
    }
    if (numbers.length === 0) console.info("[m3-live] cleanup: no test issue to close");
  } catch (e) {
    console.warn(`[m3-live] cleanup failed: ${e instanceof Error ? e.name : "error"}`);
  }
}

describe.skipIf(!LIVE)("live", { timeout: 300_000 }, () => {
  it("live DeepWiki MCP（无认证）：安装列出 wiki 工具；read_wiki_structure（未标注 → 审批）返回非错误结果", async () => {
    const app = await install({
      name: "DeepWiki",
      slug: "deepwiki",
      connector: "mcp",
      endpoint: { url: "https://mcp.deepwiki.com/mcp" },
      auth: { type: "none" },
    });
    const names = app.tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["read_wiki_structure", "read_wiki_contents"]));
    // 提问工具曾叫 ask_question，2026-10 时服务端叫 ask_wiki_question
    expect(
      names.some((n) => n === "ask_question" || n === "ask_wiki_question"),
      names.join(),
    ).toBe(true);
    const structure = app.tools.find((t) => t.name === "read_wiki_structure") as ToolView;
    const repoArg = Object.keys(structure.inputSchema.properties ?? {})[0] ?? "repoName";
    console.info(
      `[m3-live] deepwiki tools=${names.join(",")} read_wiki_structure policy=${structure.defaultPolicy} arg=${repoArg}`,
    );
    const agentId = await agentFor(app.id, ["read_wiki_structure"]);
    const convId = await createConv(req, orgId, agentId);
    const r = await runTool(
      convId,
      "deepwiki__read_wiki_structure",
      { [repoArg]: "facebook/react" },
      { approve: true },
    );
    console.info(
      `[m3-live] deepwiki read_wiki_structure isError=${r.result.isError} approval=${r.approved} chars=${r.result.content.length} head=${JSON.stringify(r.result.content.slice(0, 120))}`,
    );
    expect(r.result.isError, r.result.content.slice(0, 500)).toBe(false);
    expect(r.result.content.length).toBeGreaterThan(0);
  });

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

  describe.skipIf(!GITHUB)("GitHub", () => {
    it("live GitHub MCP（PAT）：只读调用直接执行；创建 issue 需审批 → 批准 → 创建；结束时关闭", async () => {
      const token = GH_TOKEN as string;
      const [owner, repo] = (GH_REPO as string).split("/") as [string, string];
      const app = await install({
        name: "GitHub",
        slug: "github",
        connector: "mcp",
        endpoint: { url: "https://api.githubcopilot.com/mcp/" },
        auth: { type: "bearer", ownership: "org" },
        credential: { token },
      });
      const byName = new Map(app.tools.map((t) => [t.name, t]));
      const pick = (...names: string[]) => names.find((n) => byName.has(n));
      const readTool = pick("list_issues", "search_issues", "get_me");
      const createTool = pick("create_issue", "issue_write");
      const closeTool = pick("update_issue", "issue_write");
      console.info(
        `[m3-live] github tools(${app.tools.length})=${[...byName.keys()].join(",")} read=${readTool} create=${createTool} close=${closeTool}`,
      );
      expect(readTool).toBeDefined();
      expect(createTool).toBeDefined();
      const refs = [...new Set([readTool, createTool, closeTool].filter((x) => x !== undefined))];
      const agentId = await agentFor(app.id, refs as string[]);
      const convId = await createConv(req, orgId, agentId);

      // 只读：直接执行
      const readArgs =
        readTool === "get_me"
          ? {}
          : readTool === "search_issues"
            ? { query: `repo:${owner}/${repo}` }
            : { owner, repo };
      const read = await runTool(convId, `github__${readTool}`, readArgs);
      console.info(
        `[m3-live] github ${readTool} isError=${read.result.isError} approval=${read.approved}`,
      );
      expect(read.approved).toBe(false);
      expect(read.result.isError, read.result.content.slice(0, 500)).toBe(false);

      // 创建 issue：审批 → 批准 → 创建。无论之后哪一步失败，finally 都经 GitHub REST 关闭它（不依赖 MCP 工具名）
      const title = `capybara live test ${new Date().toISOString()} ${Math.random().toString(36).slice(2, 8)}`;
      let issueNumber: number | undefined;
      try {
        const createArgs =
          createTool === "issue_write"
            ? { method: "create", owner, repo, title, body: "Automated test; closed right away." }
            : { owner, repo, title, body: "Automated test; closed right away." };
        const created = await runTool(convId, `github__${createTool}`, createArgs, {
          approve: true,
        });
        issueNumber = issueNumberOf(created.result.content, owner, repo);
        console.info(
          `[m3-live] github ${createTool} isError=${created.result.isError} approval=${created.approved} issue=#${issueNumber}`,
        );
        expect(created.approved).toBe(true);
        expect(created.result.isError, created.result.content.slice(0, 500)).toBe(false);
        expect(issueNumber, created.result.content.slice(0, 500)).toBeDefined();

        // 经 MCP 关闭（同样走审批）；REST 关闭在 finally 里兜底
        if (closeTool !== undefined) {
          const tool = byName.get(closeTool) as ToolView;
          const stateEnum = tool.inputSchema.properties?.state?.enum ?? [];
          const closed = (stateEnum.find((s) => /closed/i.test(String(s))) as string) ?? "closed";
          const closeArgs =
            closeTool === "issue_write"
              ? { method: "update", owner, repo, issue_number: issueNumber, state: closed }
              : { owner, repo, issue_number: issueNumber, state: closed };
          const close = await runTool(convId, `github__${closeTool}`, closeArgs, {
            approve: true,
          });
          console.info(
            `[m3-live] github close #${issueNumber} isError=${close.result.isError} approval=${close.approved}`,
          );
          expect(close.result.isError, close.result.content.slice(0, 500)).toBe(false);
        }
      } finally {
        await closeIssuesViaRest(token, owner, repo, issueNumber, title);
      }

      // 令牌不出现在事件与日志里
      expect(JSON.stringify(await eventsOf(db, convId))).not.toContain(token);
      expect(logLines.join("\n")).not.toContain(token);
    });
  });
});
