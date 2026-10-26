import {
  type Connector,
  type ConnectorOpenArgs,
  type ConnectorSession,
  type ElicitationRequest,
  type ElicitationResponse,
  type Logger,
  type PromptInfo,
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
import {
  ElicitRequestSchema,
  ElicitRequestURLParamsSchema,
  ErrorCode,
  McpError,
  ToolListChangedNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js";
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

/** 端点固定头里不允许出现的凭据头（凭据走连接器的认证设置，加密存储）。 */
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

/** Longest display title kept from an MCP tool (`ToolSpec.title`), in code points. */
const TITLE_MAX = 80;

/**
 * An MCP title cleaned for display, the same way the kernel does it (the kernel is the authority
 * and cleans again): format characters (Cf: bidi overrides and isolates, zero-width) removed,
 * control characters (Cc, newlines included) turned into spaces, whitespace runs collapsed, trimmed
 * and cut to 80 code points; undefined when nothing is left.
 */
function displayTitle(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const clean = raw
    .replace(/\p{Cf}/gu, "")
    .replace(/\p{Cc}/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  const cut = [...clean].slice(0, TITLE_MAX).join("").trimEnd();
  return cut === "" ? undefined : cut;
}

/**
 * An MCP tool list item -> ToolSpec: only name / description / inputSchema / annotations, plus the
 * display-only title (the MCP `title`, else `annotations.title`, cleaned by {@link displayTitle}).
 */
function mapTool(raw: Record<string, unknown>, log: Logger): ToolSpec {
  const name = String(raw.name);
  const ann = isObj(raw.annotations) ? raw.annotations : {};
  // The description fallback keeps the raw (trimmed) MCP title, as before.
  const mcpTitle =
    typeof raw.title === "string" && raw.title.trim() !== ""
      ? raw.title.trim()
      : typeof ann.title === "string" && ann.title.trim() !== ""
        ? ann.title.trim()
        : undefined;
  const title = displayTitle(raw.title) ?? displayTitle(ann.title);
  let description = typeof raw.description === "string" ? raw.description.trim() : "";
  if (description === "") {
    description = mcpTitle ?? name;
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
    // Display only: not sent to the model and outside the kernel's definition fingerprint.
    ...(title !== undefined && { title }),
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

/** 服务要求用户先在浏览器里完成某步（`-32042`），但内核没有提供 onElicit（模型可见，英文）。 */
export const urlRequiredText = (steps: { message: string; url: string }[]) =>
  `The app requires the user to complete a step in their browser before this call: ${steps
    .map((s) => `${s.message} (${s.url})`)
    .join("; ")}. Ask the user to open the link and complete it, then retry the call.`;

/** 用户没有完成服务要求的浏览器步骤（模型可见，英文）。 */
export const urlNotCompletedText = (message: string) =>
  `The user did not complete the step the app required (${message}). Ask the user whether to try again, or try another approach.`;

/** `-32042`（URL elicitation required）错误里的 elicitation；不是该错误或数据畸形 → undefined。 */
function urlElicitations(e: unknown): Extract<ElicitationRequest, { mode: "url" }>[] | undefined {
  if (!(e instanceof McpError) || e.code !== ErrorCode.UrlElicitationRequired) return undefined;
  const raw = (e.data as { elicitations?: unknown } | undefined)?.elicitations;
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const out: Extract<ElicitationRequest, { mode: "url" }>[] = [];
  for (const r of raw) {
    const p = ElicitRequestURLParamsSchema.safeParse(r);
    if (!p.success) return undefined;
    out.push({
      mode: "url",
      message: p.data.message,
      url: p.data.url,
      elicitationId: p.data.elicitationId,
    });
  }
  return out;
}

/** 连不上服务（模型可见，英文）。 */
export const UNREACHABLE_TEXT =
  "Could not reach the app's server. Retry later, or ask an administrator to check the app.";

/**
 * 统一错误。`ToolError.kind` 告诉内核是否计入连接器熔断：只有远端不可用（连不上、HTTP 5xx）为 `unavailable`；
 * - 服务端的 JSON-RPC 错误 → ToolError（kind error，带服务的说明；回显的凭据由内核打码）；
 * - HTTP 5xx → ToolError（kind unavailable）、其他非 2xx → ToolError（kind error），都只带状态码（正文已在 fetch 包装里记日志）；
 * - 连接失败（fetch 抛 `TypeError: fetch failed`）→ ToolError（kind unavailable）；
 * - ToolError（认证失败、重定向）原样（kind error）；
 * - 本地产生的超时 / 连接关闭 / 中止等原样抛出（内核按错误类名处理，计入熔断）。
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
      { kind: e.code >= 500 ? "unavailable" : "error" },
    );
  }
  if (e instanceof TypeError && e.message === "fetch failed") {
    return new ToolError(UNREACHABLE_TEXT, { kind: "unavailable" });
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
  // 内核提供 onElicit 才声明 elicitation 能力（表单与 URL 两种模式）；否则服务不会发起
  const onElicit = args.onElicit;
  const client = new Client(CLIENT_INFO, {
    capabilities: onElicit ? { elicitation: { form: {}, url: {} } } : {},
  });
  client.onerror = () => {};
  if (onElicit) {
    client.setRequestHandler(ElicitRequestSchema, async (req) => {
      const p = req.params;
      const request: ElicitationRequest =
        p.mode === "url"
          ? { mode: "url", message: p.message, url: p.url, elicitationId: p.elicitationId }
          : {
              mode: "form",
              message: p.message,
              requestedSchema: p.requestedSchema as Record<string, unknown>,
            };
      const r: ElicitationResponse = await onElicit(request);
      return r.action === "accept"
        ? { action: "accept", ...(r.content !== undefined && { content: r.content }) }
        : { action: r.action };
    });
  }
  // 服务在本次会话里报告工具清单变了：告诉内核（安排漂移检查）；回调出错只记日志，不影响本次调用
  const onToolsChanged = args.onToolsChanged;
  if (onToolsChanged) {
    client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
      try {
        onToolsChanged();
      } catch (err) {
        log.warn("MCP tools/list_changed callback failed", { err });
      }
    });
  }
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
        const call = async () =>
          mapCallResult(
            (await client.callTool(
              { name, arguments: isObj(input) ? input : {} },
              undefined,
              opts(AbortSignal.any([signal, args.signal])),
            )) as Record<string, unknown>,
          );
        try {
          return await call();
        } catch (e) {
          // URL 模式的 elicitation 也可以以错误 -32042 的形式出现：逐个交给内核（用户完成后接受），全部接受后重试一次
          const steps = urlElicitations(e);
          if (!steps) throw e;
          if (!onElicit) throw new ToolError(urlRequiredText(steps));
          for (const step of steps) {
            const r = await onElicit(step);
            if (r.action !== "accept") throw new ToolError(urlNotCompletedText(step.message));
          }
          return call();
        }
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
  if (client.getServerCapabilities()?.prompts) {
    session.listPrompts = () =>
      guarded(async () => {
        const out: PromptInfo[] = [];
        let cursor: string | undefined;
        for (let page = 0; page < MAX_PAGES; page++) {
          const r = await client.listPrompts(cursor === undefined ? {} : { cursor }, opts());
          for (const p of r.prompts) {
            out.push({
              name: p.name,
              ...(typeof p.title === "string" && { title: p.title }),
              ...(typeof p.description === "string" && { description: p.description }),
              arguments: (p.arguments ?? []).map((a) => ({
                name: a.name,
                ...(typeof a.description === "string" && { description: a.description }),
                ...(typeof a.required === "boolean" && { required: a.required }),
              })),
            });
          }
          cursor = r.nextCursor;
          if (!cursor) break;
        }
        return out;
      });
    session.getPrompt = (name, promptArgs) =>
      guarded(async () => {
        const r = await client.getPrompt({ name, arguments: promptArgs }, opts());
        return {
          ...(typeof r.description === "string" && { description: r.description }),
          messages: r.messages.map((m) => ({
            role: m.role === "assistant" ? ("assistant" as const) : ("user" as const),
            content: [mapContent(m.content)],
          })),
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
