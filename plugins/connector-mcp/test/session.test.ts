import type { AuthInjection, ConnectorSession, Logger } from "@capybara-hq/plugin-sdk";
import { ToolError } from "@capybara-hq/plugin-sdk";
import {
  type FakeMcpServer,
  type FakeMcpServerOptions,
  startFakeMcpServer,
} from "@capybara-hq/testing";
import { afterEach, describe, expect, it } from "vitest";
import { AUTH_FAILED_TEXT, createMcpConnector } from "../src/session.js";

/** 记录日志的 logger。 */
function memLog(): Logger & { lines: { level: string; msg: string; fields?: unknown }[] } {
  const lines: { level: string; msg: string; fields?: unknown }[] = [];
  return {
    lines,
    info: (msg, fields) => lines.push({ level: "info", msg, fields }),
    warn: (msg, fields) => lines.push({ level: "warn", msg, fields }),
    error: (msg, fields) => lines.push({ level: "error", msg, fields }),
  };
}

const servers: FakeMcpServer[] = [];
const sessions: ConnectorSession[] = [];
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((s) => s.close().catch(() => {})));
  await Promise.all(servers.splice(0).map((s) => s.stop()));
});

async function fake(opts: FakeMcpServerOptions): Promise<FakeMcpServer> {
  const s = await startFakeMcpServer(opts);
  servers.push(s);
  return s;
}

interface OpenOpts {
  auth?: () => Promise<AuthInjection>;
  onUnauthorized?: () => Promise<void>;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  log?: Logger;
}

async function open(server: FakeMcpServer, o: OpenOpts = {}): Promise<ConnectorSession> {
  const c = createMcpConnector({ log: o.log ?? memLog() });
  const s = await c.open({
    endpoint: c.endpointSchema.parse({ url: server.url, headers: o.headers ?? {} }),
    auth: o.auth ?? (async () => ({ headers: {} })),
    onUnauthorized: o.onUnauthorized ?? (async () => {}),
    signal: o.signal ?? new AbortController().signal,
  });
  sessions.push(s);
  return s;
}

describe("endpointSchema", () => {
  const schema = createMcpConnector({ log: memLog() }).endpointSchema;

  it("https 与本机 http 合法；headers 默认 {}", () => {
    expect(schema.parse({ url: "https://mcp.example.com/mcp" })).toEqual({
      url: "https://mcp.example.com/mcp",
      headers: {},
    });
    expect(schema.safeParse({ url: "http://127.0.0.1:8080/mcp" }).success).toBe(true);
    expect(schema.safeParse({ url: "http://localhost:3000/mcp" }).success).toBe(true);
  });

  it("其他 http / 协议 → 英文错误", () => {
    for (const url of ["http://mcp.example.com/mcp", "ftp://x.example.com", "not a url"]) {
      const r = schema.safeParse({ url });
      expect(r.success, url).toBe(false);
    }
    const r = schema.safeParse({ url: "http://mcp.example.com/mcp" });
    expect(r.error?.issues[0]?.message).toBe(
      "URL must use https (plain http is only allowed for 127.0.0.1 and localhost)",
    );
  });

  it("固定头里不能放凭据头", () => {
    const r = schema.safeParse({
      url: "https://mcp.example.com/mcp",
      headers: { Authorization: "Bearer x" },
    });
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.message).toMatch(/credential/i);
  });
});

describe("listTools 映射", () => {
  it("name / description / inputSchema / annotations；_meta 的 requiresUserInteraction", async () => {
    const server = await fake({
      tools: [
        {
          name: "search",
          description: "Search docs",
          inputSchema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
          annotations: { readOnlyHint: true, openWorldHint: false, title: "Search" },
        },
        {
          name: "pay",
          description: "Pay an invoice",
          annotations: { destructiveHint: true, idempotentHint: false },
          _meta: { "anthropic/requiresUserInteraction": true },
        },
      ],
    });
    const s = await open(server);
    expect(await s.listTools()).toEqual([
      {
        name: "search",
        description: "Search docs",
        inputSchema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      {
        name: "pay",
        description: "Pay an invoice",
        inputSchema: { type: "object", properties: {} },
        annotations: {
          destructiveHint: true,
          idempotentHint: false,
          requiresUserInteraction: true,
        },
      },
    ]);
  });

  it("缺 description → 用 title 或 name，并 warn", async () => {
    const server = await fake({
      tools: [{ name: "a", title: "Tool A" }, { name: "b" }],
    });
    const log = memLog();
    const s = await open(server, { log });
    const tools = await s.listTools();
    expect(tools.map((t) => t.description)).toEqual(["Tool A", "b"]);
    expect(tools[0]).not.toHaveProperty("annotations");
    const warns = log.lines.filter((l) => l.level === "warn");
    expect(warns).toHaveLength(2);
    expect(warns[0]?.fields).toMatchObject({ tool: "a" });
  });
});

describe("callTool 映射", () => {
  it("text / image / resource_link / 嵌入资源 / audio → ToolContent", async () => {
    const server = await fake({
      tools: [
        {
          name: "mixed",
          description: "d",
          handler: () => ({
            content: [
              { type: "text", text: "hello" },
              { type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" },
              {
                type: "resource_link",
                uri: "file:///a.txt",
                name: "a.txt",
                mimeType: "text/plain",
              },
              { type: "resource", resource: { uri: "file:///b.md", text: "# B" } },
              {
                type: "resource",
                resource: { uri: "file:///c.bin", blob: "AAAA", mimeType: "application/zip" },
              },
              { type: "audio", mimeType: "audio/wav", data: "UklGRg==" },
            ],
          }),
        },
      ],
    });
    const s = await open(server);
    const r = await s.callTool("mixed", { x: 1 }, new AbortController().signal);
    expect(server.calls.map((c) => c.args)).toEqual([{ x: 1 }]);
    expect(r).toEqual({
      content: [
        { type: "text", text: "hello" },
        { type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" },
        { type: "resource_link", uri: "file:///a.txt", name: "a.txt", mimeType: "text/plain" },
        { type: "text", text: "Resource file:///b.md:\n# B" },
        {
          type: "text",
          text: "[Binary resource file:///c.bin (application/zip, 3 bytes) omitted]",
        },
        { type: "text", text: "[Audio content (audio/wav) omitted]" },
      ],
    });
  });

  it("isError 原样；只有 structuredContent 时转成 JSON 文本", async () => {
    const server = await fake({
      tools: [
        {
          name: "bad",
          description: "d",
          handler: () => ({ content: [{ type: "text", text: "nope" }], isError: true }),
        },
        {
          name: "structured",
          description: "d",
          handler: () => ({ content: [], structuredContent: { n: 1 } }),
        },
      ],
    });
    const s = await open(server);
    const signal = new AbortController().signal;
    expect(await s.callTool("bad", {}, signal)).toEqual({
      content: [{ type: "text", text: "nope" }],
      isError: true,
    });
    expect(await s.callTool("structured", {}, signal)).toEqual({
      content: [{ type: "text", text: '{"n":1}' }],
    });
  });

  it("JSON-RPC 错误 → ToolError（带服务的说明）", async () => {
    const server = await fake({ tools: [] });
    const s = await open(server);
    const err = await s.callTool("missing", {}, new AbortController().signal).catch((e) => e);
    expect(err).toBeInstanceOf(ToolError);
    expect(err.message).toBe("The app returned an error: Unknown tool missing");
  });

  it("HTTP 5xx → ToolError 只带状态码；正文进插件日志（warn）", async () => {
    const server = await fake({
      tools: [{ name: "t", description: "d" }],
      intercept: (r) =>
        r.method === "tools/call" ? { status: 502, body: "upstream exploded" } : undefined,
    });
    const log = memLog();
    const s = await open(server, { log });
    const err = await s.callTool("t", {}, new AbortController().signal).catch((e) => e);
    expect(err).toBeInstanceOf(ToolError);
    expect(err.message).toBe("The app's server responded with HTTP 502.");
    const w = log.lines.find((l) => l.msg === "MCP request failed");
    expect(w?.fields).toMatchObject({ status: 502, body: "upstream exploded" });
  });

  it("signal 中止 → 调用及时结束", async () => {
    const server = await fake({
      tools: [
        {
          name: "slow",
          description: "d",
          handler: async () => {
            await new Promise((r) => setTimeout(r, 5_000));
            return { content: [{ type: "text", text: "late" }] };
          },
        },
      ],
    });
    const s = await open(server);
    const ac = new AbortController();
    const t0 = Date.now();
    const p = s.callTool("slow", {}, ac.signal).catch((e) => e);
    setTimeout(() => ac.abort(), 100);
    const err = await p;
    expect(err).toBeInstanceOf(Error);
    expect(Date.now() - t0).toBeLessThan(2_000);
  });
});

describe("认证", () => {
  it("每个请求前调用 auth() 合并头；端点固定头一并带上；query 注入进 URL", async () => {
    const server = await fake({ tools: [{ name: "t", description: "d" }] });
    let n = 0;
    const s = await open(server, {
      headers: { "X-Tenant": "acme" },
      auth: async () => {
        n++;
        return { headers: { "X-Key": `k${n}` }, query: { key: `q${n}` } };
      },
    });
    await s.listTools();
    await s.callTool("t", {}, new AbortController().signal);
    const posts = server.requests.filter((r) => r.httpMethod === "POST");
    expect(posts.length).toBeGreaterThanOrEqual(4);
    expect(n).toBeGreaterThanOrEqual(posts.length);
    for (const r of posts) expect(r.headers["x-tenant"]).toBe("acme");
    const keys = posts.map((r) => r.headers["x-key"]);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("401 → onUnauthorized 后用新凭据重试一次", async () => {
    const server = await fake({
      tools: [{ name: "t", description: "d" }],
      requireBearer: "new-token",
    });
    let token = "old-token";
    let refreshed = 0;
    const s = await open(server, {
      auth: async () => ({ headers: { Authorization: `Bearer ${token}` } }),
      onUnauthorized: async () => {
        refreshed++;
        token = "new-token";
      },
    });
    expect((await s.listTools()).map((t) => t.name)).toEqual(["t"]);
    expect(refreshed).toBe(1);
  });

  it("重试后仍 401 → ToolError，onUnauthorized 只调一次", async () => {
    const server = await fake({ tools: [], requireBearer: "right" });
    let refreshed = 0;
    const err = await open(server, {
      auth: async () => ({ headers: { Authorization: "Bearer wrong" } }),
      onUnauthorized: async () => {
        refreshed++;
      },
    }).catch((e) => e);
    expect(err).toBeInstanceOf(ToolError);
    expect(err.message).toBe(AUTH_FAILED_TEXT);
    expect(AUTH_FAILED_TEXT).toBe(
      "Authentication failed for this app; ask the user to reconnect it.",
    );
    expect(refreshed).toBe(1);
  });

  it("会话中途 401 也刷新重试", async () => {
    let rejected = 0;
    const server = await fake({
      tools: [{ name: "t", description: "d" }],
      intercept: (r) =>
        r.method === "tools/call" && rejected++ === 0
          ? { status: 401, body: "expired" }
          : undefined,
    });
    let refreshed = 0;
    const s = await open(server, {
      onUnauthorized: async () => {
        refreshed++;
      },
    });
    expect(refreshed).toBe(0);
    const r = await s.callTool("t", {}, new AbortController().signal);
    expect(r.content).toEqual([{ type: "text", text: "ok" }]);
    expect(refreshed).toBe(1);
    expect(server.calls).toHaveLength(1);
  });
});

describe("resources", () => {
  it("服务声明 resources → listResources / readResource 可用", async () => {
    const server = await fake({
      tools: [],
      resources: [
        {
          uri: "docs://a",
          name: "A",
          description: "Doc A",
          mimeType: "text/markdown",
          text: "# A",
        },
        { uri: "docs://img", name: "Img", mimeType: "image/png", blob: "AAAA" },
      ],
    });
    const s = await open(server);
    expect(typeof s.listResources).toBe("function");
    expect(await s.listResources?.()).toEqual([
      { uri: "docs://a", name: "A", description: "Doc A", mimeType: "text/markdown" },
      { uri: "docs://img", name: "Img", mimeType: "image/png" },
    ]);
    expect(await s.readResource?.("docs://a")).toEqual({
      content: [{ type: "text", text: "# A" }],
    });
    expect(await s.readResource?.("docs://img")).toEqual({
      content: [{ type: "image", mimeType: "image/png", data: "AAAA" }],
    });
    const err = await s.readResource?.("docs://missing").catch((e) => e);
    expect(err).toBeInstanceOf(ToolError);
    expect(err.message).toMatch(/Resource not found: docs:\/\/missing/);
  });

  it("服务不支持 resources → 会话没有这两个方法", async () => {
    const server = await fake({ tools: [] });
    const s = await open(server);
    expect(s.listResources).toBeUndefined();
    expect(s.readResource).toBeUndefined();
  });
});
