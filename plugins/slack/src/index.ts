import { CHANNEL_CAPABILITY, definePlugin } from "@capybara-hq/plugin-sdk";
import { z } from "zod";
import { createSlackChannel } from "./channel.js";

export { createSlackChannel, MIN_EDIT_INTERVAL_MS, SlackConnection } from "./channel.js";

/** 部署级配置：Web API 根地址（只为测试 / 代理改写；Socket Mode 的 WSS 地址由 apps.connections.open 返回）。 */
const Deployment = z.object({
  apiUrl: z.string().url().default("https://slack.com/api/"),
});

/**
 * Slack 插件（第一部分：机器人）。`channel@1` 经 Socket Mode 收事件（无需公网回调地址）、经 Web API 发消息，
 * 卡片渲染为 Block Kit。凭据（应用级令牌、机器人令牌）由内核按渠道连接配置传入，故不需要 `secrets` 权限。
 * `permissions.network` 只展示：Socket Mode 的 WSS 主机由 Slack 分配（如 `wss-primary.slack.com`、
 * `wss-backup.slack.com`、`wss-111.slack.com`），清单不支持通配，列出主要的一个。
 * 登录（identity-source@1）与通讯录（directory@1）见后续任务。
 */
export default definePlugin({
  name: "slack",
  version: "0.1.0",
  sdk: "^0.1.0",
  provides: [CHANNEL_CAPABILITY],
  permissions: { network: ["slack.com", "wss-primary.slack.com"] },
  config: { deployment: Deployment },
  setup(ctx) {
    const { apiUrl } = Deployment.parse(ctx.config ?? {});
    ctx.provide(CHANNEL_CAPABILITY, createSlackChannel({ apiUrl, log: ctx.log }));
  },
});
