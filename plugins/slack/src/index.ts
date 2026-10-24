import {
  CHANNEL_CAPABILITY,
  DIRECTORY_CAPABILITY,
  definePlugin,
  IDENTITY_SOURCE_CAPABILITY,
} from "@capybara-hq/plugin-sdk";
import { createSlackChannel } from "./channel.js";
import { SlackDeployment, SlackDirectoryConfig } from "./config.js";
import { createSlackDirectory } from "./directory.js";
import { createSlackIdentitySource } from "./identity.js";

export { createSlackChannel, MIN_EDIT_INTERVAL_MS, SlackConnection } from "./channel.js";
export { SlackDeployment, SlackDirectoryConfig } from "./config.js";
export { createSlackDirectory } from "./directory.js";
export { createSlackIdentitySource } from "./identity.js";

/**
 * Slack 插件：三种能力共用一个身份键（`slack:<team id>` + Slack user id）。
 * - `channel@1`（机器人）：经 Socket Mode 收事件（无需公网回调地址）、经 Web API 发消息，卡片渲染为 Block Kit。
 *   Webhook inbound mode (Events API / Interactivity Request URLs, signed with the connection's
 *   `signingSecret`) is the alternative to Socket Mode.
 *   凭据（应用级令牌、机器人令牌）由内核按渠道连接配置传入。
 * - `identity-source@1`（Sign in with Slack，OpenID Connect）：部署级 `clientId` / `clientSecret`，
 *   经 `auth.loginSources` 启用。
 * - `directory@1`（通讯录，`users.list`）：组织级 `teamId` / `botToken`。
 * 凭据都由内核按配置传入，故不需要 `secrets` 权限。`permissions.network` 只展示：OIDC 与 Web API 都在
 * `slack.com`；Socket Mode 的 WSS 主机由 Slack 分配（如 `wss-primary.slack.com`、`wss-backup.slack.com`、
 * `wss-111.slack.com`），清单不支持通配，列出主要的一个。
 */
export default definePlugin({
  name: "slack",
  version: "0.1.0",
  sdk: "^0.1.0",
  provides: [CHANNEL_CAPABILITY, IDENTITY_SOURCE_CAPABILITY, DIRECTORY_CAPABILITY],
  permissions: { network: ["slack.com", "wss-primary.slack.com"] },
  config: { deployment: SlackDeployment, org: SlackDirectoryConfig },
  setup(ctx) {
    const { apiUrl } = SlackDeployment.parse(ctx.config ?? {});
    ctx.provide(CHANNEL_CAPABILITY, createSlackChannel({ apiUrl, log: ctx.log, kv: ctx.kv }));
    ctx.provide(IDENTITY_SOURCE_CAPABILITY, createSlackIdentitySource());
    ctx.provide(DIRECTORY_CAPABILITY, createSlackDirectory({ apiUrl }));
  },
});
