import { z } from "zod";

/** 各区域的开放平台域名。`feishu`（飞书，国内）先在枚举里预留，M4 只支持 `lark`（国际版）。 */
export const REGION_DOMAINS = { lark: "https://open.larksuite.com" } as const;

/**
 * 部署级配置。`region` 选择开放平台（只支持 `lark`）；`apiUrl` 只为测试或代理改写开放平台根地址
 * （长连接的接入点 `<apiUrl>/callback/ws/endpoint` 也在这里）。
 */
export const LarkDeployment = z.object({
  region: z
    .enum(["lark", "feishu"])
    .default("lark")
    .refine((r) => r === "lark", { message: "region feishu is reserved; only lark is supported" }),
  apiUrl: z.string().url().optional(),
});
export type LarkDeploymentConfig = z.infer<typeof LarkDeployment>;

/** 开放平台根地址（不带末尾斜杠）。 */
export function apiBaseOf(c: LarkDeploymentConfig): string {
  return (c.apiUrl ?? REGION_DOMAINS.lark).replace(/\/+$/, "");
}
