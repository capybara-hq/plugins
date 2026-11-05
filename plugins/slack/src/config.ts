import { secret, ui } from "@capybara-hq/plugin-sdk";
import { z } from "zod";

/**
 * 部署级配置。`apiUrl` / `openidUrl` 只为测试或代理改写。`clientId` / `clientSecret` 是 Sign in with Slack
 * （`identity-source@1`）的 OAuth 客户端，只用机器人时不填；`clientSecret` 走密钥（日志打码）。
 */
export const SlackDeployment = z.object({
  apiUrl: ui(z.string().url().default("https://slack.com/api/"), {
    label: { zh: "API 地址", en: "API URL" },
  }),
  openidUrl: ui(z.string().url().default("https://slack.com/"), {
    label: { zh: "OpenID 地址", en: "OpenID URL" },
  }),
  clientId: ui(z.string().min(1).optional(), { label: { zh: "客户端 ID", en: "Client ID" } }),
  clientSecret: ui(secret(z.string().min(1)), {
    label: { zh: "客户端密钥", en: "Client secret" },
  }).optional(),
});
export type SlackDeploymentConfig = z.infer<typeof SlackDeployment>;

/**
 * 组织级配置：通讯录（`directory@1`）的 Slack 工作区 id 与机器人令牌（可与某个渠道连接用同一个令牌，但配置独立）。
 * 两项都可不填：组织只用渠道时启用插件不需要通讯录配置；`Directory.configured` 据此告诉内核通讯录未配置
 * （Ruling A28，内核静默跳过同步）。`teamId` 只收工作区 id（`T…`）：租户是工作区（Ruling A26），企业 id（`E…`）
 * 会把同一个人拆成两行身份。
 */
export const SlackDirectoryConfig = z.object({
  teamId: ui(
    z
      .string()
      .regex(/^T[A-Z0-9]+$/, "must be a Slack workspace team id such as T0123ABCD")
      .optional(),
    { label: { zh: "工作区 ID", en: "Workspace ID" } },
  ),
  botToken: ui(secret(z.string().regex(/^xoxb-/, "must be a bot token starting with xoxb-")), {
    label: { zh: "机器人令牌", en: "Bot token" },
  }).optional(),
});
export type SlackDirectoryConfigValue = z.infer<typeof SlackDirectoryConfig>;

/** Slack 的 OpenID Connect 签发者（https://slack.com/.well-known/openid-configuration ，2026-10-20 查阅）。 */
export const SLACK_ISSUER = "https://slack.com";

/**
 * `auth.test` 结果是否来自工作区令牌（租户是工作区，Ruling A26）：组织级安装（`is_enterprise_install`）或
 * `team_id` 不是 `T…` 时返回说明（不含凭据），否则 undefined。渠道 `verify` 与通讯录共用同一套文案。
 */
export function workspaceTokenProblem(auth: {
  team_id?: unknown;
  is_enterprise_install?: unknown;
}): string | undefined {
  if (auth.is_enterprise_install === true)
    return "Slack bot token comes from an org-wide (enterprise) install; use a workspace bot token";
  const team = typeof auth.team_id === "string" && auth.team_id !== "" ? auth.team_id : undefined;
  if (team === undefined || !team.startsWith("T"))
    return `Slack bot token is not a workspace token (team ${team ?? "(unknown)"}); use a workspace bot token`;
  return undefined;
}
