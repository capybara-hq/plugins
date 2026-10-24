import { fileURLToPath } from "node:url";
import {
  defaultFakeOpenApiSpec,
  type FakeOpenApiServer,
  startFakeOpenApiServer,
  startTestPostgres,
  startTestRedis,
  type TestContainer,
} from "@capybara-hq/testing";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ConversationEvent } from "../../src/conversations/events.js";
import { type KernelDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { AccountsService } from "../../src/identity/accounts.js";
import { createKernel, type Kernel } from "../../src/kernel.js";
import { createLogger } from "../../src/log.js";
import { memState } from "../fixtures/plugins/mem-connector/index.js";
import { truncateTables } from "../helpers/db.js";
import { testMembers } from "../helpers/members.js";
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
  waitForTerminal,
} from "../helpers/runs.js";

/**
 * Task 18：连接器预览（`POST /connectors/preview`，Ruling A20）与 connector-openapi 端到端。
 * 预览不落库：只读端点描述（connector.inspect）与工具清单（能认证或无需认证时）。
 */

const CONNECTOR_OPENAPI = fileURLToPath(
  new URL("../../../../plugins/connector-openapi/src/index.ts", import.meta.url),
);
const MEM_CONNECTOR = fileURLToPath(
  new URL("../fixtures/plugins/mem-connector/index.ts", import.meta.url),
);

const KEY = "openapi-org-key-5c1d9e7a3b";
const MEM_TOKEN = "mem_secret_value_0123456789";

let pgc: TestContainer;
let rd: TestContainer;
let k: Kernel;
let raw: ReturnType<typeof createDb>;
let db: KernelDb;
let api: FakeOpenApiServer;
let req: Req;
let orgId: string;
let ownerId: string;
const logLines: string[] = [];

const ofType = <T extends ConversationEvent["type"]>(evs: ConversationEvent[], type: T) =>
  evs.filter((e): e is Extract<ConversationEvent, { type: T }> => e.type === type);

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  api = await startFakeOpenApiServer({ apiKey: KEY, echoKey: true });
  k = await createKernel(
    runConfig(
      { pg: pgc.url, redis: rd.url },
      {
        extensions: [MODEL_FAKE, CONNECTOR_OPENAPI, MEM_CONNECTOR],
        extensionPermissions: { autoApprove: true },
        // 假服务在 127.0.0.1 上跑 http：测试打开本机 http（默认关闭）
        extensionConfig: { "connector-openapi": { allowInsecureLoopback: true } },
        roles: ["api", "worker"],
        tools: { timeoutMs: 5_000 },
      },
    ),
    { env: {}, logger: createLogger("info", { write: (l) => logLines.push(l) }) },
  );
  await k.start();
  raw = createDb(pgc.url, 5);
  db = kernelDb(raw);
}, 120_000);

afterAll(async () => {
  await k?.stop();
  await api?.stop();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

beforeEach(async () => {
  await truncateTables(raw, "capybara.accounts, capybara.orgs, capybara.audit_events");
  ownerId = (
    await new AccountsService(db).createLocal({ login: "owner", password: PW, displayName: "O" })
  ).id;
  req = await session(k, "owner");
  orgId = await createOrg(req);
  const st = memState();
  st.servers = {
    docs: {
      tools: [
        {
          name: "search",
          description: "Search documents.",
          inputSchema: { type: "object" },
          annotations: { readOnlyHint: true },
        },
        { name: "bad name!", description: "Bad.", inputSchema: { type: "object" } },
      ],
      requireAuth: `Bearer ${MEM_TOKEN}`,
    },
  };
  st.opened = 0;
  st.closed = 0;
  st.auths = [];
});

const countRows = async (table: "connectors" | "connector_tools" | "secrets" | "audit_events") =>
  Number(
    (
      await sql<{
        n: string;
      }>`SELECT count(*)::text AS n FROM ${sql.table(`capybara.${table}`)}`.execute(raw)
    ).rows[0]?.n,
  );

const preview = (payload: Record<string, unknown>, r: Req = req) =>
  r({ method: "POST", url: `/api/v1/orgs/${orgId}/connectors/preview`, payload });

interface PreviewJson {
  tools:
    | {
        name: string;
        key: string;
        description: string;
        inputSchema: Record<string, unknown>;
        annotations: Record<string, unknown> | null;
        defaultPolicy: string;
        issue: string | null;
        source: string;
      }[]
    | null;
  authHints: Record<string, unknown>[];
  operations?: { id: string; method: string; path: string; summary?: string }[];
}

const errOf = (res: { json(): unknown }) =>
  (res.json() as { error: { code: string; message: string } }).error;

describe("连接器预览", () => {
  it("只给端点：返回认证提示与操作清单，不列工具；什么都不写", async () => {
    const before = {
      connectors: await countRows("connectors"),
      secrets: await countRows("secrets"),
      audit: await countRows("audit_events"),
    };
    const res = await preview({ connector: "openapi", endpoint: { specUrl: api.specUrl } });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as PreviewJson;
    expect(body.tools).toBeNull();
    expect(body.authHints).toEqual([
      { scheme: "apiKey", type: "api_key", in: "header", name: "X-API-Key" },
    ]);
    expect(body.operations?.map((o) => o.id)).toContain("deletePet");
    expect(body.operations?.[0]).toEqual({
      id: "listPets",
      method: "GET",
      path: "/pets",
      summary: "List pets",
    });
    expect(await countRows("connectors")).toBe(before.connectors);
    expect(await countRows("secrets")).toBe(before.secrets);
    expect(await countRows("audit_events")).toBe(before.audit);
  });

  it("带认证与凭据：列出工具（key、默认策略、问题），凭据不落库、不回显", async () => {
    const res = await preview({
      name: "Pets",
      connector: "openapi",
      endpoint: { specUrl: api.specUrl, operations: ["listPets", "createPet", "deletePet"] },
      auth: { type: "api_key", ownership: "org", in: "header", name: "X-API-Key" },
      credential: { token: KEY },
    });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as PreviewJson;
    expect(body.tools?.map((t) => [t.key, t.defaultPolicy, t.issue])).toEqual([
      ["pets__listPets", "allow", null],
      ["pets__createPet", "ask", null],
      ["pets__deletePet", "ask", null],
    ]);
    expect(body.tools?.[0]?.annotations).toEqual({ readOnlyHint: true });
    expect(body.tools?.[0]?.inputSchema).toMatchObject({ type: "object" });
    expect(res.body).not.toContain(KEY);
    expect(await countRows("connectors")).toBe(0);
    expect(await countRows("secrets")).toBe(0);
    expect(await countRows("connector_tools")).toBe(0);
  });

  it("auth none：直接列工具；slug 用于 key 与问题（超长 key）", async () => {
    const res = await preview({
      slug: "a_very_long_app_slug_xyz",
      connector: "openapi",
      endpoint: {
        specText: JSON.stringify({
          openapi: "3.1.0",
          info: { title: "x", version: "1" },
          paths: { "/x": { get: { operationId: "abcdefghijklmnopqrstuvwxyzabcdefghijklmn" } } },
        }),
        baseUrl: "https://api.example.com",
      },
      auth: { type: "none" },
    });
    expect(res.statusCode, res.body).toBe(200);
    const tool = (res.json() as PreviewJson).tools?.[0];
    expect(tool?.key).toBe("a_very_long_app_slug_xyz__abcdefghijklmnopqrstuvwxyzabcdefghijklmn");
    expect(tool?.issue).toMatch(/limit is 64/);
  });

  it("工具名撞车：后者列在 issues 里", async () => {
    const res = await preview({
      connector: "openapi",
      endpoint: {
        specText: JSON.stringify({
          openapi: "3.1.0",
          info: { title: "x", version: "1" },
          paths: {
            "/a": { get: { operationId: "do.it" } },
            "/b": { post: { operationId: "do it" } },
          },
        }),
        baseUrl: "https://api.example.com",
      },
      auth: { type: "none" },
    });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as PreviewJson & { issues: { name: string; reason: string }[] };
    expect(body.tools?.map((t) => t.key)).toEqual(["app__do_it"]);
    expect(body.tools?.[0]?.annotations).toEqual({ readOnlyHint: true });
    expect(body.issues).toEqual([
      { name: "do_it", reason: "Duplicate tool name; only the first one is kept" },
    ]);
  });

  it("文档错误 → 502 connector.connect_failed 带说明（Swagger 2.0）", async () => {
    const res = await preview({
      connector: "openapi",
      endpoint: { specText: JSON.stringify({ swagger: "2.0", info: {}, paths: {} }) },
    });
    expect(res.statusCode).toBe(502);
    expect(errOf(res).code).toBe("connector.connect_failed");
    expect(errOf(res).message).toContain("Swagger 2.0");
  });

  it("安装时文档错误同样带说明", async () => {
    const res = await req({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/connectors`,
      payload: {
        name: "Old",
        connector: "openapi",
        endpoint: { specText: JSON.stringify({ swagger: "2.0", info: {}, paths: {} }) },
        auth: { type: "none" },
      },
    });
    expect(res.statusCode).toBe(502);
    expect(errOf(res).message).toContain("Swagger 2.0");
  });

  it("凭据错误的列工具失败 → 502，凭据不出现在响应里", async () => {
    const res = await preview({
      connector: "mem",
      endpoint: { server: "docs" },
      auth: { type: "bearer", ownership: "org" },
      credential: { token: `wrong-${MEM_TOKEN}` },
    });
    expect(res.statusCode).toBe(502);
    expect(errOf(res).code).toBe("connector.connect_failed");
    expect(res.body).not.toContain(MEM_TOKEN);
  });

  it("没有 inspect 的连接器：authHints 为空、没有 operations；有凭据时列工具并关闭会话", async () => {
    const res = await preview({
      connector: "mem",
      endpoint: { server: "docs" },
      auth: { type: "bearer", ownership: "org" },
      credential: { token: MEM_TOKEN },
    });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as PreviewJson;
    expect(body.authHints).toEqual([]);
    expect(body.operations).toBeUndefined();
    // 没给 slug / name：key 用占位 slug `app`
    expect(body.tools?.map((t) => [t.key, t.issue === null])).toEqual([
      ["app__search", true],
      ["app__bad name!", false],
    ]);
    expect(memState().opened).toBe(1);
    expect(memState().closed).toBe(1);
  });

  it("需要凭据但没给 / OAuth 授权码 → 不列工具", async () => {
    for (const auth of [
      { type: "bearer", ownership: "org" },
      {
        type: "oauth_code",
        ownership: "personal",
        discovery: "manual",
        authorizationUrl: "https://auth.example.com/a",
        tokenUrl: "https://auth.example.com/t",
        client: "manual",
      },
    ]) {
      const res = await preview({ connector: "mem", endpoint: { server: "docs" }, auth });
      expect(res.statusCode, res.body).toBe(200);
      expect((res.json() as PreviewJson).tools).toBeNull();
    }
    expect(memState().opened).toBe(0);
  });

  it("校验：未知连接器 / 端点里的凭据 / 凭据形状 → 400", async () => {
    const unknown = await preview({ connector: "nope", endpoint: {} });
    expect(unknown.statusCode).toBe(400);
    const leak = await preview({
      connector: "openapi",
      endpoint: { specUrl: `${api.specUrl}?api_key=${KEY}` },
    });
    expect(leak.statusCode).toBe(400);
    expect(leak.body).toContain("specUrl");
    const leakBase = await preview({
      connector: "openapi",
      endpoint: { specUrl: api.specUrl, baseUrl: "https://u:p@api.example.com" },
    });
    expect(leakBase.statusCode).toBe(400);
    const shape = await preview({
      connector: "mem",
      endpoint: { server: "docs" },
      auth: { type: "basic", ownership: "org" },
      credential: { token: "x" },
    });
    expect(shape.statusCode).toBe(400);
  });

  it("权限：member → 403", async () => {
    const acc = await new AccountsService(db).createLocal({
      login: "mem",
      password: PW,
      displayName: "m",
    });
    await testMembers(db).add(orgId, acc.id, "member", ownerId);
    const memberReq = await session(k, "mem");
    const res = await preview({ connector: "mem", endpoint: { server: "docs" } }, memberReq);
    expect(res.statusCode).toBe(403);
  });

  it("大文档（> 1 MB 的 specText）可以预览与安装", async () => {
    const spec = {
      ...defaultFakeOpenApiSpec(api.url),
      "x-padding": "p".repeat(1_500_000),
    };
    const endpoint = { specText: JSON.stringify(spec) };
    const res = await preview({ connector: "openapi", endpoint });
    expect(res.statusCode, res.body.slice(0, 300)).toBe(200);
    const created = await req({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/connectors`,
      payload: {
        name: "Big",
        connector: "openapi",
        endpoint,
        auth: { type: "api_key", ownership: "org", in: "header", name: "X-API-Key" },
        credential: { token: KEY },
      },
    });
    expect(created.statusCode, created.body.slice(0, 300)).toBe(201);
    // 连接器视图不回显文档全文（安装响应、详情、列表）
    const connectorId = (created.json() as { connector: { id: string } }).connector.id;
    const one = await req({
      method: "GET",
      url: `/api/v1/orgs/${orgId}/connectors/${connectorId}`,
    });
    const list = await req({ method: "GET", url: `/api/v1/orgs/${orgId}/connectors` });
    for (const body of [created.body, one.body, list.body]) {
      expect(body).not.toContain("ppppp");
      expect(body.length).toBeLessThan(200_000);
    }
    const ep = (one.json() as { connector: { endpoint: Record<string, unknown> } }).connector
      .endpoint;
    expect(ep.specTextBytes).toBe(Buffer.byteLength(endpoint.specText, "utf8"));
    expect(ep.specTextSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(ep.specText).toBeUndefined();
  });
});

describe("connector-openapi 端到端", () => {
  async function installPets(): Promise<string> {
    const res = await req({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/connectors`,
      payload: {
        name: "Pets",
        slug: "pets",
        connector: "openapi",
        endpoint: { specUrl: api.specUrl },
        auth: { type: "api_key", ownership: "org", in: "header", name: "X-API-Key" },
        credential: { token: KEY },
      },
    });
    expect(res.statusCode, res.body).toBe(201);
    const app = (
      res.json() as { connector: { id: string; tools: { name: string; defaultPolicy: string }[] } }
    ).connector;
    const byName = Object.fromEntries(app.tools.map((t) => [t.name, t.defaultPolicy]));
    expect(byName).toMatchObject({
      listPets: "allow",
      getPet: "allow",
      deletePet: "ask",
      createPet: "ask",
    });
    return app.id;
  }

  async function agentFor(connectorId: string): Promise<string> {
    const res = await req({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/agents`,
      payload: {
        definition: {
          name: "Helper",
          instructions: "Be helpful.",
          model: { provider: "model-fake", model: "fake-1" },
          tools: [{ kind: "connector", connectorId, tools: "all" }],
        },
        visibility: "org",
      },
    });
    expect(res.statusCode, res.body).toBe(201);
    return (res.json() as { agent: { id: string } }).agent.id;
  }

  async function runTool(convId: string, n: number, key: string, input: unknown) {
    await postMessage(req, orgId, convId, `tool:${key}:${JSON.stringify(input)}`);
    await waitForTerminal(db, convId, n, 20_000);
    const r = ofType(await eventsOf(db, convId), "tool_result").at(-1);
    expect(r?.payload.toolKey).toBe(key);
    return r?.payload as NonNullable<typeof r>["payload"];
  }

  it("A21：调用按已复核的路由；远端文档改了路径 → 刷新后待复核，复核通过才走新路由", async () => {
    const connectorId = await installPets();
    const agentId = await agentFor(connectorId);
    const convId = await createConv(req, orgId, agentId);
    const moved = defaultFakeOpenApiSpec(api.url, "header") as { paths: Record<string, unknown> };
    moved.paths["/animals/{petId}"] = moved.paths["/pets/{petId}"];
    delete moved.paths["/pets/{petId}"];
    api.setSpec(moved);
    try {
      const since = () => api.requests.length;
      let mark = since();
      await runTool(convId, 1, "pets__getPet", { path: { petId: 42 } });
      // 不读文档，按复核过的旧路由
      expect(api.requests.slice(mark).map((r) => `${r.method} ${r.path}`)).toEqual([
        "GET /v1/pets/42",
      ]);

      const refresh = await req({
        method: "POST",
        url: `/api/v1/orgs/${orgId}/connectors/${connectorId}/refresh`,
      });
      expect(refresh.statusCode, refresh.body).toBe(200);
      const r = refresh.json() as {
        connector: { tools: { name: string; status: string }[] };
        changes: { changed: string[] };
      };
      expect(r.changes.changed).toContain("getPet");
      expect(r.connector.tools.find((t) => t.name === "getPet")?.status).toBe("pending_review");
      // 复核对比可见路由变化（connectorData 新旧两份）；读者视图里不给
      type ToolJson = {
        name: string;
        connectorData: { path?: string } | null;
        pending: { connectorData: { path?: string } | null } | null;
      };
      const viewed = (r.connector.tools as unknown as ToolJson[]).find((t) => t.name === "getPet");
      expect(viewed?.connectorData?.path).toBe("/pets/{petId}");
      expect(viewed?.pending?.connectorData?.path).toBe("/animals/{petId}");
      const acc = await new AccountsService(db).createLocal({
        login: "viewer",
        password: PW,
        displayName: "v",
      });
      await testMembers(db).add(orgId, acc.id, "member", ownerId);
      const asMember = await (await session(k, "viewer"))({
        method: "GET",
        url: `/api/v1/orgs/${orgId}/connectors/${connectorId}`,
      });
      expect(asMember.statusCode, asMember.body).toBe(200);
      const memberTool = (
        asMember.json() as { connector: { tools: ToolJson[] } }
      ).connector.tools.find((t) => t.name === "getPet");
      expect(memberTool?.connectorData).toBeNull();
      expect(memberTool?.pending?.connectorData).toBeNull();
      // 快照里生效的定义仍是旧路由
      const row = await db
        .selectFrom("connector_tools")
        .select(["spec", "pending_spec"])
        .where("connector_id", "=", connectorId)
        .where("name", "=", "getPet")
        .executeTakeFirstOrThrow();
      expect((row.spec as { connectorData: { path: string } }).connectorData.path).toBe(
        "/pets/{petId}",
      );
      expect((row.pending_spec as { connectorData: { path: string } }).connectorData.path).toBe(
        "/animals/{petId}",
      );

      // 待复核期间不可调用
      mark = since();
      const pending = await runTool(convId, 2, "pets__getPet", { path: { petId: 42 } });
      expect(pending.isError).toBe(true);
      expect(api.requests.length).toBe(mark);

      const review = await req({
        method: "POST",
        url: `/api/v1/orgs/${orgId}/connectors/${connectorId}/tools/getPet/review`,
        payload: { action: "approve" },
      });
      expect(review.statusCode, review.body).toBe(200);
      mark = since();
      await runTool(convId, 3, "pets__getPet", { path: { petId: 42 } });
      expect(api.requests.slice(mark).map((x) => `${x.method} ${x.path}`)).toEqual([
        "GET /v1/animals/42",
      ]);
    } finally {
      api.setSpec(defaultFakeOpenApiSpec(api.url, "header"));
    }
  });

  it("安装后调用只读操作：注入 API key；非 2xx 的正文回显的 key 被打码", async () => {
    const connectorId = await installPets();
    const agentId = await agentFor(connectorId);
    const convId = await createConv(req, orgId, agentId);

    const list = await runTool(convId, 1, "pets__listPets", { query: { limit: 5 } });
    expect(list.isError).toBe(false);
    expect(list.content).toContain("HTTP 200");
    expect(api.requests.at(-1)?.headers["x-api-key"]).toBe(KEY);

    const missing = await runTool(convId, 2, "pets__getPet", { path: { petId: 42 } });
    expect(missing.isError).toBe(true);
    expect(missing.content).toContain("HTTP 404");
    expect(missing.content).toContain("[REDACTED]");
    expect(missing.content).not.toContain(KEY);

    const boom = await runTool(convId, 3, "pets__boom", {});
    expect(boom.isError).toBe(true);
    expect(boom.content).toContain("HTTP 500");
    expect(boom.content).not.toContain(KEY);

    const events = JSON.stringify(await eventsOf(db, convId));
    expect(events).not.toContain(KEY);
    expect(logLines.join("\n")).not.toContain(KEY);
  });
});
