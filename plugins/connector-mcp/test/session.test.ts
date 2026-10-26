import type {
  AuthInjection,
  ConnectorSession,
  ElicitationRequest,
  ElicitationResponse,
  Logger,
} from "@capybara-hq/plugin-sdk";
import { ToolError } from "@capybara-hq/plugin-sdk";
import {
  type FakeMcpHandlerContext,
  FakeMcpRpcError,
  type FakeMcpServer,
  type FakeMcpServerOptions,
  startFakeMcpServer,
} from "@capybara-hq/testing";
import { afterEach, describe, expect, it } from "vitest";
import { AUTH_FAILED_TEXT, createMcpConnector, redirectText } from "../src/session.js";

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
  onToolsChanged?: () => void;
  onElicit?: (r: ElicitationRequest) => Promise<ElicitationResponse>;
}

async function open(server: FakeMcpServer, o: OpenOpts = {}): Promise<ConnectorSession> {
  const c = createMcpConnector({ log: o.log ?? memLog(), allowInsecureLoopback: true });
  const s = await c.open({
    endpoint: c.endpointSchema.parse({ url: server.url, headers: o.headers ?? {} }),
    auth: o.auth ?? (async () => ({ headers: {} })),
    onUnauthorized: o.onUnauthorized ?? (async () => {}),
    signal: o.signal ?? new AbortController().signal,
    ...(o.onToolsChanged && { onToolsChanged: o.onToolsChanged }),
    ...(o.onElicit && { onElicit: o.onElicit }),
  });
  sessions.push(s);
  return s;
}

describe("endpointSchema", () => {
  const strict = createMcpConnector({ log: memLog() }).endpointSchema;
  const loose = createMcpConnector({ log: memLog(), allowInsecureLoopback: true }).endpointSchema;
  const ok = (schema: typeof strict, url: string) => schema.safeParse({ url }).success;

  it("默认只接受 https；headers 默认 {}", () => {
    expect(strict.parse({ url: "https://mcp.example.com/mcp" })).toEqual({
      url: "https://mcp.example.com/mcp",
      headers: {},
    });
    for (const url of [
      "http://127.0.0.1:8080/mcp",
      "http://localhost:3000/mcp",
      "http://[::1]/mcp",
    ]) {
      expect(ok(strict, url), url).toBe(false);
    }
    expect(strict.safeParse({ url: "http://127.0.0.1/mcp" }).error?.issues[0]?.message).toBe(
      "URL must use https",
    );
  });

  it("allowInsecureLoopback：只放行确切的 127.0.0.1 / localhost / [::1]", () => {
    for (const url of [
      "http://127.0.0.1:8080/mcp",
      "http://localhost:3000/mcp",
      "http://[::1]:9/mcp",
    ]) {
      expect(ok(loose, url), url).toBe(true);
    }
    for (const url of [
      "http://localhost.evil.com/mcp",
      "http://127.0.0.1.nip.io/mcp",
      "http://localhost./mcp",
      "http://127.0.0.2/mcp",
      "http://mcp.example.com/mcp",
      "ftp://x.example.com",
      "not a url",
    ]) {
      expect(ok(loose, url), url).toBe(false);
    }
    expect(
      loose.safeParse({ url: "http://localhost.evil.com/mcp" }).error?.issues[0]?.message,
    ).toBe("URL must use https (plain http is only allowed for 127.0.0.1, localhost and [::1])");
  });

  it("固定头里不能放凭据头", () => {
    const r = strict.safeParse({
      url: "https://mcp.example.com/mcp",
      headers: { Authorization: "Bearer x" },
    });
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.message).toMatch(/credential/i);
  });
});

describe("重定向", () => {
  it("3xx 不跟随 → ToolError，重定向目标收不到请求与凭据头", async () => {
    const target = await fake({ tools: [{ name: "t", description: "d" }] });
    const server = await fake({
      tools: [{ name: "t", description: "d" }],
      intercept: (r) =>
        r.method === "tools/call" ? { status: 307, body: "", location: target.url } : undefined,
    });
    const s = await open(server, { auth: async () => ({ headers: { "X-Api-Key": "k-secret" } }) });
    const err = await s.callTool("t", {}, new AbortController().signal).catch((e) => e);
    expect(err).toBeInstanceOf(ToolError);
    expect(err.message).toBe(redirectText(307));
    expect(err.message).toBe(
      "The app's server responded with a redirect (HTTP 307); redirects are not followed. Ask an administrator to check the app endpoint URL.",
    );
    expect(target.requests).toEqual([]);
  });

  it("打开会话时的 308 同样拒绝", async () => {
    const server = await fake({
      tools: [],
      intercept: () => ({ status: 308, body: "", location: "http://127.0.0.1:1/elsewhere" }),
    });
    const err = await open(server).catch((e) => e);
    expect(err).toBeInstanceOf(ToolError);
    expect(err.message).toBe(redirectText(308));
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
        // annotations.title is the MCP display title when the tool has no top-level title
        title: "Search",
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

  it("keeps the MCP title as the display title: top-level first, trimmed, cut to 80", async () => {
    const server = await fake({
      tools: [
        {
          name: "search",
          title: "  Search messages  ",
          description: "Search messages",
          annotations: { title: "Ignored" },
        },
        { name: "long", title: "x".repeat(100), description: "Long" },
        { name: "blank", title: "   ", description: "Blank" },
      ],
    });
    const s = await open(server);
    const tools = await s.listTools();
    expect(tools.map((t) => t.title)).toEqual(["Search messages", "x".repeat(80), undefined]);
    expect(tools[2]).not.toHaveProperty("title");
  });

  it("cleans control, bidi and invisible characters from the MCP title, like the kernel", async () => {
    const server = await fake({
      tools: [
        { name: "spoof", title: "Read\u202E elif\u2066x\u2069", description: "Spoof" },
        { name: "lines", title: "a\nb\t c", description: "Lines" },
        {
          name: "invisible",
          title: "\u200B",
          annotations: { title: "Fallback" },
          description: "I",
        },
        { name: "zw", title: "\u200B\uFEFF", description: "Zero width" },
      ],
    });
    const s = await open(server);
    const tools = await s.listTools();
    expect(tools.map((t) => t.title)).toEqual(["Read elifx", "a b c", "Fallback", undefined]);
    expect(tools[3]).not.toHaveProperty("title");
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
    expect(err.message).toBe(
      "The app returned an error: Unknown tool missing (check the arguments and retry, or ask the user if it keeps failing).",
    );
    // 服务可达：不计入内核的应用熔断
    expect(err.kind).toBe("error");
  });

  it("HTTP 4xx（非 401）→ ToolError kind error；连接失败 → ToolError kind unavailable", async () => {
    const server = await fake({
      tools: [{ name: "t", description: "d" }],
      intercept: (r) => (r.method === "tools/call" ? { status: 404, body: "nope" } : undefined),
    });
    const s = await open(server);
    const err = await s.callTool("t", {}, new AbortController().signal).catch((e) => e);
    expect(err).toBeInstanceOf(ToolError);
    expect(err.kind).toBe("error");

    const gone = await fake({ tools: [] });
    const url = gone.url;
    await gone.stop();
    servers.splice(servers.indexOf(gone), 1);
    const c = createMcpConnector({ log: memLog(), allowInsecureLoopback: true });
    const refused = await c
      .open({
        endpoint: c.endpointSchema.parse({ url }),
        auth: async () => ({ headers: {} }),
        onUnauthorized: async () => {},
        signal: new AbortController().signal,
      })
      .catch((e) => e);
    expect(refused).toBeInstanceOf(ToolError);
    expect(refused.kind).toBe("unavailable");
    expect(refused.message).toBe(
      "Could not reach the app's server. Retry later, or ask an administrator to check the app.",
    );
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
    expect(err.message).toBe(
      "The app's server responded with HTTP 502. Retry later, or ask an administrator to check the app.",
    );
    // 5xx 计入内核的应用熔断
    expect(err.kind).toBe("unavailable");
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
    // The tool answers after 5 s; 3.5 s still proves the abort cut it short.
    expect(Date.now() - t0).toBeLessThan(3_500);
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
    // 鉴权失败不是服务不可用：不计入熔断
    expect(err.kind).toBe("error");
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

describe("tools/list_changed", () => {
  const changingServer = () =>
    fake({
      sseResponses: true,
      tools: [
        {
          name: "install_plugin",
          description: "Install a plugin (changes the tool list).",
          handler: async (_info, ctx) => {
            await ctx.notifyToolsChanged();
            return { content: [{ type: "text", text: "installed" }] };
          },
        },
        { name: "noop", description: "Do nothing." },
      ],
    });

  it("调用途中收到通知 → 调用 onToolsChanged；结果照常返回", async () => {
    const server = await changingServer();
    let changed = 0;
    const s = await open(server, { onToolsChanged: () => changed++ });
    const r = await s.callTool("install_plugin", {}, new AbortController().signal);
    expect(r).toEqual({ content: [{ type: "text", text: "installed" }] });
    expect(changed).toBe(1);
    await s.callTool("noop", {}, new AbortController().signal);
    expect(changed).toBe(1);
  });

  it("未提供回调（旧内核）：通知被忽略，调用不受影响", async () => {
    const server = await changingServer();
    const s = await open(server);
    const r = await s.callTool("install_plugin", {}, new AbortController().signal);
    expect(r).toEqual({ content: [{ type: "text", text: "installed" }] });
  });

  it("回调抛错不影响调用结果", async () => {
    const server = await changingServer();
    const log = memLog();
    const s = await open(server, {
      log,
      onToolsChanged: () => {
        throw new Error("boom");
      },
    });
    const r = await s.callTool("install_plugin", {}, new AbortController().signal);
    expect(r).toEqual({ content: [{ type: "text", text: "installed" }] });
    expect(log.lines.some((l) => l.level === "warn" && l.msg.includes("list_changed"))).toBe(true);
  });
});

const FORM_SCHEMA = {
  type: "object" as const,
  properties: { name: { type: "string" as const, title: "Name" } },
  required: ["name"],
};

const BANK_ELICITATION = {
  mode: "url" as const,
  message: "Connect your bank",
  url: "https://bank.example.com/connect",
  elicitationId: "el-9",
};

describe("elicitation", () => {
  /** 一个在调用中途发起 elicitation 的服务（有状态会话）：答复原样回显到结果。 */
  async function eliciting(params: Parameters<FakeMcpHandlerContext["elicit"]>[0]) {
    return fake({
      sessions: true,
      tools: [
        {
          name: "greet",
          description: "Greets",
          handler: async (_info, ctx) => {
            try {
              const r = await ctx.elicit(params);
              return { content: [{ type: "text", text: `answer=${JSON.stringify(r)}` }] };
            } catch (e) {
              return { content: [{ type: "text", text: `elicit failed: ${String(e)}` }] };
            }
          },
        },
      ],
    });
  }

  it("form：调用 onElicit，把答复回给服务，调用照常返回", async () => {
    const srv = await eliciting({ message: "Who are you?", requestedSchema: FORM_SCHEMA });
    const seen: ElicitationRequest[] = [];
    const s = await open(srv, {
      onElicit: async (r) => {
        seen.push(r);
        return { action: "accept", content: { name: "Ada" } };
      },
    });
    const r = await s.callTool("greet", {}, new AbortController().signal);
    expect(seen).toEqual([{ mode: "form", message: "Who are you?", requestedSchema: FORM_SCHEMA }]);
    expect(r.content).toEqual([
      { type: "text", text: 'answer={"action":"accept","content":{"name":"Ada"}}' },
    ]);
  });

  it("url：onElicit 收到 url 与 elicitationId；decline 原样回给服务", async () => {
    const srv = await eliciting({
      mode: "url",
      message: "Authorize access",
      url: "https://auth.example.com/start?x=1",
      elicitationId: "el-1",
    });
    const seen: ElicitationRequest[] = [];
    const s = await open(srv, {
      onElicit: async (r) => {
        seen.push(r);
        return { action: "decline" };
      },
    });
    const r = await s.callTool("greet", {}, new AbortController().signal);
    expect(seen).toEqual([
      {
        mode: "url",
        message: "Authorize access",
        url: "https://auth.example.com/start?x=1",
        elicitationId: "el-1",
      },
    ]);
    expect(r.content).toEqual([{ type: "text", text: 'answer={"action":"decline"}' }]);
  });

  it("未提供 onElicit（旧内核）：不声明 elicitation 能力，服务端发起即失败", async () => {
    const srv = await eliciting({ message: "Who?", requestedSchema: FORM_SCHEMA });
    const s = await open(srv);
    const r = await s.callTool("greet", {}, new AbortController().signal);
    expect((r.content[0] as { text: string }).text).toMatch(/elicit failed: .*does not support/);
  });

  it("onElicit 挂起时中止 signal → 调用及时结束（内核据此暂停运行）", async () => {
    const srv = await eliciting({ message: "Who?", requestedSchema: FORM_SCHEMA });
    const ac = new AbortController();
    const s = await open(srv, {
      onElicit: () => {
        ac.abort();
        return new Promise<ElicitationResponse>(() => {});
      },
    });
    const t0 = Date.now();
    await expect(s.callTool("greet", {}, ac.signal)).rejects.toBeDefined();
    // onElicit never settles; 4 s leaves room for CI load.
    expect(Date.now() - t0).toBeLessThan(4_000);
  });

  it("-32042 URL elicitation required：逐个 onElicit，全部 accept 后重试一次调用", async () => {
    let n = 0;
    const srv = await fake({
      tools: [
        {
          name: "pay",
          description: "Pays",
          handler: () => {
            n++;
            if (n === 1) {
              throw new FakeMcpRpcError(-32042, "Authorization required", {
                elicitations: [BANK_ELICITATION],
              });
            }
            return { content: [{ type: "text", text: "paid" }] };
          },
        },
      ],
    });
    const seen: ElicitationRequest[] = [];
    const s = await open(srv, {
      onElicit: async (r) => {
        seen.push(r);
        return { action: "accept" };
      },
    });
    const r = await s.callTool("pay", {}, new AbortController().signal);
    expect(seen).toEqual([BANK_ELICITATION]);
    expect(r.content).toEqual([{ type: "text", text: "paid" }]);
    expect(srv.calls).toHaveLength(2);
  });

  it("-32042 但用户没有接受 → ToolError 说明需要完成的步骤，不重试", async () => {
    const srv = await fake({
      tools: [
        {
          name: "pay",
          description: "Pays",
          handler: () => {
            throw new FakeMcpRpcError(-32042, "Authorization required", {
              elicitations: [BANK_ELICITATION],
            });
          },
        },
      ],
    });
    const s = await open(srv, { onElicit: async () => ({ action: "decline" }) });
    const err = await s.callTool("pay", {}, new AbortController().signal).catch((e) => e);
    expect(err).toBeInstanceOf(ToolError);
    expect((err as ToolError).message).toMatch(/did not complete/);
    expect(srv.calls).toHaveLength(1);
  });

  it("-32042 时 onElicit 拒绝（内核为问用户而中止）→ 调用立即以该错误结束，不重试", async () => {
    const srv = await fake({
      tools: [
        {
          name: "pay",
          description: "Pays",
          handler: () => {
            throw new FakeMcpRpcError(-32042, "Authorization required", {
              elicitations: [BANK_ELICITATION],
            });
          },
        },
      ],
    });
    const suspended = new Error("suspended");
    const s = await open(srv, { onElicit: () => Promise.reject(suspended) });
    const t0 = Date.now();
    await expect(s.callTool("pay", {}, new AbortController().signal)).rejects.toBe(suspended);
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(srv.calls).toHaveLength(1);
  });

  it("-32042 而没有 onElicit → ToolError 带上需要用户打开的地址", async () => {
    const srv = await fake({
      tools: [
        {
          name: "pay",
          description: "Pays",
          handler: () => {
            throw new FakeMcpRpcError(-32042, "Authorization required", {
              elicitations: [BANK_ELICITATION],
            });
          },
        },
      ],
    });
    const s = await open(srv);
    const err = await s.callTool("pay", {}, new AbortController().signal).catch((e) => e);
    expect(err).toBeInstanceOf(ToolError);
    expect((err as ToolError).message).toContain("https://bank.example.com/connect");
  });
});

describe("prompts", () => {
  it("服务声明 prompts → listPrompts / getPrompt；内容块映射为 ToolContent", async () => {
    const srv = await fake({
      tools: [],
      prompts: [
        {
          name: "summarize",
          title: "Summarize",
          description: "Summarize a topic",
          arguments: [{ name: "topic", description: "What to summarize", required: true }],
          render: (args) => [
            { role: "user", content: { type: "text", text: `Summarize ${args.topic}` } },
            { role: "assistant", content: { type: "text", text: "Sure." } },
            {
              role: "user",
              content: { type: "resource", resource: { uri: "docs://a", text: "A body" } },
            },
          ],
        },
        { name: "plain" },
      ],
    });
    const s = await open(srv);
    expect(await s.listPrompts?.()).toEqual([
      {
        name: "summarize",
        title: "Summarize",
        description: "Summarize a topic",
        arguments: [{ name: "topic", description: "What to summarize", required: true }],
      },
      { name: "plain", arguments: [] },
    ]);
    expect(await s.getPrompt?.("summarize", { topic: "MCP" })).toEqual({
      description: "Summarize a topic",
      messages: [
        { role: "user", content: [{ type: "text", text: "Summarize MCP" }] },
        { role: "assistant", content: [{ type: "text", text: "Sure." }] },
        { role: "user", content: [{ type: "text", text: "Resource docs://a:\nA body" }] },
      ],
    });
  });

  it("未知提示 → ToolError；服务不支持 prompts → 会话没有这两个方法", async () => {
    const srv = await fake({ tools: [], prompts: [] });
    const s = await open(srv);
    await expect(s.getPrompt?.("nope", {})).rejects.toBeInstanceOf(ToolError);
    const bare = await open(await fake({ tools: [] }));
    expect(bare.listPrompts).toBeUndefined();
    expect(bare.getPrompt).toBeUndefined();
  });
});
