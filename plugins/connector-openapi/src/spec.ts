import { type AuthHint, ToolError } from "@capybara-hq/plugin-sdk";
import { parse as parseYaml } from "yaml";

/**
 * OpenAPI 文档：解析（JSON / YAML）、版本检查（只支持 3.0 / 3.1）、只展开内部 `$ref`，并整理出操作清单。
 *
 * 不用通用的 `$ref` 解析库：它们要么把循环引用展开成循环对象图（工具 inputSchema 无法序列化），要么在
 * `circular: "ignore"` 下把含循环后代的整条引用链原样留着；它们自带的文件 / http 解析器也是不必要的攻击面。
 * 这里只认 `#/...` 内部指针，外部引用一律报错、绝不去取；环上换成宽松模式；展开有节点预算与深度上限。
 * YAML 用维护中的 `yaml` 包（别名展开有上限，防「十亿笑声」）。
 */

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const str = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;

/** 支持的 HTTP 方法（OpenAPI path item 的操作键；TRACE 被 fetch 禁止，不生成工具）。 */
// capybara:allow-module-state 只读常量表
export const METHODS = ["get", "put", "post", "delete", "options", "head", "patch"] as const;

/** 工具名上限（与插件工具名一致；加上应用前缀后的 key 由内核再校验 ≤ 64）。 */
export const TOOL_NAME_MAX = 40;

/** 展开 `$ref` 的节点预算与深度上限（防引用炸弹与病态嵌套）。 */
const NODE_BUDGET = 200_000;
const MAX_DEPTH = 64;

/** 报错里引用的 `$ref` 最多保留的字符数。 */
const MAX_REF_ECHO = 200;

export type ParamLocation = "path" | "query" | "header";

export interface Param {
  name: string;
  in: ParamLocation;
  required: boolean;
  /** 已展开并转成 JSON Schema（2020-12）的参数模式（含参数描述）。 */
  schema: Record<string, unknown>;
  style: string;
  explode: boolean;
  /** 参数用 `content`（而非 schema）声明：值按 JSON 序列化。 */
  json: boolean;
}

export interface RequestBody {
  required: boolean;
  mediaType: string;
  /** JSON 媒体类型：值按 JSON 序列化；否则值是原样发送的字符串。 */
  json: boolean;
  schema: Record<string, unknown>;
}

export interface Operation {
  /** 端点 `operations` 勾选用的 id：operationId，缺失时由方法与路径生成。 */
  id: string;
  toolName: string;
  /** 小写方法。 */
  method: (typeof METHODS)[number];
  path: string;
  summary?: string;
  description?: string;
  params: Param[];
  body?: RequestBody;
  /** 给模型的补充说明（不支持的部分等），英文。 */
  notes: string[];
  /** 作用于该操作的 servers（操作级 → path 级 → 文档级）。 */
  servers: unknown[];
}

export interface OpenApiDocument {
  doc: Record<string, unknown>;
  /** 文档里全部操作（不按勾选过滤），按文档顺序。 */
  operations: Operation[];
}

const docError = (detail: string) =>
  new ToolError(
    `The app's OpenAPI document is invalid: ${detail}. Ask an administrator to check the document.`,
  );

/** 解析文档文本：`{` 开头按 JSON，否则按 YAML（YAML 是 JSON 的超集，兜底也能读 JSON）。 */
export function parseSpecText(text: string): unknown {
  const t = text.trim();
  if (t.startsWith("{")) {
    try {
      return JSON.parse(t);
    } catch {
      // 落到 YAML
    }
  }
  try {
    return parseYaml(t, { maxAliasCount: 100, prettyErrors: false });
  } catch {
    throw new ToolError(
      "The app's OpenAPI document could not be parsed as JSON or YAML. Ask an administrator to check the document.",
    );
  }
}

/** 版本检查：只支持 OpenAPI 3.0 / 3.1。 */
function checkVersion(doc: unknown): asserts doc is Record<string, unknown> {
  if (!isObj(doc)) throw docError("the document is not an object");
  if (doc.swagger !== undefined) {
    throw new ToolError(
      "Swagger 2.0 documents are not supported; convert the API description to OpenAPI 3.0 or 3.1 and ask an administrator to update the app.",
    );
  }
  if (typeof doc.openapi !== "string") {
    throw new ToolError(
      "The app's document is not an OpenAPI document (missing the openapi field); provide an OpenAPI 3.0 or 3.1 document.",
    );
  }
  if (!/^3\.[01](\.\d+)?(-.+)?$/.test(doc.openapi)) {
    throw new ToolError(
      `OpenAPI version ${doc.openapi.slice(0, 20)} is not supported; provide an OpenAPI 3.0 or 3.1 document.`,
    );
  }
}

/** 只展开 `#/...` 内部引用的解析器；每个文档一个实例，节点预算在实例内累计。 */
class RefResolver {
  private nodes = 0;

  constructor(private readonly root: Record<string, unknown>) {}

  private pointer(ref: string): unknown {
    let cur: unknown = this.root;
    const parts = ref.slice(2).split("/");
    for (const raw of ref === "#" ? [] : parts) {
      let key: string;
      try {
        key = decodeURIComponent(raw).replace(/~1/g, "/").replace(/~0/g, "~");
      } catch {
        return undefined;
      }
      if (Array.isArray(cur) && /^\d+$/.test(key)) cur = cur[Number(key)];
      else if (isObj(cur) && Object.hasOwn(cur, key)) cur = cur[key];
      else return undefined;
    }
    return cur;
  }

  resolve(node: unknown, stack: readonly string[] = [], depth = 0): unknown {
    if (typeof node !== "object" || node === null) return node;
    if (++this.nodes > NODE_BUDGET) {
      throw docError("it is too large or references expand too much");
    }
    if (depth > MAX_DEPTH) return {};
    if (Array.isArray(node)) return node.map((x) => this.resolve(x, stack, depth + 1));
    const obj = node as Record<string, unknown>;
    if (typeof obj.$ref === "string") {
      const ref = obj.$ref;
      const echo = ref.slice(0, MAX_REF_ECHO);
      if (!ref.startsWith("#")) {
        throw new ToolError(
          `The app's OpenAPI document uses an external $ref "${echo}"; only internal references (#/...) are supported. Bundle the document into a single file and ask an administrator to update the app.`,
        );
      }
      const { $ref: _ignored, ...siblings } = obj;
      if (stack.includes(ref)) return { description: `Recursive reference to ${echo} omitted` };
      const target = this.pointer(ref);
      if (target === undefined) throw docError(`$ref "${echo}" does not resolve`);
      const resolved = this.resolve(target, [...stack, ref], depth + 1);
      // 3.1 允许 $ref 旁边的关键字（description 等）：并到展开结果上
      if (Object.keys(siblings).length === 0 || !isObj(resolved)) return resolved;
      return { ...resolved, ...(this.resolve(siblings, stack, depth + 1) as object) };
    }
    // fromEntries 按数据属性创建：`__proto__` 之类的键不会改原型
    return Object.fromEntries(
      Object.entries(obj).map(([k, v]) => [k, this.resolve(v, stack, depth + 1)]),
    );
  }
}

/** 子模式所在的关键字（递归转换用）。 */
// capybara:allow-module-state 只读常量表
const SCHEMA_MAPS = ["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"];
// capybara:allow-module-state 只读常量表
const SCHEMA_ONE = [
  "additionalProperties",
  "items",
  "not",
  "if",
  "then",
  "else",
  "contains",
  "propertyNames",
  "unevaluatedProperties",
  "unevaluatedItems",
  "additionalItems",
];
// capybara:allow-module-state 只读常量表
const SCHEMA_LISTS = ["allOf", "anyOf", "oneOf", "prefixItems"];

/**
 * OpenAPI 3.0 的模式方言 → JSON Schema 2020-12：`nullable` → 类型数组（或 enum 加 null），布尔形式的
 * `exclusiveMinimum` / `exclusiveMaximum` → 数值形式。3.1 的模式本来就是 JSON Schema，原样返回。
 */
export function toJsonSchema(schema: unknown, v30: boolean): Record<string, unknown> {
  if (!isObj(schema)) return {};
  if (!v30) return schema;
  const s: Record<string, unknown> = { ...schema };
  if (s.nullable === true) {
    if (typeof s.type === "string") s.type = [s.type, "null"];
    else if (Array.isArray(s.type) && !s.type.includes("null")) s.type = [...s.type, "null"];
    if (Array.isArray(s.enum) && !s.enum.includes(null)) s.enum = [...s.enum, null];
  }
  delete s.nullable;
  for (const [flag, bound] of [
    ["exclusiveMinimum", "minimum"],
    ["exclusiveMaximum", "maximum"],
  ] as const) {
    if (typeof s[flag] !== "boolean") continue;
    if (s[flag] === true && typeof s[bound] === "number") {
      s[flag] = s[bound];
      delete s[bound];
    } else {
      delete s[flag];
    }
  }
  for (const k of SCHEMA_MAPS) {
    const m = s[k];
    if (isObj(m)) {
      s[k] = Object.fromEntries(Object.entries(m).map(([n, x]) => [n, toJsonSchema(x, true)]));
    }
  }
  for (const k of SCHEMA_ONE) {
    if (isObj(s[k])) s[k] = toJsonSchema(s[k], true);
    else if (k === "items" && Array.isArray(s[k])) {
      s[k] = (s[k] as unknown[]).map((x) => toJsonSchema(x, true));
    }
  }
  for (const k of SCHEMA_LISTS) {
    const l = s[k];
    if (Array.isArray(l)) s[k] = l.map((x) => toJsonSchema(x, true));
  }
  return s;
}

/** 工具名：非 `[a-zA-Z0-9_-]` 的连续字符折成一个下划线，去掉首尾下划线，截到 40 字符。 */
export function toolNameOf(id: string): string {
  const s = id
    .replace(/[^a-zA-Z0-9_-]+/g, "_")
    .replace(/_{2,}/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, TOOL_NAME_MAX)
    .replace(/_+$/, "");
  return s === "" ? "operation" : s;
}

/** 缺 operationId 时的 id：`<method>_<path>` 规范化（不截断）。 */
const derivedId = (method: string, path: string): string =>
  `${method}_${path}`
    .replace(/[^a-zA-Z0-9_-]+/g, "_")
    .replace(/_{2,}/g, "_")
    .replace(/^_+|_+$/g, "");

/** 不能经工具参数设置的头（凭据走应用认证；协议头由连接器决定）。OpenAPI 也规定 Accept / Content-Type / Authorization 头参数被忽略。 */
// capybara:allow-module-state 只读常量表
export const RESERVED_HEADERS = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "accept",
  "content-type",
  "content-length",
  "host",
  "connection",
  "transfer-encoding",
]);

/** HTTP 头名（RFC 9110 token）；不合法的头参数不生成。 */
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;

/** 凭据样式的头名：不进工具参数（凭据走应用认证）。 */
export const CREDENTIAL_HEADER = /^(?:x-)?api-?key$|^x-auth-token$|-token$|-secret$/;

const JSON_MEDIA = /^application\/(?:[\w.+-]*\+)?json$/i;
const baseMedia = (m: string) => (m.split(";")[0] ?? "").trim().toLowerCase();

function mapParam(raw: unknown, v30: boolean, notes: string[]): Param | undefined {
  if (!isObj(raw)) return undefined;
  const name = str(raw.name);
  const loc = raw.in;
  if (!name) return undefined;
  if (loc === "cookie") {
    notes.push(`Cookie parameter "${name}" is not supported and is never sent.`);
    return undefined;
  }
  if (loc !== "path" && loc !== "query" && loc !== "header") return undefined;
  if (
    loc === "header" &&
    (RESERVED_HEADERS.has(name.toLowerCase()) ||
      CREDENTIAL_HEADER.test(name.toLowerCase()) ||
      !HEADER_NAME.test(name))
  ) {
    return undefined;
  }
  let schema: Record<string, unknown>;
  let json = false;
  if (isObj(raw.schema)) {
    schema = toJsonSchema(raw.schema, v30);
  } else if (isObj(raw.content)) {
    const first = Object.values(raw.content)[0];
    schema = toJsonSchema(isObj(first) ? first.schema : undefined, v30);
    json = true;
  } else {
    schema = {};
  }
  const description = str(raw.description);
  if (description && schema.description === undefined) schema = { ...schema, description };
  const style = typeof raw.style === "string" ? raw.style : loc === "query" ? "form" : "simple";
  return {
    name,
    in: loc,
    required: loc === "path" ? true : raw.required === true,
    schema,
    style,
    explode: typeof raw.explode === "boolean" ? raw.explode : style === "form",
    json,
  };
}

function mapBody(raw: unknown, v30: boolean, notes: string[]): RequestBody | undefined {
  if (!isObj(raw) || !isObj(raw.content)) return undefined;
  const entries = Object.entries(raw.content);
  const required = raw.required === true;
  const json = entries.find(([m]) => JSON_MEDIA.test(baseMedia(m)));
  if (json) {
    const media = json[1];
    return {
      required,
      mediaType: baseMedia(json[0]),
      json: true,
      schema: toJsonSchema(isObj(media) ? media.schema : undefined, v30),
    };
  }
  const other = entries.find(([m]) => !baseMedia(m).startsWith("multipart/"));
  if (!other) {
    if (entries.length > 0) {
      notes.push("The multipart/form-data request body of this operation is not supported.");
    }
    return undefined;
  }
  const mediaType = baseMedia(other[0]);
  return {
    required,
    mediaType,
    json: false,
    schema: {
      type: "string",
      description: `Raw request body, sent as ${mediaType}${
        mediaType === "application/x-www-form-urlencoded" ? " (for example a=1&b=2)" : ""
      }.`,
    },
  };
}

/** 读入并整理文档：版本检查 → 逐个操作展开所需部分（外部引用报错）→ 操作清单。 */
export function loadDocument(raw: unknown): OpenApiDocument {
  checkVersion(raw);
  const doc = raw;
  const v30 = (doc.openapi as string).startsWith("3.0");
  const resolver = new RefResolver(doc);
  const docServers = Array.isArray(doc.servers) ? (resolver.resolve(doc.servers) as unknown[]) : [];
  const operations: Operation[] = [];
  const paths = isObj(doc.paths) ? doc.paths : {};
  for (const [path, rawItem] of Object.entries(paths)) {
    if (!path.startsWith("/")) continue;
    const item = resolver.resolve(rawItem);
    if (!isObj(item)) continue;
    const itemParams = Array.isArray(item.parameters) ? item.parameters : [];
    const itemServers = Array.isArray(item.servers) ? item.servers : undefined;
    // 按文档里的键顺序（与作者的排列一致）
    for (const [key, op] of Object.entries(item)) {
      const method = METHODS.find((m) => m === key);
      if (!method || !isObj(op)) continue;
      const notes: string[] = [];
      // 操作级参数按 (in, name) 覆盖 path 级参数
      const params = new Map<string, Param>();
      const opParams = Array.isArray(op.parameters) ? op.parameters : [];
      for (const p of [...itemParams, ...opParams]) {
        const m = mapParam(p, v30, notes);
        if (m) params.set(`${m.in}:${m.name.toLowerCase()}`, m);
      }
      // 路径模板里有、但没声明的变量：按必填字符串补上
      for (const [, name] of path.matchAll(/\{([^}]+)\}/g)) {
        const key = `path:${(name as string).toLowerCase()}`;
        if (!params.has(key)) {
          params.set(key, {
            name: name as string,
            in: "path",
            required: true,
            schema: { type: "string" },
            style: "simple",
            explode: false,
            json: false,
          });
        }
      }
      const body = mapBody(op.requestBody, v30, notes);
      const id = str(op.operationId) ?? derivedId(method, path);
      const summary = str(op.summary);
      const description = str(op.description);
      operations.push({
        id,
        toolName: toolNameOf(id),
        method,
        path,
        ...(summary !== undefined && { summary }),
        ...(description !== undefined && { description }),
        params: [...params.values()],
        ...(body && { body }),
        notes,
        servers: Array.isArray(op.servers) ? op.servers : (itemServers ?? docServers),
      });
    }
  }
  return { doc, operations };
}

const scopesOf = (flow: Record<string, unknown>): string[] =>
  isObj(flow.scopes) ? Object.keys(flow.scopes) : [];

/**
 * `components.securitySchemes` → AuthHint（内核 AppAuth 的形状）：apiKey（header / query）、http bearer / basic、
 * oauth2 的 clientCredentials / authorizationCode 流。cookie 里的 API key、其他 http scheme、OpenID Connect、
 * implicit / password 流不支持，略过。
 */
export function authHints(doc: Record<string, unknown>): AuthHint[] {
  const components = isObj(doc.components) ? doc.components : {};
  const schemes = isObj(components.securitySchemes) ? components.securitySchemes : {};
  const resolver = new RefResolver(doc);
  const out: AuthHint[] = [];
  for (const [scheme, rawScheme] of Object.entries(schemes)) {
    let s: unknown;
    try {
      s = resolver.resolve(rawScheme);
    } catch {
      continue;
    }
    if (!isObj(s)) continue;
    const description = str(s.description);
    const base = { scheme, ...(description !== undefined && { description }) };
    if (s.type === "apiKey") {
      const name = str(s.name);
      if (name && (s.in === "header" || s.in === "query")) {
        out.push({ ...base, type: "api_key", in: s.in, name });
      }
    } else if (s.type === "http") {
      const httpScheme = typeof s.scheme === "string" ? s.scheme.toLowerCase() : "";
      if (httpScheme === "bearer") out.push({ ...base, type: "bearer" });
      else if (httpScheme === "basic") out.push({ ...base, type: "basic" });
    } else if (s.type === "oauth2" && isObj(s.flows)) {
      const cc = s.flows.clientCredentials;
      if (isObj(cc) && str(cc.tokenUrl)) {
        out.push({
          ...base,
          type: "oauth_client",
          tokenUrl: str(cc.tokenUrl) as string,
          scopes: scopesOf(cc),
        });
      }
      const ac = s.flows.authorizationCode;
      if (isObj(ac) && str(ac.tokenUrl) && str(ac.authorizationUrl)) {
        out.push({
          ...base,
          type: "oauth_code",
          authorizationUrl: str(ac.authorizationUrl) as string,
          tokenUrl: str(ac.tokenUrl) as string,
          scopes: scopesOf(ac),
        });
      }
    }
  }
  return out;
}
