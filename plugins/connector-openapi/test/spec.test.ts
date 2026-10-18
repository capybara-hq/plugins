import {
  type AuthInjection,
  type Connector,
  ToolError,
  type ToolSpec,
} from "@capybara-hq/plugin-sdk";
import { defaultFakeOpenApiSpec } from "@capybara-hq/testing";
import { describe, expect, it } from "vitest";
import { createOpenApiConnector } from "../src/connector.js";

/** 不起服务、只用 specText 的用例：文档解析、dereference、工具映射与 inspect。 */

const log = { info() {}, warn() {}, error() {} };
const connector = (): Connector => createOpenApiConnector({ log, allowInsecureLoopback: true });

async function listTools(
  spec: unknown,
  extra: Record<string, unknown> = {},
  c = connector(),
): Promise<ToolSpec[]> {
  const specText = typeof spec === "string" ? spec : JSON.stringify(spec);
  const endpoint = c.endpointSchema.parse({ specText, ...extra });
  const s = await c.open({
    endpoint,
    auth: async (): Promise<AuthInjection> => ({ headers: {} }),
    onUnauthorized: async () => {},
    signal: new AbortController().signal,
  });
  try {
    return await s.listTools();
  } finally {
    await s.close();
  }
}

async function failure(p: Promise<unknown>): Promise<ToolError> {
  const e = await p.then(
    () => undefined,
    (err: unknown) => err,
  );
  expect(e).toBeInstanceOf(ToolError);
  return e as ToolError;
}

const BASE = "http://127.0.0.1:9";
const doc = () => defaultFakeOpenApiSpec(BASE);
const byName = (tools: ToolSpec[], name: string) => {
  const t = tools.find((x) => x.name === name);
  if (!t) throw new Error(`no tool ${name}`);
  return t;
};

describe("工具映射", () => {
  it("每个 operation 一个工具：名 = operationId，注解按方法", async () => {
    const tools = await listTools(doc());
    expect(tools.map((t) => t.name)).toEqual([
      "listPets",
      "createPet",
      "getPet",
      "updatePet",
      "deletePet",
      "getPetPhoto",
      "echo",
      "createNote",
      "boom",
      "moved",
    ]);
    expect(byName(tools, "listPets").annotations).toEqual({ readOnlyHint: true });
    expect(byName(tools, "deletePet").annotations).toEqual({ destructiveHint: true });
    expect(byName(tools, "createPet").annotations).toBeUndefined();
    expect(byName(tools, "updatePet").annotations).toBeUndefined();
  });

  it("inputSchema：path / query / headers / body 只含实际存在的部分，内部 $ref 已展开", async () => {
    const tools = await listTools(doc());
    expect(byName(tools, "getPet").inputSchema).toEqual({
      type: "object",
      properties: {
        path: {
          type: "object",
          properties: { petId: { type: "integer", description: "The pet id" } },
          required: ["petId"],
          additionalProperties: false,
        },
      },
      required: ["path"],
      additionalProperties: false,
    });
    const create = byName(tools, "createPet").inputSchema;
    expect(create.required).toEqual(["body"]);
    // 3.0 的 nullable 转成 JSON Schema 的类型数组
    expect((create.properties as Record<string, unknown>).body).toEqual({
      type: "object",
      required: ["name"],
      properties: { name: { type: "string" }, tag: { type: ["string", "null"] } },
    });
    const list = byName(tools, "listPets").inputSchema;
    expect(list.required).toBeUndefined();
    expect((list.properties as Record<string, { properties: unknown }>).query?.properties).toEqual({
      limit: { type: "integer", minimum: 1, description: "Maximum number of pets to return" },
      tags: {
        type: "array",
        items: { type: "string" },
        description: "Only pets with one of these tags",
      },
    });
    const echo = byName(tools, "echo").inputSchema.properties as Record<string, unknown>;
    expect(echo.headers).toEqual({
      type: "object",
      properties: { "X-Trace-Id": { type: "string" } },
      additionalProperties: false,
    });
    // 非 JSON 请求体 → 字符串
    const note = byName(tools, "createNote").inputSchema.properties as Record<string, unknown>;
    expect(note.body).toMatchObject({ type: "string" });
    expect(JSON.stringify(note.body)).toContain("text/plain");
    // 没有参数的操作：空对象
    expect(byName(tools, "boom").inputSchema).toEqual({
      type: "object",
      properties: {},
      additionalProperties: false,
    });
  });

  it("描述 = summary + description + 方法与路径；超过 1024 字符截断并注明", async () => {
    const tools = await listTools(doc());
    const d = byName(tools, "listPets").description;
    expect(d).toContain("List pets");
    expect(d).toContain("Returns all pets, optionally filtered by tag.");
    expect(d).toContain("GET /pets");
    const long = doc();
    (long.paths as Record<string, Record<string, unknown>>)["/boom"] = {
      get: {
        operationId: "boom",
        summary: "Fails",
        description: "y".repeat(5000),
        responses: {},
      },
    };
    const t = byName(await listTools(long), "boom");
    expect(t.description).toContain("[Description truncated]");
    expect(t.description).toContain("GET /boom");
    expect(t.description.length).toBeLessThan(1200);
    // 既无 summary 也无 description：给出方法与路径
    const bare = {
      openapi: "3.1.0",
      info: { title: "x", version: "1" },
      paths: { "/x": { post: { operationId: "doX" } } },
    };
    expect(byName(await listTools(bare), "doX").description).toContain("POST /x");
  });

  it("operations 只保留勾选的操作", async () => {
    const tools = await listTools(doc(), { operations: ["getPet", "listPets", "gone"] });
    expect(tools.map((t) => t.name)).toEqual(["listPets", "getPet"]);
  });

  it("工具名：非法字符换下划线、超过 40 截断；缺 operationId 时由方法与路径生成", async () => {
    const spec = {
      openapi: "3.1.0",
      info: { title: "x", version: "1" },
      paths: {
        "/users/{userId}/repos": {
          get: { responses: {} },
          post: { operationId: "repos.create (v2)!", responses: {} },
          put: { operationId: "a".repeat(60), responses: {} },
        },
      },
    };
    const names = (await listTools(spec)).map((t) => t.name);
    expect(names).toEqual(["get_users_userId_repos", "repos_create_v2", "a".repeat(40)]);
    for (const n of names) expect(n).toMatch(/^[a-zA-Z0-9_-]{1,40}$/);
  });

  it("YAML 文档；OpenAPI 3.1 的类型数组原样保留", async () => {
    const yaml = [
      "openapi: 3.1.0",
      "info: { title: y, version: '1' }",
      "paths:",
      "  /things/{id}:",
      "    get:",
      "      operationId: getThing",
      "      parameters:",
      "        - { name: id, in: path, required: true, schema: { type: [string, 'null'] } }",
      "      responses: {}",
    ].join("\n");
    const t = byName(await listTools(yaml), "getThing");
    expect(t.inputSchema.properties).toEqual({
      path: {
        type: "object",
        properties: { id: { type: ["string", "null"] } },
        required: ["id"],
        additionalProperties: false,
      },
    });
  });

  it("循环引用：在环上换成宽松模式，结果可 JSON 序列化", async () => {
    const spec = {
      openapi: "3.0.3",
      info: { title: "x", version: "1" },
      paths: {
        "/nodes": {
          post: {
            operationId: "createNode",
            requestBody: {
              content: { "application/json": { schema: { $ref: "#/components/schemas/Node" } } },
            },
          },
        },
      },
      components: {
        schemas: {
          Node: {
            type: "object",
            properties: {
              name: { type: "string" },
              children: { type: "array", items: { $ref: "#/components/schemas/Node" } },
            },
          },
        },
      },
    };
    const t = byName(await listTools(spec), "createNode");
    const s = JSON.stringify(t.inputSchema);
    expect(s).not.toContain("$ref");
    expect(s).toContain("Recursive");
  });

  it("3.0 的布尔 exclusiveMinimum / exclusiveMaximum 转成数值形式", async () => {
    const spec = {
      openapi: "3.0.3",
      info: { title: "x", version: "1" },
      paths: {
        "/n": {
          get: {
            operationId: "n",
            parameters: [
              {
                name: "v",
                in: "query",
                schema: {
                  type: "number",
                  minimum: 0,
                  exclusiveMinimum: true,
                  maximum: 10,
                  exclusiveMaximum: false,
                },
              },
            ],
          },
        },
      },
    };
    const t = byName(await listTools(spec), "n");
    expect(
      (t.inputSchema.properties as Record<string, { properties: unknown }>).query?.properties,
    ).toEqual({ v: { type: "number", exclusiveMinimum: 0, maximum: 10 } });
  });
});

describe("文档错误", () => {
  it("Swagger 2.0 → 明确错误", async () => {
    const e = await failure(listTools({ swagger: "2.0", info: {}, paths: {} }));
    expect(e.message).toMatch(/Swagger 2\.0/);
    expect(e.message).toMatch(/OpenAPI 3\.0 or 3\.1/);
    expect(e.kind).toBe("error");
  });

  it("不支持的版本 / 不是 OpenAPI / 解析失败", async () => {
    expect((await failure(listTools({ openapi: "4.0.0", paths: {} }))).message).toMatch(
      /OpenAPI 3\.0 or 3\.1/,
    );
    expect((await failure(listTools({ hello: "world" }))).message).toMatch(/OpenAPI/);
    expect((await failure(listTools("{ not json: [ unclosed"))).message).toMatch(/JSON or YAML/);
  });

  it("外部 $ref 一律拒绝（不去取）", async () => {
    for (const ref of [
      "http://127.0.0.1:1/schemas.json#/Pet",
      "./schemas.yaml#/Pet",
      "file:///etc/passwd",
    ]) {
      const spec = {
        openapi: "3.1.0",
        info: { title: "x", version: "1" },
        paths: {
          "/p": {
            post: {
              operationId: "p",
              requestBody: { content: { "application/json": { schema: { $ref: ref } } } },
            },
          },
        },
      };
      const e = await failure(listTools(spec));
      expect(e.message).toContain("external");
      expect(e.message).toContain(ref);
    }
  });

  it("指向不存在的内部 $ref → 明确错误", async () => {
    const spec = {
      openapi: "3.1.0",
      info: { title: "x", version: "1" },
      paths: { "/p": { get: { operationId: "p", parameters: [{ $ref: "#/nope/x" }] } } },
    };
    expect((await failure(listTools(spec))).message).toContain("#/nope/x");
  });
});

describe("inspect", () => {
  it("securitySchemes → AuthHint；操作清单（不受 operations 限制）", async () => {
    const spec = doc();
    (spec.components as Record<string, unknown>).securitySchemes = {
      key: { type: "apiKey", in: "header", name: "X-API-Key", description: "Your key" },
      q: { type: "apiKey", in: "query", name: "api_key" },
      c: { type: "apiKey", in: "cookie", name: "sid" },
      bearer: { type: "http", scheme: "Bearer", bearerFormat: "JWT" },
      basic: { type: "http", scheme: "basic" },
      digest: { type: "http", scheme: "digest" },
      oauth: {
        type: "oauth2",
        flows: {
          clientCredentials: {
            tokenUrl: "https://auth.example.com/token",
            scopes: { read: "Read", write: "Write" },
          },
          authorizationCode: {
            authorizationUrl: "https://auth.example.com/authorize",
            tokenUrl: "https://auth.example.com/token",
            scopes: { read: "Read" },
          },
          implicit: { authorizationUrl: "https://auth.example.com/authorize", scopes: {} },
        },
      },
      oidc: { type: "openIdConnect", openIdConnectUrl: "https://auth.example.com/.well-known" },
    };
    const c = connector();
    const r = await c.inspect?.({
      endpoint: c.endpointSchema.parse({ specText: JSON.stringify(spec), operations: ["getPet"] }),
      signal: new AbortController().signal,
    });
    expect(r?.authHints).toEqual([
      { scheme: "key", description: "Your key", type: "api_key", in: "header", name: "X-API-Key" },
      { scheme: "q", type: "api_key", in: "query", name: "api_key" },
      { scheme: "bearer", type: "bearer" },
      { scheme: "basic", type: "basic" },
      {
        scheme: "oauth",
        type: "oauth_client",
        tokenUrl: "https://auth.example.com/token",
        scopes: ["read", "write"],
      },
      {
        scheme: "oauth",
        type: "oauth_code",
        authorizationUrl: "https://auth.example.com/authorize",
        tokenUrl: "https://auth.example.com/token",
        scopes: ["read"],
      },
    ]);
    expect(r?.operations?.length).toBe(10);
    expect(r?.operations?.[0]).toEqual({
      id: "listPets",
      method: "GET",
      path: "/pets",
      summary: "List pets",
    });
  });
});
