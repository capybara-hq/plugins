import { platformOnly, secret, ui } from "@capybara-hq/plugin-sdk";
import { z } from "zod";

/**
 * Directory (`directory@1`) credentials: the Slack workspace id and a bot token (may equal a channel
 * connection's token, but is configured separately). Both may stay empty: an org that only uses the channel
 * needs no directory; `Directory.configured` then tells the kernel the directory is not configured
 * (Ruling A28, the kernel skips the sync silently). `teamId` takes only a workspace id (`T…`): the tenant is
 * the workspace (Ruling A26); an enterprise id (`E…`) would split one person into two identity rows.
 */
export const SlackDirectory = z.object({
  teamId: ui(
    z
      .string()
      .regex(/^T[A-Z0-9]+$/, "must be a Slack workspace team id such as T0123ABCD")
      .optional(),
    {
      label: { zh: "工作区 ID", en: "Workspace ID" },
      help: {
        zh: "选填：和机器人令牌一起用于把 Slack 成员同步到组织；只用机器人收发消息时不用填。",
        en: "Optional: used with the bot token to sync Slack members into the org. Leave empty if you only use the bot for chat.",
      },
      placeholder: "T0123ABCD",
    },
  ),
  botToken: ui(secret(z.string().regex(/^xoxb-/, "must be a bot token starting with xoxb-")), {
    label: { zh: "机器人令牌", en: "Bot token" },
    help: {
      zh: "选填，仅用于成员同步；聊天用的令牌在新建渠道连接时填。",
      en: "Optional, only for member sync. The tokens for chat go into the channel connection you create under Channels.",
    },
    placeholder: "xoxb-…",
  }).optional(),
});
export type SlackDirectoryConfig = z.infer<typeof SlackDirectory>;

/**
 * Deployment config. `apiUrl` / `openidUrl` are overridden only for tests or a proxy. `clientId` /
 * `clientSecret` are the OAuth client of Sign in with Slack (`identity-source@1`), empty when only the bot is
 * used; `clientSecret` is a secret (masked in logs).
 *
 * Those four are platform-only: `channel@1` (the Socket Mode WebSocket) and login (before an org is known)
 * carry no org config. `directory` is overridable: an org saves its own workspace and token, otherwise it
 * follows the platform's.
 */
export const SlackDeployment = z.object({
  apiUrl: platformOnly(
    ui(z.string().url().default("https://slack.com/api/"), {
      label: { zh: "API 地址", en: "API URL" },
    }),
  ),
  openidUrl: platformOnly(
    ui(z.string().url().default("https://slack.com/"), {
      label: { zh: "OpenID 地址", en: "OpenID URL" },
    }),
  ),
  clientId: platformOnly(
    ui(z.string().min(1).optional(), { label: { zh: "客户端 ID", en: "Client ID" } }),
  ),
  // the marks sit on the inner node: an outer meta would hide its secret() from the kernel
  clientSecret: platformOnly(
    ui(secret(z.string().min(1)), { label: { zh: "客户端密钥", en: "Client secret" } }),
  ).optional(),
  directory: ui(SlackDirectory.partial().optional(), {
    label: { zh: "通讯录", en: "Directory" },
    help: {
      zh: "跟随平台的每个组织都会同步这个租户的成员",
      en: "Every organization that follows the platform syncs this tenant's members",
    },
  }),
});
export type SlackDeploymentConfig = z.infer<typeof SlackDeployment>;

/** The platform-only part of the deployment config (what `setup` reads from `ctx.config`). */
export const SlackPlatform = SlackDeployment.omit({ directory: true });
export type SlackPlatformConfig = z.infer<typeof SlackPlatform>;

/**
 * The directory credentials of an org's effective config (`config.directory`); undefined unless both are
 * set and valid. Reads only the `directory` key.
 */
export function directoryCredsOf(
  config: unknown,
): { teamId: string; botToken: string } | undefined {
  const raw =
    typeof config === "object" && config !== null
      ? (config as Record<string, unknown>).directory
      : undefined;
  const r = SlackDirectory.safeParse(raw ?? {});
  return r.success && r.data.teamId !== undefined && r.data.botToken !== undefined
    ? { teamId: r.data.teamId, botToken: r.data.botToken }
    : undefined;
}

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
