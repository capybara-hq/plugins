import { ToolError, type ToolSpec } from "@capybara-hq/plugin-sdk";
import { z } from "zod";
import { METHODS, type Operation } from "./spec.js";

/**
 * 一个操作的路由（Ruling A21）：listTools 时写进工具定义的 `connectorData`，内核把它计入指纹、存进快照，
 * 调用时经 `ctx.spec` 原样交回。调用只按它构造请求，不再读取文档——远端改了方法 / 路径 / 参数 / 服务器，
 * 只会让新定义的指纹变化、进入漂移复核，复核通过之前仍按旧路由执行。
 */
const RouteSchema = z
  .object({
    method: z.enum(METHODS),
    path: z.string().startsWith("/").max(2000),
    /** 解析后的服务器地址（变量取默认值、相对地址按文档地址解析）；解析不出为 null（调用时需 baseUrl）。 */
    server: z.string().max(2000).nullable(),
    params: z
      .array(
        z
          .object({
            name: z.string().min(1).max(200),
            in: z.enum(["path", "query", "header"]),
            style: z.string().max(40),
            explode: z.boolean(),
            json: z.boolean(),
          })
          .strict(),
      )
      .max(500),
    body: z
      .object({ mediaType: z.string().min(1).max(200), json: z.boolean(), required: z.boolean() })
      .strict()
      .optional(),
  })
  .strict();

export type Route = z.infer<typeof RouteSchema>;
export type RouteParam = Route["params"][number];

/** 服务器地址：操作的 servers[0]（变量取默认值），缺省为文档地址的根；相对地址按文档地址解析。解析不出 → null。 */
function serverOf(op: Operation, specUrl: string | undefined): string | null {
  const server = op.servers[0];
  let raw = "/";
  if (typeof server === "object" && server !== null && !Array.isArray(server)) {
    const s = server as Record<string, unknown>;
    if (typeof s.url === "string") {
      const vars =
        typeof s.variables === "object" && s.variables !== null
          ? (s.variables as Record<string, unknown>)
          : {};
      raw = s.url.replace(/\{([^}]+)\}/g, (m, name: string) => {
        const v = vars[name] as { default?: unknown } | undefined;
        return typeof v?.default === "string" ? v.default : m;
      });
      if (/\{[^}]*\}/.test(raw)) return null;
    }
  }
  try {
    return (specUrl === undefined ? new URL(raw) : new URL(raw, specUrl)).href;
  } catch {
    return null;
  }
}

/** 操作 → 路由（写进 connectorData）。 */
export function routeOf(op: Operation, specUrl: string | undefined): Route {
  return {
    method: op.method,
    path: op.path,
    server: serverOf(op, specUrl),
    params: op.params.map((p) => ({
      name: p.name,
      in: p.in,
      style: p.style,
      explode: p.explode,
      json: p.json,
    })),
    ...(op.body && {
      body: { mediaType: op.body.mediaType, json: op.body.json, required: op.body.required },
    }),
  };
}

/** 从内核交回的已复核定义里取路由；没有或不合规 → ToolError（提示刷新应用）。 */
export function routeFromSpec(name: string, spec: ToolSpec | undefined): Route {
  const r = RouteSchema.safeParse(spec?.connectorData);
  if (!r.success) {
    throw new ToolError(
      `Tool "${name}" has no usable routing information in its reviewed definition; ask an administrator to refresh the app and review its tools.`,
    );
  }
  return r.data;
}
