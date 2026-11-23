import { platformOnly, secret, ui } from "@capybara-hq/plugin-sdk";
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
 * Directory (`directory@1`) credentials: a Lark custom app (the same app as the org's bot connection and
 * the deployment's login app, since `open_id` differs per app). Both fields may stay empty: an org that
 * only uses the bot needs no directory; `Directory.configured` then tells the kernel the directory is not
 * configured (Ruling A28, the kernel skips the sync silently).
 */
export const LarkDirectory = z
  .object({
    appId: ui(LarkAppId, { label: { zh: "应用 ID", en: "App ID" } }),
    appSecret: ui(secret(z.string().min(1)), { label: { zh: "应用密钥", en: "App secret" } }),
  })
  .partial();
export type LarkDirectoryConfig = z.infer<typeof LarkDirectory>;

/**
 * Deployment config. `region` picks the open platform (only `lark`); `apiUrl` / `accountsUrl` override
 * the open platform root (also the long connection endpoint `<apiUrl>/callback/ws/endpoint`) and the
 * authorization page root, for tests or a proxy.
 *
 * `appId` / `appSecret`: the custom app of web login (`identity-source@1`); empty when only the bot is
 * used. **The bot (channel connections) and the directory of every org must use the same Lark app**:
 * `open_id` differs per app, so with another app the same person gets another `open_id` and login, bot and
 * directory identities no longer match. When verifying a channel connection or syncing the directory, the
 * plugin fails if the same tenant uses an app other than the login app.
 *
 * The login and API-base fields are platform-only: `channel@1` and `identity-source@1` carry no org config
 * (login runs before an org is known), and the long connection cannot go through `ctx.net`. `directory` is
 * overridable: an org saves its own app, otherwise it follows the platform's.
 */
export const LarkDeployment = z.object({
  region: platformOnly(
    ui(
      z
        .enum(["lark", "feishu"])
        .default("lark")
        .refine((r) => r === "lark", {
          message: "region feishu is reserved; only lark is supported",
        }),
      { label: { zh: "区域", en: "Region" } },
    ),
  ),
  apiUrl: platformOnly(
    ui(z.string().url().optional(), { label: { zh: "开放平台地址", en: "Open platform URL" } }),
  ),
  accountsUrl: platformOnly(
    ui(z.string().url().optional(), { label: { zh: "授权页地址", en: "Authorization page URL" } }),
  ),
  appId: platformOnly(ui(LarkAppId.optional(), { label: { zh: "应用 ID", en: "App ID" } })),
  // the marks sit on the inner node: an outer meta would hide its secret() from the kernel
  appSecret: platformOnly(
    ui(secret(z.string().min(1)), { label: { zh: "应用密钥", en: "App secret" } }),
  ).optional(),
  directory: ui(LarkDirectory.optional(), {
    label: { zh: "通讯录", en: "Directory" },
    help: {
      zh: "跟随平台的每个组织都会同步这个租户的成员",
      en: "Every organization that follows the platform syncs this tenant's members",
    },
  }),
});
export type LarkDeploymentConfig = z.infer<typeof LarkDeployment>;

/** The platform-only part of the deployment config (what `setup` reads from `ctx.config`). */
export const LarkPlatform = LarkDeployment.omit({ directory: true });
export type LarkPlatformConfig = z.infer<typeof LarkPlatform>;

/**
 * The directory credentials of an org's effective config (`config.directory`); undefined unless both are
 * set and valid. Reads only the `directory` key, never the platform-only login app.
 */
export function directoryAppOf(config: unknown): { appId: string; appSecret: string } | undefined {
  const raw =
    typeof config === "object" && config !== null
      ? (config as Record<string, unknown>).directory
      : undefined;
  const r = LarkDirectory.safeParse(raw ?? {});
  return r.success && r.data.appId !== undefined && r.data.appSecret !== undefined
    ? { appId: r.data.appId, appSecret: r.data.appSecret }
    : undefined;
}

/** 开放平台根地址（不带末尾斜杠）。 */
export function apiBaseOf(c: LarkPlatformConfig): string {
  return (c.apiUrl ?? REGION_DOMAINS.lark).replace(/\/+$/, "");
}

/** 网页授权页根地址（不带末尾斜杠）。 */
export function accountsBaseOf(c: LarkPlatformConfig): string {
  return (c.accountsUrl ?? REGION_ACCOUNTS.lark).replace(/\/+$/, "");
}

/** 部署级登录应用的凭据；没配全时为 undefined。 */
export function loginAppOf(
  c: LarkPlatformConfig,
): { appId: string; appSecret: string } | undefined {
  return c.appId !== undefined && c.appSecret !== undefined
    ? { appId: c.appId, appSecret: c.appSecret }
    : undefined;
}
