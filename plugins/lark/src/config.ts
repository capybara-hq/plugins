import { secret } from "@capybara-hq/plugin-sdk";
import { z } from "zod";

/** 各区域的开放平台域名。`feishu`（飞书，国内）先在枚举里预留，M4 只支持 `lark`（国际版）。 */
export const REGION_DOMAINS = { lark: "https://open.larksuite.com" } as const;
/**
 * 各区域网页授权页的域名（https://open.larksuite.com/document/common-capabilities/sso/api/obtain-oauth-code ，
 * 2026-10-20 查阅：授权页为 `https://accounts.larksuite.com/open-apis/authen/v1/authorize`）。
 */
export const REGION_ACCOUNTS = { lark: "https://accounts.larksuite.com" } as const;

/**
 * 自建应用的 App ID（开发者后台「凭证与基础信息」）。格式按 SDK `WSClient.start()` 的校验（`cli_` + 16 位十六进制；
 * 不符时它只打日志、什么也不做）。
 */
export const LarkAppId = z
  .string()
  .regex(/^cli_[0-9a-fA-F]{16}$/, "must be a Lark App ID such as cli_a1b2c3d4e5f60718");

/**
 * 部署级配置。`region` 选择开放平台（只支持 `lark`）；`apiUrl` / `accountsUrl` 只为测试或代理改写开放平台根地址
 * （长连接的接入点 `<apiUrl>/callback/ws/endpoint` 也在这里）与授权页根地址。
 *
 * `appId` / `appSecret`：网页登录（`identity-source@1`）用的自建应用，只用机器人时不填。**必须与各组织的机器人
 * （渠道连接）和通讯录用同一个 Lark 应用**：`open_id` 按应用区分，换个应用同一个人的 `open_id` 就不同，登录、
 * 机器人、通讯录三处的身份就对不上。插件在校验渠道连接与同步通讯录时，若发现同一租户用了与登录不同的应用就报错。
 */
export const LarkDeployment = z.object({
  region: z
    .enum(["lark", "feishu"])
    .default("lark")
    .refine((r) => r === "lark", { message: "region feishu is reserved; only lark is supported" }),
  apiUrl: z.string().url().optional(),
  accountsUrl: z.string().url().optional(),
  appId: LarkAppId.optional(),
  appSecret: secret(z.string().min(1)).optional(),
});
export type LarkDeploymentConfig = z.infer<typeof LarkDeployment>;

/**
 * 组织级配置：通讯录（`directory@1`）用的自建应用凭据（与该组织的机器人连接、部署级登录用同一个应用）。两项都可
 * 不填：组织只用机器人时启用插件不需要通讯录配置；`Directory.configured` 据此告诉内核通讯录未配置（Ruling A28，
 * 内核静默跳过同步）。
 */
export const LarkOrgConfig = z.object({
  appId: LarkAppId.optional(),
  appSecret: secret(z.string().min(1)).optional(),
});
export type LarkOrgConfigValue = z.infer<typeof LarkOrgConfig>;

/** 开放平台根地址（不带末尾斜杠）。 */
export function apiBaseOf(c: LarkDeploymentConfig): string {
  return (c.apiUrl ?? REGION_DOMAINS.lark).replace(/\/+$/, "");
}

/** 网页授权页根地址（不带末尾斜杠）。 */
export function accountsBaseOf(c: LarkDeploymentConfig): string {
  return (c.accountsUrl ?? REGION_ACCOUNTS.lark).replace(/\/+$/, "");
}

/** 部署级登录应用的凭据；没配全时为 undefined。 */
export function loginAppOf(
  c: LarkDeploymentConfig,
): { appId: string; appSecret: string } | undefined {
  return c.appId !== undefined && c.appSecret !== undefined
    ? { appId: c.appId, appSecret: c.appSecret }
    : undefined;
}
