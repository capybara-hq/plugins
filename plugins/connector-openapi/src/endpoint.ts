import { z } from "zod";

/** 文档（specText 或从 specUrl 取到的）最大字节数。 */
export const MAX_SPEC_BYTES = 2 * 1024 * 1024;

// capybara:allow-module-state 只读常量表
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** 本机 http 只认这三个确切的主机名（`localhost.`、`localhost.evil.com` 等一律不算）。 */
const isLoopbackHttp = (u: URL): boolean =>
  u.protocol === "http:" && LOOPBACK_HOSTS.has(u.hostname);

/** URL 是否可用：https，或部署配置允许时的本机 http。 */
export function urlAllowed(u: URL, allowInsecureLoopback: boolean): boolean {
  if (u.protocol === "https:") return true;
  return allowInsecureLoopback && isLoopbackHttp(u);
}

const urlRule = (allowInsecureLoopback: boolean) =>
  allowInsecureLoopback
    ? "URL must use https (plain http is only allowed for 127.0.0.1, localhost and [::1])"
    : "URL must use https";

const parsesAllowed = (raw: string, allowInsecureLoopback: boolean): boolean => {
  try {
    return urlAllowed(new URL(raw), allowInsecureLoopback);
  } catch {
    return true; // 交给 z.url() 报格式错误
  }
};

/**
 * 端点：`specUrl`（取文档，不带凭据）与 `specText`（直接给出文档，JSON 或 YAML，≤ 2 MB）二选一；
 * `baseUrl` 覆盖文档的 `servers`；`operations` 勾选的操作 id（缺省 = 全部）。URL 须为 https，
 * 部署配置 `allowInsecureLoopback` 打开时（仅供开发与测试）本机 http 例外。
 */
export function endpointSchema(allowInsecureLoopback: boolean) {
  const url = () =>
    z
      .url()
      .max(2000)
      .refine((v) => parsesAllowed(v, allowInsecureLoopback), {
        message: urlRule(allowInsecureLoopback),
      });
  return z
    .object({
      specUrl: url().optional(),
      specText: z
        .string()
        .min(1)
        .refine((v) => Buffer.byteLength(v, "utf8") <= MAX_SPEC_BYTES, {
          message: "The OpenAPI document must be at most 2 MB",
        })
        .optional(),
      baseUrl: url().optional(),
      operations: z.array(z.string().min(1).max(200)).min(1).max(1000).optional(),
    })
    .strict()
    .superRefine((e, ctx) => {
      if ((e.specUrl === undefined) === (e.specText === undefined)) {
        ctx.addIssue({
          code: "custom",
          path: ["specUrl"],
          message: "Provide exactly one of specUrl and specText",
        });
      }
    });
}

export type OpenApiEndpoint = z.infer<ReturnType<typeof endpointSchema>>;

/** 文档里的 server / baseUrl 不可用时的说明（模型可见，英文）。 */
export const serverUrlText = (allowInsecureLoopback: boolean) =>
  `The API base URL is not allowed: ${urlRule(allowInsecureLoopback)}. Ask an administrator to set the app's baseUrl to an https URL.`;
