import {
  type ConnectorOpenArgs,
  type Logger,
  ToolError,
  type ToolResult,
} from "@capybara-hq/plugin-sdk";
import { serverUrlText, urlAllowed } from "./endpoint.js";
import type { Route, RouteParam } from "./route.js";
import { CREDENTIAL_HEADER, RESERVED_HEADERS } from "./spec.js";

/** 401 刷新重试后仍失败（模型可见，英文）。 */
export const AUTH_FAILED_TEXT = "Authentication failed for this app; ask the user to reconnect it.";

/** 连不上服务（模型可见，英文）。 */
export const UNREACHABLE_TEXT =
  "Could not reach the app's server. Retry later, or ask an administrator to check the app.";

/** 服务以 3xx 响应（不跟随，模型可见，英文）。 */
export const redirectText = (status: number) =>
  `The app's server responded with a redirect (HTTP ${status}); redirects are not followed. Ask an administrator to check the app endpoint URL.`;

/** 非 2xx 结果里附带的正文最多字符数。 */
const MAX_ERROR_BODY = 4_000;
/** ToolError（5xx）消息里附带的正文最多字符数。 */
const MAX_UNAVAILABLE_BODY = 500;
/** 写进日志的上游错误正文最多字符数。 */
const MAX_LOGGED_BODY = 1_000;

export interface Limits {
  /** 文档最大字节数。 */
  maxSpecBytes: number;
  /** 响应正文最多读取的字节数（超出截断并注明）。 */
  maxResponseBytes: number;
  /** 取文档的时限（毫秒）；工具调用的时限由内核经 signal 控制。 */
  specTimeoutMs: number;
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** 读正文，最多 `max` 字节；超出时取消剩余部分并标记截断。 */
async function readCapped(
  res: Response,
  max: number,
): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  if (!res.body) return { bytes: new Uint8Array(), truncated: false };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (size + value.byteLength > max) {
      chunks.push(value.subarray(0, max - size));
      size = max;
      truncated = true;
      await reader.cancel().catch(() => {});
      break;
    }
    chunks.push(value);
    size += value.byteLength;
  }
  const bytes = new Uint8Array(size);
  let off = 0;
  for (const c of chunks) {
    bytes.set(c, off);
    off += c.byteLength;
  }
  return { bytes, truncated };
}

/** fetch 抛错：连接失败与我们自己的时限 → ToolError（unavailable）；调用方的中止原样抛出。 */
function mapFetchError(e: unknown, outer: AbortSignal): unknown {
  if (outer.aborted) return e;
  if (e instanceof TypeError && e.message === "fetch failed") {
    return new ToolError(UNREACHABLE_TEXT, { kind: "unavailable" });
  }
  // 其余 TypeError 是请求构造错误（如 GET 带请求体、非法 URL / 头），说明远端无关：kind error，不计入熔断
  if (e instanceof TypeError) {
    return new ToolError(
      "The request could not be sent because it is malformed; check the arguments, or ask an administrator to refresh the app if it keeps failing.",
    );
  }
  if (e instanceof DOMException && e.name === "TimeoutError") {
    return new ToolError(
      "The app's server did not respond in time. Retry later, or ask an administrator to check the app.",
      { kind: "unavailable" },
    );
  }
  return e;
}

async function noRedirect(res: Response): Promise<void> {
  if (res.status >= 300 && res.status < 400) {
    await res.body?.cancel();
    throw new ToolError(redirectText(res.status));
  }
}

/** 取文档（不带凭据）：不跟随重定向、限时、限大小；非 2xx → ToolError（5xx 为 unavailable）。 */
export async function fetchSpec(url: string, signal: AbortSignal, limits: Limits): Promise<string> {
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { accept: "application/json, application/yaml;q=0.9, text/yaml;q=0.9, */*;q=0.5" },
      redirect: "manual",
      signal: AbortSignal.any([signal, AbortSignal.timeout(limits.specTimeoutMs)]),
    });
  } catch (e) {
    throw mapFetchError(e, signal);
  }
  await noRedirect(res);
  if (!res.ok) {
    await res.body?.cancel();
    throw new ToolError(
      `Fetching the app's OpenAPI document failed with HTTP ${res.status}. Retry later, or ask an administrator to check the document URL.`,
      { kind: res.status >= 500 ? "unavailable" : "error" },
    );
  }
  const tooLarge = () =>
    new ToolError(
      `The app's OpenAPI document is larger than ${limits.maxSpecBytes} bytes. Ask an administrator to check the document.`,
    );
  const len = Number(res.headers.get("content-length") ?? "");
  if (Number.isFinite(len) && len > limits.maxSpecBytes) {
    await res.body?.cancel();
    throw tooLarge();
  }
  let body: { bytes: Uint8Array; truncated: boolean };
  try {
    body = await readCapped(res, limits.maxSpecBytes);
  } catch (e) {
    throw mapFetchError(e, signal);
  }
  if (body.truncated) throw tooLarge();
  return new TextDecoder().decode(body.bytes);
}

/**
 * 调用的服务器地址：端点的 baseUrl 覆盖，否则用路由里（listTools 时解析好的）服务器地址；
 * 每次调用都按 https / 本机规则校验（文档里的 server 不受信任）。
 */
export function resolveBaseUrl(
  server: string | null,
  baseUrl: string | undefined,
  allowInsecureLoopback: boolean,
): URL {
  const raw = baseUrl ?? server;
  let u: URL | undefined;
  try {
    u = raw === null ? undefined : new URL(raw);
  } catch {
    u = undefined;
  }
  if (!u) {
    throw new ToolError(
      "The OpenAPI document declares no usable absolute server URL; ask an administrator to set the app's baseUrl.",
    );
  }
  if (u.username !== "" || u.password !== "") {
    throw new ToolError(
      "The API base URL must not contain a user name or password; ask an administrator to set the app's baseUrl without credentials.",
    );
  }
  if (!urlAllowed(u, allowInsecureLoopback)) {
    throw new ToolError(serverUrlText(allowInsecureLoopback));
  }
  return u;
}

const scalar = (v: unknown): string =>
  v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);

/** 路径参数（simple 风格）：数组逗号拼接，对象 `k,v,k,v`（explode 时 `k=v,k=v`）。 */
function pathValue(p: RouteParam, v: unknown): string {
  if (p.json) return JSON.stringify(v);
  if (Array.isArray(v)) return v.map(scalar).join(",");
  if (isObj(v)) {
    return Object.entries(v)
      .map(([k, x]) => (p.explode ? `${k}=${scalar(x)}` : `${k},${scalar(x)}`))
      .join(",");
  }
  return scalar(v);
}

/** query 参数：form（默认 explode）、spaceDelimited / pipeDelimited、deepObject。 */
function appendQuery(q: URLSearchParams, p: RouteParam, v: unknown): void {
  if (p.json) {
    q.append(p.name, JSON.stringify(v));
    return;
  }
  if (Array.isArray(v)) {
    if (p.explode) {
      for (const x of v) q.append(p.name, scalar(x));
    } else {
      const sep = p.style === "spaceDelimited" ? " " : p.style === "pipeDelimited" ? "|" : ",";
      q.append(p.name, v.map(scalar).join(sep));
    }
    return;
  }
  if (isObj(v)) {
    if (p.style === "deepObject") {
      for (const [k, x] of Object.entries(v)) q.append(`${p.name}[${k}]`, scalar(x));
    } else if (p.explode) {
      for (const [k, x] of Object.entries(v)) q.append(k, scalar(x));
    } else {
      q.append(
        p.name,
        Object.entries(v)
          .flatMap(([k, x]) => [k, scalar(x)])
          .join(","),
      );
    }
    return;
  }
  q.append(p.name, scalar(v));
}

interface BuiltRequest {
  /** 路径与 query（不含鉴权注入），每次发送时再补上鉴权。 */
  url: URL;
  headers: Record<string, string>;
  body?: string;
}

/** 由工具参数构造请求（不含鉴权）；参数问题 → ToolError（说明哪个参数、怎么改）。 */
export function buildRequest(op: Route, input: unknown, base: URL): BuiltRequest {
  const inp = isObj(input) ? input : {};
  const group = (k: string) => (isObj(inp[k]) ? (inp[k] as Record<string, unknown>) : {});
  const pathArgs = group("path");
  const queryArgs = group("query");
  const headerArgs = group("headers");
  const byLoc = (loc: RouteParam["in"]) => op.params.filter((p) => p.in === loc);

  const path = op.path.replace(/\{([^}]+)\}/g, (_m, name: string) => {
    const p = byLoc("path").find((x) => x.name === name);
    const v = pathArgs[name];
    if (v === undefined || v === null || !p) {
      throw new ToolError(`Missing path parameter "${name}"; pass it as path.${name} and retry.`);
    }
    const s = pathValue(p, v);
    if (s === "") {
      throw new ToolError(
        `Invalid value for path parameter "${name}"; pass a non-empty value and retry.`,
      );
    }
    return encodeURIComponent(s);
  });

  // 多个参数拼起来也可能成为 `.` / `..` 段（如 `/{a}{b}`，a = b = "."）；逐段检查，含逐层解码后的 %2e 形式
  // 取值都经 encodeURIComponent（"/" 被编码），替换前后段数一致，可按下标找回模板段里的参数名
  const templateSegs = op.path.split("/");
  for (const [i, seg] of path.split("/").entries()) {
    let d = seg;
    for (let round = 0; round < 3; round++) {
      if (d === "." || d === "..") {
        const names = [...(templateSegs[i] ?? "").matchAll(/\{([^}]+)\}/g)].map((m) => m[1]);
        throw new ToolError(
          `Path parameter ${names.map((n) => `"${n}"`).join(", ") || "values"} form a "." or ".." path segment; pass values that do not combine into "." or "..".`,
        );
      }
      try {
        d = decodeURIComponent(d);
      } catch {
        break;
      }
    }
  }

  const url = new URL(base.href);
  url.hash = "";
  url.pathname = `${url.pathname.replace(/\/+$/, "")}${path}`;
  for (const p of byLoc("query")) {
    const v = queryArgs[p.name];
    if (v !== undefined) appendQuery(url.searchParams, p, v);
  }

  const headers: Record<string, string> = { accept: "application/json, */*;q=0.8" };
  const declared = new Map(byLoc("header").map((p) => [p.name.toLowerCase(), p]));
  for (const [name, v] of Object.entries(headerArgs)) {
    const lower = name.toLowerCase();
    if (RESERVED_HEADERS.has(lower) || CREDENTIAL_HEADER.test(lower)) {
      throw new ToolError(
        `Header "${name}" cannot be set through tool arguments (credentials come from the app's auth settings); retry without it.`,
      );
    }
    const p = declared.get(lower);
    if (!p) {
      throw new ToolError(
        `Header "${name}" is not a parameter of this operation; pass only the declared headers.`,
      );
    }
    if (v === undefined) continue;
    const value = p.json
      ? JSON.stringify(v)
      : Array.isArray(v)
        ? v.map(scalar).join(",")
        : scalar(v);
    // 头值只能是可见 ASCII / Latin-1 与空格、制表符（换行会被拒绝，也防请求头注入）
    if (!/^[\t\x20-\x7e\x80-\xff]*$/.test(value)) {
      throw new ToolError(
        `Header "${name}" has characters that are not allowed in HTTP headers (such as line breaks or non-Latin-1 text); pass a plain ASCII value.`,
      );
    }
    headers[p.name] = value;
  }

  if (op.body) {
    if (inp.body === undefined) {
      if (op.body.required) {
        throw new ToolError("This operation needs a request body; pass it as body and retry.");
      }
    } else {
      headers["content-type"] = op.body.mediaType;
      const body = op.body.json
        ? JSON.stringify(inp.body)
        : typeof inp.body === "string"
          ? inp.body
          : JSON.stringify(inp.body);
      return { url, headers, body };
    }
  }
  return { url, headers };
}

const TEXT_TYPE =
  /^(?:text\/|application\/(?:[\w.+-]*\+)?(?:json|xml|yaml|x-yaml|javascript|x-www-form-urlencoded|graphql)$)/;
const JSON_TYPE = /^application\/(?:[\w.+-]*\+)?json$/;

/** 正文 → 文本：JSON 美化、文本原样、二进制给出类型与大小。 */
function renderBody(
  contentType: string,
  bytes: Uint8Array,
  truncated: boolean,
  max: number,
): string {
  if (bytes.byteLength === 0) return "(empty body)";
  const media = (contentType.split(";")[0] ?? "").trim().toLowerCase();
  let text: string | undefined;
  if (media === "") {
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      text = undefined;
    }
  } else if (TEXT_TYPE.test(media)) {
    text = new TextDecoder().decode(bytes);
  }
  if (text === undefined) {
    const size = truncated ? `more than ${max} bytes` : `${bytes.byteLength} bytes`;
    return `[Binary response body (${media || "unknown type"}, ${size}) omitted]`;
  }
  if (JSON_TYPE.test(media) && !truncated) {
    try {
      text = JSON.stringify(JSON.parse(text), null, 2);
    } catch {
      // 不是合法 JSON：原样
    }
  }
  return truncated ? `${text}\n[Response truncated at ${max} bytes]` : text;
}

/**
 * 发送一次调用：每次发送前调用 `auth()` 合并鉴权头 / query（覆盖同名项）；不跟随重定向；
 * 401 → `onUnauthorized()` 后重试一次，仍 401 抛认证失败；5xx → ToolError（unavailable，正文截断记日志）；
 * 其他非 2xx → `isError` 结果（状态 + 正文）。
 */
export async function send(
  req: BuiltRequest,
  method: string,
  args: ConnectorOpenArgs,
  signal: AbortSignal,
  limits: Limits,
  log: Logger,
): Promise<ToolResult> {
  const combined = AbortSignal.any([signal, args.signal]);
  const once = async (): Promise<Response> => {
    const inj = await args.auth();
    const url = new URL(req.url.href);
    for (const [k, v] of Object.entries(inj.query ?? {})) url.searchParams.set(k, v);
    const headers = new Headers(req.headers);
    for (const [k, v] of Object.entries(inj.headers)) headers.set(k, v);
    try {
      return await fetch(url, {
        method: method.toUpperCase(),
        headers,
        ...(req.body !== undefined && { body: req.body }),
        redirect: "manual",
        signal: combined,
      });
    } catch (e) {
      throw mapFetchError(e, combined);
    }
  };
  let res = await once();
  await noRedirect(res);
  if (res.status === 401) {
    await res.body?.cancel();
    await args.onUnauthorized();
    res = await once();
    await noRedirect(res);
    if (res.status === 401) {
      await res.body?.cancel();
      throw new ToolError(AUTH_FAILED_TEXT);
    }
  }
  let body: { bytes: Uint8Array; truncated: boolean };
  try {
    body = await readCapped(res, limits.maxResponseBytes);
  } catch (e) {
    throw mapFetchError(e, combined);
  }
  const contentType = res.headers.get("content-type") ?? "";
  const rendered = renderBody(contentType, body.bytes, body.truncated, limits.maxResponseBytes);
  if (res.status >= 500) {
    log.warn("OpenAPI request failed", {
      status: res.status,
      body: rendered.slice(0, MAX_LOGGED_BODY),
    });
    const snippet = rendered.slice(0, MAX_UNAVAILABLE_BODY);
    throw new ToolError(
      `The app's server responded with HTTP ${res.status}: ${snippet}. Retry later, or ask an administrator to check the app.`,
      { kind: "unavailable" },
    );
  }
  const head = `HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ""}\ncontent-type: ${contentType || "(none)"}`;
  if (!res.ok) {
    const shown =
      rendered.length > MAX_ERROR_BODY
        ? `${rendered.slice(0, MAX_ERROR_BODY)}\n[Error body truncated]`
        : rendered;
    return { content: [{ type: "text", text: `${head}\n\n${shown}` }], isError: true };
  }
  return { content: [{ type: "text", text: `${head}\n\n${rendered}` }] };
}
