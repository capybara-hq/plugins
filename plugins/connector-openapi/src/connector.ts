import {
  type Connector,
  type ConnectorOpenArgs,
  type ConnectorSession,
  type Logger,
  ToolError,
} from "@capybara-hq/plugin-sdk";
import { endpointSchema, MAX_SPEC_BYTES, type OpenApiEndpoint } from "./endpoint.js";
import { buildRequest, fetchSpec, type Limits, resolveBaseUrl, send } from "./http.js";
import {
  authHints,
  loadDocument,
  type OpenApiDocument,
  type Operation,
  parseSpecText,
} from "./spec.js";
import { toolSpecOf } from "./tools.js";

/** 默认上限：文档 2 MB、响应正文 5 MB（更大的结果由内核转存）、取文档 30 秒。 */
const DEFAULT_LIMITS: Limits = {
  maxSpecBytes: MAX_SPEC_BYTES,
  maxResponseBytes: 5 * 1024 * 1024,
  specTimeoutMs: 30_000,
};

/** 取到并整理文档（specText 直接解析；specUrl 不带凭据去取）。 */
async function loadSpec(
  endpoint: OpenApiEndpoint,
  signal: AbortSignal,
  limits: Limits,
): Promise<OpenApiDocument> {
  const text = endpoint.specText ?? (await fetchSpec(endpoint.specUrl as string, signal, limits));
  return loadDocument(parseSpecText(text));
}

/** 勾选的操作（缺省 = 全部），按文档顺序。 */
function selected(doc: OpenApiDocument, endpoint: OpenApiEndpoint): Operation[] {
  const allow = endpoint.operations ? new Set(endpoint.operations) : undefined;
  return doc.operations.filter((op) => !allow || allow.has(op.id));
}

/**
 * 按工具名索引：同名（工具名规范化 / 截断后撞车）时第一个生效。listTools 照样返回全部同名工具，
 * 内核快照只保留第一个并给后面的写原因（「Duplicate tool name」），两边一致。
 */
function byToolName(ops: Operation[]): Map<string, Operation> {
  const out = new Map<string, Operation>();
  for (const op of ops) if (!out.has(op.toolName)) out.set(op.toolName, op);
  return out;
}

const unknownTool = (name: string) =>
  new ToolError(
    `Tool "${name}" does not match an enabled operation in the app's OpenAPI document; ask an administrator to refresh the app.`,
  );

/**
 * 打开一次会话：取文档、整理操作清单（只在本次操作里用，不在进程内缓存——多副本下下一次调用可能在别的副本，
 * 文档也可能已更新；文档更新带来的工具变化由内核的漂移检测复核）。
 */
async function openSession(
  endpoint: OpenApiEndpoint,
  args: ConnectorOpenArgs,
  deps: Deps,
): Promise<ConnectorSession> {
  const doc = await loadSpec(endpoint, args.signal, deps.limits);
  const ops = selected(doc, endpoint);
  const index = byToolName(ops);
  return {
    async listTools() {
      return ops.map(toolSpecOf);
    },
    async callTool(name, input, signal) {
      const op = index.get(name);
      if (!op) throw unknownTool(name);
      const base = resolveBaseUrl(
        op,
        endpoint.baseUrl,
        endpoint.specUrl,
        deps.allowInsecureLoopback,
      );
      const req = buildRequest(op, input, base);
      return send(req, op.method, args, signal, deps.limits, deps.log);
    },
    async close() {},
  };
}

interface Deps {
  log: Logger;
  allowInsecureLoopback: boolean;
  limits: Limits;
}

/** 创建 OpenAPI 连接器（`connector@1`，kind = `openapi`）。 */
export function createOpenApiConnector(opts: {
  log: Logger;
  /** 允许 http://127.0.0.1 / localhost / [::1]（部署配置，默认关闭）。 */
  allowInsecureLoopback?: boolean;
  /** 覆盖默认上限（测试用）。 */
  limits?: Partial<Limits>;
}): Connector {
  const deps: Deps = {
    log: opts.log,
    allowInsecureLoopback: opts.allowInsecureLoopback === true,
    limits: { ...DEFAULT_LIMITS, ...opts.limits },
  };
  const schema = endpointSchema(deps.allowInsecureLoopback);
  return {
    kind: "openapi",
    endpointSchema: schema,
    open: (args) => openSession(schema.parse(args.endpoint), args, deps),
    async inspect({ endpoint, signal }) {
      const e = schema.parse(endpoint);
      const doc = await loadSpec(e, signal, deps.limits);
      return {
        authHints: authHints(doc.doc),
        operations: doc.operations.map((o) => ({
          id: o.id,
          method: o.method.toUpperCase(),
          path: o.path,
          ...(o.summary !== undefined && { summary: o.summary }),
        })),
      };
    },
  };
}
