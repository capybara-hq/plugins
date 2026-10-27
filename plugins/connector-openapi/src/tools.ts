import type { ToolAnnotations, ToolSpec } from "@capybara-hq/plugin-sdk";
import type { Route } from "./route.js";
import type { Operation, ParamLocation } from "./spec.js";

/** 描述正文（summary + description）的字符上限，超出截断并注明。 */
export const MAX_DESCRIPTION = 1024;
const TRUNCATED = " [Description truncated]";

/** 参数分组在 inputSchema 里的属性名。 */
const GROUPS: Record<ParamLocation, string> = { path: "path", query: "query", header: "headers" };

/** 注解：GET / HEAD 只读；DELETE 有破坏性；其余不给（内核推导为 ask）。 */
export function annotationsOf(op: Operation): ToolAnnotations | undefined {
  if (op.method === "get" || op.method === "head") return { readOnlyHint: true };
  if (op.method === "delete") return { destructiveHint: true };
  return undefined;
}

/** 描述：summary + description（合计截到 1024 字符并注明），再附上方法与完整地址（服务器 + 路径模板）、补充说明。 */
export function descriptionOf(op: Operation, server: string | null = null): string {
  let text = [op.summary, op.description].filter((x) => x !== undefined).join("\n\n");
  if (text.length > MAX_DESCRIPTION) {
    text = `${text.slice(0, MAX_DESCRIPTION - TRUNCATED.length).trimEnd()}${TRUNCATED}`;
  }
  // 带上解析好的服务器地址：换了服务器也会体现在复核对比的描述里
  const endpoint = `HTTP: ${op.method.toUpperCase()} ${server === null ? "" : server.replace(/\/+$/, "")}${op.path}`;
  return [text, endpoint, ...op.notes].filter((x) => x !== "").join("\n\n");
}

/**
 * inputSchema：`{ path?, query?, headers?, body? }` 中实际存在的部分；分组内有必填参数时分组本身必填，
 * 请求体 `required` 时 body 必填。分组不允许额外属性（未声明的头 / 参数不发送）。
 */
export function inputSchemaOf(op: Operation): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const loc of ["path", "query", "header"] as const) {
    const params = op.params.filter((p) => p.in === loc);
    if (params.length === 0) continue;
    const req = params.filter((p) => p.required).map((p) => p.name);
    properties[GROUPS[loc]] = {
      type: "object",
      properties: Object.fromEntries(params.map((p) => [p.name, p.schema])),
      ...(req.length > 0 && { required: req }),
      additionalProperties: false,
    };
    if (req.length > 0) required.push(GROUPS[loc]);
  }
  if (op.body) {
    properties.body = op.body.schema;
    if (op.body.required) required.push("body");
  }
  return {
    type: "object",
    properties,
    ...(required.length > 0 && { required }),
    additionalProperties: false,
  };
}

/** Longest display title kept from an operation's summary, in code points. */
const TITLE_MAX = 80;

/**
 * An operation's summary as the tool's display title (conversation rows and approvals), cleaned
 * the way the kernel cleans remote titles (the kernel is the authority and cleans again): format
 * characters except ZWNJ / ZWJ removed, control characters (newlines included) turned into spaces,
 * whitespace collapsed, trimmed and cut to 80 code points; undefined when nothing is left.
 */
export function displayTitle(summary: string | undefined): string | undefined {
  if (summary === undefined) return undefined;
  const clean = summary
    .replace(/(?![\u200C\u200D])\p{Cf}/gu, "")
    .replace(/\p{Cc}/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  const cut = [...clean].slice(0, TITLE_MAX).join("").trimEnd();
  return cut === "" ? undefined : cut;
}

/** 工具定义；`route` 写进 connectorData（计入内核指纹，调用时交回，不发给模型）。 */
export function toolSpecOf(op: Operation, route: Route): ToolSpec {
  const annotations = annotationsOf(op);
  const title = displayTitle(op.summary);
  return {
    name: op.toolName,
    ...(title !== undefined && { title }),
    description: descriptionOf(op, route.server),
    inputSchema: inputSchemaOf(op),
    ...(annotations && { annotations }),
    connectorData: route,
  };
}
