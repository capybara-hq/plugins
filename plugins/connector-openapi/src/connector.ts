import type {
  Connector,
  ConnectorOpenArgs,
  ConnectorSession,
  Logger,
} from "@capybara-hq/plugin-sdk";
import { endpointSchema, MAX_SPEC_BYTES, type OpenApiEndpoint } from "./endpoint.js";
import { buildRequest, fetchSpec, type Limits, resolveBaseUrl, send } from "./http.js";
import { routeFromSpec, routeOf } from "./route.js";
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
 * 打开一次会话。文档只在 listTools 时读取（安装 / 刷新 / 漂移检查）；调用不读文档，只按内核交回的已复核定义
 * （`ctx.spec.connectorData` 里的路由，见 route.ts）构造请求——远端文档的变化须先经漂移复核才生效。
 * 不在进程内缓存任何东西。工具名撞车时 listTools 照样返回全部（内核快照只保留第一个并给后面的写原因）。
 */
function openSession(
  endpoint: OpenApiEndpoint,
  args: ConnectorOpenArgs,
  deps: Deps,
): ConnectorSession {
  return {
    async listTools() {
      const doc = await loadSpec(endpoint, args.signal, deps.limits);
      return selected(doc, endpoint).map((op) => toolSpecOf(op, routeOf(op, endpoint.specUrl)));
    },
    async callTool(name, input, signal, ctx) {
      const route = routeFromSpec(name, ctx?.spec);
      const base = resolveBaseUrl(route.server, endpoint.baseUrl, deps.allowInsecureLoopback);
      const req = buildRequest(route, input, base);
      return send(req, route.method, args, signal, deps.limits, deps.log);
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
    open: async (args) => openSession(schema.parse(args.endpoint), args, deps),
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
