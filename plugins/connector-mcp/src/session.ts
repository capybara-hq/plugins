import {
  type Connector,
  type ConnectorOpenArgs,
  type ConnectorSession,
  type Logger,
  type ToolAnnotations,
  type ToolContent,
  ToolError,
  type ToolResult,
  type ToolSpec,
} from "@capybara-hq/plugin-sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

/** 401 刷新重试后仍失败（模型可见，英文）。 */
export const AUTH_FAILED_TEXT = "Authentication failed for this app; ask the user to reconnect it.";

/** 客户端标识（initialize 时发给服务）。 */
const CLIENT_INFO = { name: "capybara", version: "0.1.0" };

/**
 * SDK 单个请求的超时：设得足够长，让内核管线的超时（经 signal 传入）说了算，
 * 而不是 SDK 默认的 60 秒。
 */
const REQUEST_TIMEOUT_MS = 3_600_000;

/** 分页拉清单的最多页数（防止服务返回循环游标）。 */
const MAX_PAGES = 100;

/** 写进日志的上游错误正文最多字符数。 */
const MAX_LOGGED_BODY = 1_000;

/** 端点固定头里不允许出现的凭据头（凭据走应用的认证设置，加密存储）。 */
// capybara:allow-module-state 只读常量表
const CREDENTIAL_HEADERS = new Set(["authorization", "proxy-authorization", "cookie"]);

// capybara:allow-module-state 只读常量表
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** 本机 http 只认这三个确切的主机名（`localhost.`、`localhost.evil.com`、`127.0.0.1.nip.io` 等一律不算）。 */
const isLoopbackHttp = (u: URL): boolean =>
  u.protocol === "http:" && LOOPBACK_HOSTS.has(u.hostname);

const urlAllowed = (raw: string, allowInsecureLoopback: boolean): boolean => {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return true; // 交给 z.url() 报格式错误
  }
  if (u.protocol === "https:") return true;
  return allowInsecureLoopback && isLoopbackHttp(u);
};

/**
 * 端点：url 须为 https；部署配置 `allowInsecureLoopback` 打开时（仅供开发与测试）本机 http 例外。
 * headers 是非密钥的固定头。
 */
export function endpointSchema(allowInsecureLoopback: boolean) {
  return z.object({
    url: z.url().refine((v) => urlAllowed(v, allowInsecureLoopback), {
      message: allowInsecureLoopback
        ? "URL must use https (plain http is only allowed for 127.0.0.1, localhost and [::1])"
        : "URL must use https",
    }),
    headers: z
      .record(z.string(), z.string())
      .default({})
      .superRefine((h, ctx) => {
        for (const name of Object.keys(h)) {
          if (CREDENTIAL_HEADERS.has(name.toLowerCase())) {
            ctx.addIssue({
              code: "custom",
              path: [name],
              message:
                "Do not put credentials in endpoint headers; configure the app's auth instead",
            });
          }
        }
      }),
  });
}

export type McpEndpoint = z.infer<ReturnType<typeof endpointSchema>>;

/** 服务以 3xx 响应（不跟随，模型可见，英文）。 */
export const redirectText = (status: number) =>
  `The app's server responded with a redirect (HTTP ${status}); redirects are not followed. Ask an administrator to check the app endpoint URL.`;

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** MCP 工具清单项 → ToolSpec（只取 name / description / inputSchema / annotations）。 */
function mapTool(raw: Record<string, unknown>, log: Logger): ToolSpec {
  const name = String(raw.name);
  const ann = isObj(raw.annotations) ? raw.annotations : {};
  let description = typeof raw.description === "string" ? raw.description.trim() : "";
  if (description === "") {
    const title =
      typeof raw.title === "string" && raw.title.trim() !== ""
        ? raw.title.trim()
        : typeof ann.title === "string" && ann.title.trim() !== ""
          ? ann.title.trim()
          : name;
    description = title;
    log.warn("MCP tool has no description; using its title or name", { tool: name });
  }
  const annotations: ToolAnnotations = {};
  for (const k of ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"] as const) {
    if (typeof ann[k] === "boolean") annotations[k] = ann[k];
  }
  const meta = isObj(raw._meta) ? raw._meta : {};
  if (meta["anthropic/requiresUserInteraction"] === true)
    annotations.requiresUserInteraction = true;
  return {
    name,
    description,
    inputSchema: isObj(raw.inputSchema) ? raw.inputSchema : {},
    ...(Object.keys(annotations).length > 0 && { annotations }),
  };
}

const base64Bytes = (b64: string): number => Buffer.byteLength(b64, "base64");

/** 资源内容（text / blob）→ ToolContent；`prefix` 时给文本加上资源 URI 抬头。 */
function mapResourceContents(r: Record<string, unknown>, prefix: boolean): ToolContent {
  const uri = String(r.uri ?? "");
  const mime = typeof r.mimeType === "string" ? r.mimeType : undefined;
  if (typeof r.text === "string") {
    return { type: "text", text: prefix ? `Resource ${uri}:\n${r.text}` : r.text };
  }
  if (typeof r.blob === "string") {
    if (mime?.startsWith("image/")) return { type: "image", mimeType: mime, data: r.blob };
    return {
      type: "text",
      text: `[Binary resource ${uri} (${mime ?? "unknown type"}, ${base64Bytes(r.blob)} bytes) omitted]`,
    };
  }
  return { type: "text", text: `[Empty resource ${uri}]` };
}

/** MCP 内容块 → ToolContent：非文本且内核不认识的类型给出类型说明，不丢弃。 */
function mapContent(c: unknown): ToolContent {
  if (!isObj(c)) return { type: "text", text: "[Malformed content block omitted]" };
  switch (c.type) {
    case "text":
      return { type: "text", text: String(c.text ?? "") };
    case "image":
      return { type: "image", mimeType: String(c.mimeType ?? ""), data: String(c.data ?? "") };
    case "resource_link":
      return {
        type: "resource_link",
        uri: String(c.uri ?? ""),
        ...(typeof c.name === "string" && { name: c.name }),
        ...(typeof c.mimeType === "string" && { mimeType: c.mimeType }),
      };
    case "resource":
      return isObj(c.resource)
        ? mapResourceContents(c.resource, true)
        : { type: "text", text: "[Malformed resource omitted]" };
    case "audio":
      return {
        type: "text",
        text: `[Audio content (${String(c.mimeType ?? "unknown type")}) omitted]`,
      };
    default:
      return { type: "text", text: `[Unsupported content type "${String(c.type)}" omitted]` };
  }
}

function mapCallResult(r: Record<string, unknown>): ToolResult {
  const content = Array.isArray(r.content) ? r.content.map(mapContent) : [];
  if (content.length === 0 && r.structuredContent !== undefined) {
    content.push({ type: "text", text: JSON.stringify(r.structuredContent) });
  }
  return { content, ...(r.isError === true && { isError: true }) };
}

/**
 * 统一错误：服务端的 JSON-RPC 错误 → ToolError（带服务的说明；回显的凭据由内核打码）；
 * HTTP 非 2xx → ToolError 只带状态码（正文已在 fetch 包装里记日志）；ToolError（认证失败）原样；
 * 本地产生的超时 / 连接关闭 / 中止等原样抛出（内核按错误类名处理）。
 */
function mapError(e: unknown): unknown {
  if (e instanceof ToolError) return e;
  if (e instanceof McpError) {
    if (e.code === ErrorCode.RequestTimeout || e.code === ErrorCode.ConnectionClosed) return e;
    // SDK 在服务端与客户端各加一次 "MCP error <code>: " 前缀，去掉后只留服务的说明
    const msg = e.message.replace(/^(MCP error -?\d+: )+/, "");
    return new ToolError(
      `The app returned an error: ${msg} (check the arguments and retry, or ask the user if it keeps failing).`,
    );
  }
  if (e instanceof StreamableHTTPError && typeof e.code === "number" && e.code >= 400) {
    return new ToolError(
      `The app's server responded with HTTP ${e.code}. Retry later, or ask an administrator to check the app.`,
    );
  }
  return e;
}

async function guarded<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (e) {
    throw mapError(e);
  }
}

/**
 * 每个 HTTP 请求前调用 `auth()` 取最新的鉴权信息并合并进请求（头覆盖同名头、query 追加到 URL），
 * 端点固定头在协议头之后补上（不覆盖）。401 → `onUnauthorized()` 后用新凭据重试一次，仍 401 抛 ToolError。
 * 其他非 2xx 的 POST 把正文（截断）记 warn 日志——内核 logger 会把已登记的凭据值打码。
 */
function authedFetch(endpoint: McpEndpoint, args: ConnectorOpenArgs, log: Logger) {
  return async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const method = (init?.method ?? "GET").toUpperCase();
    const send = async (): Promise<Response> => {
      const inj = await args.auth();
      const url = new URL(input);
      for (const [k, v] of Object.entries(inj.query ?? {})) url.searchParams.set(k, v);
      const headers = new Headers(init?.headers);
      for (const [k, v] of Object.entries(endpoint.headers)) if (!headers.has(k)) headers.set(k, v);
      for (const [k, v] of Object.entries(inj.headers)) headers.set(k, v);
      const signal = init?.signal ? AbortSignal.any([init.signal, args.signal]) : args.signal;
      // 不跟随重定向：跟随会把请求体与注入的凭据头带到别的源（跨源时自定义头不会被剥掉）
      return fetch(url, { ...init, headers, signal, redirect: "manual" });
    };
    const noRedirect = async (r: Response) => {
      if (r.status >= 300 && r.status < 400) {
        await r.body?.cancel();
        throw new ToolError(redirectText(r.status));
      }
    };
    let res = await send();
    await noRedirect(res);
    // GET 是可选的独立 SSE 流，失败由 SDK 自己忽略，不触发刷新
    if (res.status === 401 && method !== "GET") {
      await res.body?.cancel();
      await args.onUnauthorized();
      res = await send();
      await noRedirect(res);
      if (res.status === 401) {
        await res.body?.cancel();
        throw new ToolError(AUTH_FAILED_TEXT);
      }
    }
    if (!res.ok && method === "POST") {
      const body = await res
        .clone()
        .text()
        .catch(() => "");
      log.warn("MCP request failed", { status: res.status, body: body.slice(0, MAX_LOGGED_BODY) });
    }
    return res;
  };
}

/**
 * 打开一次 MCP 会话（Streamable HTTP）。会话只活在这一次操作里（内核每次工具调用打开、用完关闭），
 * 不在进程内缓存连接。服务声明了 resources 能力时会话才带 listResources / readResource。
 */
async function openSession(
  endpoint: McpEndpoint,
  args: ConnectorOpenArgs,
  log: Logger,
): Promise<ConnectorSession> {
  const transport = new StreamableHTTPClientTransport(new URL(endpoint.url), {
    fetch: authedFetch(endpoint, args, log),
  });
  const client = new Client(CLIENT_INFO, { capabilities: {} });
  client.onerror = () => {};
  const opts = (signal: AbortSignal = args.signal) => ({ signal, timeout: REQUEST_TIMEOUT_MS });
  try {
    // exactOptionalPropertyTypes 下 SDK 自身的 Transport 类型不兼容（sessionId 可为 undefined），按 SDK 文档用法转型
    const t = transport as unknown as Parameters<Client["connect"]>[0];
    await guarded(() => client.connect(t, opts()));
  } catch (e) {
    await client.close().catch(() => {});
    throw e;
  }

  const session: ConnectorSession = {
    listTools: () =>
      guarded(async () => {
        const out: ToolSpec[] = [];
        let cursor: string | undefined;
        for (let page = 0; page < MAX_PAGES; page++) {
          const r = await client.listTools(cursor === undefined ? {} : { cursor }, opts());
          for (const t of r.tools) out.push(mapTool(t as Record<string, unknown>, log));
          cursor = r.nextCursor;
          if (!cursor) break;
        }
        return out;
      }),
    callTool: (name, input, signal) =>
      guarded(async () => {
        const r = await client.callTool(
          { name, arguments: isObj(input) ? input : {} },
          undefined,
          opts(AbortSignal.any([signal, args.signal])),
        );
        return mapCallResult(r as Record<string, unknown>);
      }),
    async close() {
      if (transport.sessionId) await transport.terminateSession().catch(() => {});
      await client.close();
    },
  };

  if (client.getServerCapabilities()?.resources) {
    session.listResources = () =>
      guarded(async () => {
        const out: { uri: string; name: string; description?: string; mimeType?: string }[] = [];
        let cursor: string | undefined;
        for (let page = 0; page < MAX_PAGES; page++) {
          const r = await client.listResources(cursor === undefined ? {} : { cursor }, opts());
          for (const x of r.resources) {
            out.push({
              uri: x.uri,
              name: x.name,
              ...(typeof x.description === "string" && { description: x.description }),
              ...(typeof x.mimeType === "string" && { mimeType: x.mimeType }),
            });
          }
          cursor = r.nextCursor;
          if (!cursor) break;
        }
        return out;
      });
    session.readResource = (uri) =>
      guarded(async () => {
        const r = await client.readResource({ uri }, opts());
        const prefix = r.contents.length > 1;
        return {
          content: r.contents.map((c) => mapResourceContents(c as Record<string, unknown>, prefix)),
        };
      });
  }
  return session;
}

/** 创建 MCP 连接器（`connector@1`，kind = `mcp`）。 */
export function createMcpConnector(deps: {
  log: Logger;
  /** 允许 http://127.0.0.1 / localhost / [::1]（部署配置，默认关闭）。 */
  allowInsecureLoopback?: boolean;
}): Connector {
  const schema = endpointSchema(deps.allowInsecureLoopback === true);
  return {
    kind: "mcp",
    endpointSchema: schema,
    open: (args) => openSession(schema.parse(args.endpoint), args, deps.log),
  };
}
