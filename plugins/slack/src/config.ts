import { secret } from "@capybara-hq/plugin-sdk";
import { z } from "zod";

/**
 * 部署级配置。`apiUrl` / `openidUrl` 只为测试或代理改写。`clientId` / `clientSecret` 是 Sign in with Slack
 * （`identity-source@1`）的 OAuth 客户端，只用机器人时不填；`clientSecret` 走密钥（日志打码）。
 */
export const SlackDeployment = z.object({
  apiUrl: z.string().url().default("https://slack.com/api/"),
  openidUrl: z.string().url().default("https://slack.com/"),
  clientId: z.string().min(1).optional(),
  clientSecret: secret(z.string().min(1)).optional(),
});
export type SlackDeploymentConfig = z.infer<typeof SlackDeployment>;

/**
 * 组织级配置：通讯录（`directory@1`）的 Slack 工作区 id 与机器人令牌（可与某个渠道连接用同一个令牌，但配置独立）。
 * 两项都可不填：组织只用渠道时启用插件不需要通讯录配置；`Directory.configured` 据此告诉内核通讯录未配置
 * （Ruling A28，内核静默跳过同步）。`teamId` 只收工作区 id（`T…`）：租户是工作区（Ruling A26），企业 id（`E…`）
 * 会把同一个人拆成两行身份。
 */
export const SlackDirectoryConfig = z.object({
  teamId: z
    .string()
    .regex(/^T[A-Z0-9]+$/, "must be a Slack workspace team id such as T0123ABCD")
    .optional(),
  botToken: secret(
    z.string().regex(/^xoxb-/, "must be a bot token starting with xoxb-"),
  ).optional(),
});
export type SlackDirectoryConfigValue = z.infer<typeof SlackDirectoryConfig>;

/** Slack 的 OpenID Connect 签发者（https://slack.com/.well-known/openid-configuration ，2026-10-20 查阅）。 */
export const SLACK_ISSUER = "https://slack.com";
