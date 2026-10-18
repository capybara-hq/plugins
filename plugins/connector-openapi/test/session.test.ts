import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
  type AuthInjection,
  type Connector,
  type ConnectorSession,
  ToolError,
  type ToolResult,
} from "@capybara-hq/plugin-sdk";
import {
  defaultFakeOpenApiSpec,
  type FakeOpenApiServer,
  startFakeOpenApiServer,
} from "@capybara-hq/testing";
import { afterEach, describe, expect, it } from "vitest";
import { createOpenApiConnector } from "../src/connector.js";

/** 对着本地假 OpenAPI 服务的会话用例：取文档、调用、鉴权注入、401 重试、错误分类。 */

const KEY = "fake-api-key-1234567890";
const log = { info() {}, warn() {}, error() {} };
const servers: FakeOpenApiServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.stop()));
});

async function server(opts: Parameters<typeof startFakeOpenApiServer>[0] = {}) {
  const s = await startFakeOpenApiServer(opts);
  servers.push(s);
  return s;
}

interface OpenOpts {
  auth?: () => Promise<AuthInjection>;
  onUnauthorized?: () => Promise<void>;
  connector?: Connector;
}

async function open(endpoint: Record<string, unknown>, o: OpenOpts = {}) {
  const c = o.connector ?? createOpenApiConnector({ log, allowInsecureLoopback: true });
  return c.open({
    endpoint: c.endpointSchema.parse(endpoint),
    auth: o.auth ?? (async () => ({ headers: { "X-API-Key": KEY } })),
    onUnauthorized: o.onUnauthorized ?? (async () => {}),
    signal: new AbortController().signal,
  });
}

const signal = () => new AbortController().signal;
const text = (r: ToolResult) => r.content.map((c) => (c.type === "text" ? c.text : "")).join("");

async function failure(p: Promise<unknown>): Promise<ToolError> {
  const e = await p.then(
    () => undefined,
    (err: unknown) => err,
  );
  expect(e).toBeInstanceOf(ToolError);
  return e as ToolError;
}

/** 先 listTools 取该工具的定义（内核会传已复核的快照定义），再带着 ctx.spec 调用。 */
async function call(s: ConnectorSession, name: string, input: unknown): Promise<ToolResult> {
  const spec = (await s.listTools()).find((t) => t.name === name);
  return s.callTool(name, input, signal(), spec ? { spec } : undefined);
}

/** 取文档发生在 listTools。 */
const list = (endpoint: Record<string, unknown>, o: OpenOpts = {}) =>
  withSession(endpoint, (s) => s.listTools(), o);

async function withSession<T>(
  endpoint: Record<string, unknown>,
  fn: (s: ConnectorSession) => Promise<T>,
  o: OpenOpts = {},
): Promise<T> {
  const s = await open(endpoint, o);
  try {
    return await fn(s);
  } finally {
    await s.close();
  }
}

describe("取文档", () => {
  it("从 specUrl 取文档（不带凭据）并列出工具", async () => {
    const api = await server({ apiKey: KEY });
    const tools = await withSession({ specUrl: api.specUrl }, (s) => s.listTools());
    expect(tools).toHaveLength(10);
    const specReq = api.requests.find((r) => r.path === "/openapi.json");
    expect(specReq?.headers["x-api-key"]).toBeUndefined();
  });

  it("文档地址 3xx → 不跟随，报错", async () => {
    const api = await server({ specRedirect: true });
    const e = await failure(list({ specUrl: api.specUrl }));
    expect(e.message).toMatch(/redirect/i);
    expect(api.requests.map((r) => r.path)).toEqual(["/openapi.json"]);
  });

  it("文档地址 404 → error；5xx → unavailable", async () => {
    const api = await server();
    const e = await failure(list({ specUrl: `${api.url}/missing.json` }));
    expect(e.message).toContain("HTTP 404");
    expect(e.kind).toBe("error");
    const e5 = await failure(list({ specUrl: `${api.url}/v1/boom` }));
    expect(e5.kind).toBe("unavailable");
  });

  it("文档超过大小上限 → 报错", async () => {
    const api = await server({
      spec: () => ({ ...defaultFakeOpenApiSpec("http://127.0.0.1:1"), pad: "x".repeat(5000) }),
    });
    const small = createOpenApiConnector({
      log,
      allowInsecureLoopback: true,
      limits: { maxSpecBytes: 4096 },
    });
    const e = await failure(list({ specUrl: api.specUrl }, { connector: small }));
    expect(e.message).toMatch(/larger than/);
  });

  it("连不上文档地址 → unavailable", async () => {
    const api = await server();
    const url = api.specUrl;
    await api.stop();
    servers.splice(servers.indexOf(api), 1);
    const e = await failure(list({ specUrl: url }));
    expect(e.kind).toBe("unavailable");
  });
});

describe("按已复核的定义路由（Ruling A21）", () => {
  it("listTools 的定义带 connectorData（方法、路径、参数位置、请求体、解析后的服务器地址）", async () => {
    const api = await server();
    const tools = await withSession({ specUrl: api.specUrl }, (s) => s.listTools());
    const get = tools.find((t) => t.name === "getPet");
    expect(get?.connectorData).toEqual({
      method: "get",
      path: "/pets/{petId}",
      server: `${api.url}/v1`,
      params: [{ name: "petId", in: "path", style: "simple", explode: false, json: false }],
    });
    expect(tools.find((t) => t.name === "createPet")?.connectorData?.body).toEqual({
      mediaType: "application/json",
      json: true,
      required: true,
    });
  });

  it("调用只按 ctx.spec 路由、不再取文档：远端把 GET 改成 DELETE / 换路径后仍走复核过的路由", async () => {
    const api = await server();
    const reviewed = await withSession({ specUrl: api.specUrl }, (s) => s.listTools());
    const getPet = reviewed.find((t) => t.name === "getPet");
    if (!getPet) throw new Error("no getPet");
    const doc = defaultFakeOpenApiSpec(api.url) as { paths: Record<string, unknown> };
    doc.paths["/pets/{petId}"] = {
      parameters: [{ name: "petId", in: "path", required: true, schema: { type: "integer" } }],
      delete: { operationId: "getPet", summary: "Get a pet by id" },
    };
    api.setSpec(doc);
    const before = api.requests.length;
    await withSession({ specUrl: api.specUrl }, (s) =>
      s.callTool("getPet", { path: { petId: 7 } }, signal(), { spec: getPet }),
    );
    expect(api.requests.slice(before).map((r) => `${r.method} ${r.path}`)).toEqual([
      "GET /v1/pets/7",
    ]);
    // 重新列出的定义变了（指纹随之变化 → 内核漂移复核）
    const fresh = await withSession({ specUrl: api.specUrl }, (s) => s.listTools());
    expect(fresh.find((t) => t.name === "getPet")?.connectorData?.method).toBe("delete");
  });

  it("没有 ctx.spec / connectorData 不合规 → 提示刷新应用", async () => {
    const api = await server();
    await withSession({ specUrl: api.specUrl }, async (s) => {
      const e = await failure(s.callTool("getPet", { path: { petId: 1 } }, signal()));
      expect(e.message).toMatch(/refresh/);
      const spec = { name: "getPet", description: "x", inputSchema: {}, connectorData: { v: 0 } };
      const bad = await failure(s.callTool("getPet", {}, signal(), { spec }));
      expect(bad.message).toMatch(/refresh/);
    });
  });
});

describe("调用", () => {
  it("CRUD：注入 API key 头，结果带状态、content-type 与美化的 JSON", async () => {
    const api = await server({ apiKey: KEY });
    await withSession({ specUrl: api.specUrl }, async (s) => {
      const created = await call(s, "createPet", { body: { name: "Rex", tag: "dog" } });
      expect(created.isError).toBeUndefined();
      expect(text(created)).toContain("HTTP 201");
      expect(text(created)).toContain("content-type: application/json");
      expect(text(created)).toContain('{\n  "id": 1,\n  "name": "Rex",\n  "tag": "dog"\n}');
      await call(s, "createPet", { body: { name: "Tom", tag: "cat" } });
      await call(s, "createPet", { body: { name: "Fido", tag: "dog" } });

      const got = await call(s, "getPet", { path: { petId: 1 } });
      expect(text(got)).toContain('"name": "Rex"');

      const list = await call(s, "listPets", { query: { tags: ["dog", "bird"], limit: 5 } });
      expect(JSON.parse(text(list).split("\n\n").slice(1).join("\n\n"))).toHaveLength(2);
      expect(api.requests.at(-1)?.query).toBe("limit=5&tags=dog&tags=bird");

      const upd = await call(s, "updatePet", { path: { petId: 2 }, body: { name: "Tommy" } });
      expect(text(upd)).toContain('"name": "Tommy"');
      const del = await call(s, "deletePet", { path: { petId: 1 } });
      expect(text(del)).toContain("HTTP 204");
      expect(api.pets().map((p) => p.name)).toEqual(["Tommy", "Fido"]);

      const gone = await call(s, "getPet", { path: { petId: 1 } });
      expect(gone.isError).toBe(true);
      expect(text(gone)).toContain("HTTP 404");
      expect(text(gone)).toContain("pet 1 not found");
    });
    const apiReqs = api.requests.filter((r) => r.path.startsWith("/v1/"));
    expect(apiReqs.every((r) => r.headers["x-api-key"] === KEY)).toBe(true);
    const post = apiReqs.find((r) => r.method === "POST");
    expect(post?.headers["content-type"]).toBe("application/json");
  });

  it("API key 在 query 里", async () => {
    const api = await server({ apiKey: KEY, apiKeyIn: "query" });
    await withSession(
      { specUrl: api.specUrl },
      async (s) => {
        const r = await call(s, "listPets", { query: { limit: 1 } });
        expect(r.isError).toBeUndefined();
      },
      { auth: async () => ({ headers: {}, query: { api_key: KEY } }) },
    );
    expect(api.requests.at(-1)?.query).toBe(`limit=1&api_key=${KEY}`);
  });

  it("baseUrl 覆盖 servers；servers 里的变量取默认值", async () => {
    const api = await server();
    await withSession({ specUrl: api.specUrl }, (s) => call(s, "boom", {})).catch(() => {});
    expect(api.requests.at(-1)?.path).toBe("/v1/boom");
    const other = await server();
    await withSession({ specUrl: api.specUrl, baseUrl: `${other.url}/v1` }, (s) =>
      call(s, "listPets", {}),
    );
    expect(other.requests.at(-1)?.path).toBe("/v1/pets");
  });

  it("参数序列化：explode=false 逗号拼接、deepObject、声明的头", async () => {
    const api = await server();
    const r = await withSession({ specUrl: api.specUrl }, (s) =>
      call(s, "echo", {
        query: { ids: [1, 2, 3], filter: { kind: "a b", owner: "me" } },
        headers: { "X-Trace-Id": "t-1" },
      }),
    );
    const req = api.requests.at(-1);
    expect(req?.query).toBe("ids=1%2C2%2C3&filter%5Bkind%5D=a+b&filter%5Bowner%5D=me");
    expect(req?.headers["x-trace-id"]).toBe("t-1");
    expect(text(r)).toContain('"trace": "t-1"');
  });

  it("路径参数编码；`.` / `..` 拒绝", async () => {
    const api = await server();
    await withSession({ specUrl: api.specUrl }, async (s) => {
      await call(s, "getPet", { path: { petId: "a/b?c" } });
      expect(api.requests.at(-1)?.path).toBe("/v1/pets/a%2Fb%3Fc");
      const e = await failure(call(s, "getPet", { path: { petId: ".." } }));
      expect(e.message).toContain("petId");
      const missing = await failure(call(s, "getPet", {}));
      expect(missing.message).toContain("path.petId");
    });
  });

  it("多个参数拼出的 `.` / `..` 段（含 %2e 形式）一律拒绝", async () => {
    const api = await server({
      spec: (base) => ({
        openapi: "3.1.0",
        info: { title: "x", version: "1" },
        servers: [{ url: `${base}/v1` }],
        paths: { "/files/{a}{b}/raw": { get: { operationId: "raw" } } },
      }),
    });
    await withSession({ specUrl: api.specUrl }, async (s) => {
      for (const [a, b] of [
        [".", "."],
        ["%2e", "."],
        ["%2E", "%2e"],
      ]) {
        const e = await failure(call(s, "raw", { path: { a, b } }));
        expect(e.message).toMatch(/\.\./);
        expect(e.kind).toBe("error");
      }
      await call(s, "raw", { path: { a: "x", b: "." } });
    });
    expect(api.requests.filter((r) => r.path.startsWith("/v1/")).map((r) => r.path)).toEqual([
      "/v1/files/x./raw",
    ]);
  });

  it("请求构造错误（如 GET 带请求体）→ ToolError kind error，不计入熔断", async () => {
    const api = await server();
    const spec = {
      name: "listPets",
      description: "x",
      inputSchema: {},
      connectorData: {
        method: "get",
        path: "/pets",
        server: `${api.url}/v1`,
        params: [],
        body: { mediaType: "application/json", json: true, required: false },
      },
    };
    const e = await failure(
      withSession({ specUrl: api.specUrl }, (s) =>
        s.callTool("listPets", { body: { a: 1 } }, signal(), { spec }),
      ),
    );
    expect(e.kind).toBe("error");
    expect(e.message).toMatch(/could not be sent/i);
  });

  it("server / baseUrl 带用户信息 → ToolError，不发请求", async () => {
    const api = await server();
    const spec = {
      name: "listPets",
      description: "x",
      inputSchema: {},
      connectorData: {
        method: "get",
        path: "/pets",
        server: api.url.replace("http://", "http://u:p@"),
        params: [],
      },
    };
    const e = await failure(
      withSession({ specUrl: api.specUrl }, (s) => s.callTool("listPets", {}, signal(), { spec })),
    );
    expect(e.kind).toBe("error");
    expect(e.message).toMatch(/user name or password/);
    expect(e.message).not.toContain("u:p");
  });

  it("工具参数不能设置 Authorization / Cookie 等头，也不能设置未声明的头", async () => {
    const api = await server();
    await withSession({ specUrl: api.specUrl }, async (s) => {
      for (const h of ["Authorization", "cookie", "X-Other"]) {
        const e = await failure(call(s, "echo", { headers: { [h]: "x" } }));
        expect(e.message).toContain(h);
      }
    });
    expect(api.requests.filter((r) => r.path === "/v1/echo")).toHaveLength(0);
  });

  it("头值含换行 / 非 Latin-1 字符 → 明确错误", async () => {
    const api = await server();
    await withSession({ specUrl: api.specUrl }, async (s) => {
      for (const v of ["a\r\nX-Injected: 1", "中文"]) {
        const e = await failure(call(s, "echo", { headers: { "X-Trace-Id": v } }));
        expect(e.message).toContain("X-Trace-Id");
      }
    });
    expect(api.requests.filter((r) => r.path === "/v1/echo")).toHaveLength(0);
  });

  it("文本请求体与二进制响应", async () => {
    const api = await server();
    await withSession({ specUrl: api.specUrl }, async (s) => {
      const note = await call(s, "createNote", { body: "hello" });
      expect(api.requests.at(-1)?.headers["content-type"]).toBe("text/plain");
      expect(text(note)).toContain("stored: hello");
      await call(s, "createPet", { body: { name: "Rex" } });
      const photo = await call(s, "getPetPhoto", { path: { petId: 1 } });
      expect(text(photo)).toMatch(/Binary response body \(image\/png, \d+ bytes\) omitted/);
    });
  });

  it("401 → onUnauthorized 一次后用新凭据重试；仍 401 → 认证失败", async () => {
    const api = await server({ apiKey: KEY });
    let key = "stale-key-000000";
    let refreshed = 0;
    const opts: OpenOpts = {
      auth: async () => ({ headers: { "X-API-Key": key } }),
      onUnauthorized: async () => {
        refreshed++;
        key = KEY;
      },
    };
    const r = await withSession({ specUrl: api.specUrl }, (s) => call(s, "listPets", {}), opts);
    expect(r.isError).toBeUndefined();
    expect(refreshed).toBe(1);

    key = "stale-key-000000";
    const never: OpenOpts = { ...opts, onUnauthorized: async () => void refreshed++ };
    const e = await failure(
      withSession({ specUrl: api.specUrl }, (s) => call(s, "listPets", {}), never),
    );
    expect(e.message).toContain("Authentication failed");
    expect(e.kind).toBe("error");
    expect(refreshed).toBe(2);
  });

  it("5xx → ToolError unavailable（带状态与截断的正文）；3xx 不跟随", async () => {
    const api = await server();
    await withSession({ specUrl: api.specUrl }, async (s) => {
      const e = await failure(call(s, "boom", {}));
      expect(e.kind).toBe("unavailable");
      expect(e.message).toContain("HTTP 500");
      expect(e.message).toContain("boom");
      const r = await failure(call(s, "moved", {}));
      expect(r.message).toMatch(/redirect/i);
      expect(r.kind).toBe("error");
    });
    expect(api.requests.filter((x) => x.path === "/v1/moved")).toHaveLength(1);
  });

  it("连不上 API → unavailable", async () => {
    const api = await server();
    const dead = await server();
    const url = dead.url;
    await dead.stop();
    servers.splice(servers.indexOf(dead), 1);
    const e = await failure(
      withSession({ specUrl: api.specUrl, baseUrl: `${url}/v1` }, (s) => call(s, "listPets", {})),
    );
    expect(e.kind).toBe("unavailable");
  });

  it("未知工具 → 明确错误", async () => {
    const api = await server();
    const e = await failure(withSession({ specUrl: api.specUrl }, (s) => call(s, "nope", {})));
    expect(e.message).toContain("nope");
  });

  it("工具名撞车：listTools 照样返回（内核给后者写原因），调用走第一个", async () => {
    const api = await server({
      spec: (base) => ({
        openapi: "3.1.0",
        info: { title: "x", version: "1" },
        servers: [{ url: `${base}/v1` }],
        paths: {
          "/pets": { get: { operationId: "pets.list" } },
          "/boom": { get: { operationId: "pets list" } },
        },
      }),
    });
    await withSession({ specUrl: api.specUrl }, async (s) => {
      expect((await s.listTools()).map((t) => t.name)).toEqual(["pets_list", "pets_list"]);
      await call(s, "pets_list", {});
    });
    expect(api.requests.at(-1)?.path).toBe("/v1/pets");
  });

  it("未勾选的操作不能调用", async () => {
    const api = await server();
    const e = await failure(
      withSession({ specUrl: api.specUrl, operations: ["listPets"] }, (s) =>
        call(s, "deletePet", { path: { petId: 1 } }),
      ),
    );
    expect(e.message).toContain("deletePet");
  });

  it("文档里的 server 不是 https（也不是允许的本机 http）→ 拒绝调用", async () => {
    const api = await server({
      spec: (base) => ({
        ...defaultFakeOpenApiSpec(base),
        servers: [{ url: "http://api.example.com/v1" }],
      }),
    });
    const e = await failure(withSession({ specUrl: api.specUrl }, (s) => call(s, "listPets", {})));
    expect(e.message).toMatch(/https/);
  });

  it("相对 server 地址按文档地址解析；specText 且无 server / baseUrl → 提示提供 baseUrl", async () => {
    const api = await server({
      spec: (base) => ({ ...defaultFakeOpenApiSpec(base), servers: [{ url: "/v1" }] }),
    });
    await withSession({ specUrl: api.specUrl }, (s) => call(s, "listPets", {}));
    expect(api.requests.at(-1)?.path).toBe("/v1/pets");

    const spec = { ...defaultFakeOpenApiSpec(api.url) } as Record<string, unknown>;
    delete spec.servers;
    const e = await failure(
      withSession({ specText: JSON.stringify(spec) }, (s) => call(s, "listPets", {})),
    );
    expect(e.message).toContain("baseUrl");
  });

  it("响应正文超过上限 → 截断并注明", async () => {
    const big = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("z".repeat(10_000));
    });
    await new Promise<void>((r) => big.listen(0, "127.0.0.1", r));
    const port = (big.address() as AddressInfo).port;
    try {
      const c = createOpenApiConnector({
        log,
        allowInsecureLoopback: true,
        limits: { maxResponseBytes: 1000 },
      });
      const spec = {
        openapi: "3.1.0",
        info: { title: "x", version: "1" },
        servers: [{ url: `http://127.0.0.1:${port}` }],
        paths: { "/big": { get: { operationId: "big" } } },
      };
      const r = await withSession({ specText: JSON.stringify(spec) }, (s) => call(s, "big", {}), {
        connector: c,
      });
      expect(text(r)).toContain("z".repeat(1000));
      expect(text(r)).not.toContain("z".repeat(1001));
      expect(text(r)).toMatch(/truncated/i);
    } finally {
      big.closeAllConnections();
      await new Promise((r) => big.close(r));
    }
  });
});
