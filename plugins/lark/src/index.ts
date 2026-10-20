import { CHANNEL_CAPABILITY, definePlugin } from "@capybara-hq/plugin-sdk";
import { createLarkChannel } from "./channel.js";
import { apiBaseOf, LarkDeployment } from "./config.js";

export { createLarkChannel, LarkConnection, MIN_EDIT_INTERVAL_MS } from "./channel.js";
export { LarkDeployment } from "./config.js";

/**
 * Lark（飞书国际版）插件。
 * - `channel@1`（机器人）：经 Lark 长连接（官方 SDK 的 `WSClient`，无需公网回调地址）收消息事件与卡片回调，
 *   经 OpenAPI 发消息，所有消息与审批 / 提问 / 连接 / 绑定卡片都渲染为交互卡片（JSON 2.0）。凭据（App ID /
 *   App Secret）由内核按渠道连接配置传入，故不需要 `secrets` 权限。
 * 身份键：`identities.source` = `lark:<tenant_key>`，`external_id` = 用户 `open_id`（登录与通讯录由 T18 补上）。
 *
 * `permissions.network` 只展示：OpenAPI、取 token 与长连接接入点都在 `open.larksuite.com`。长连接的 WebSocket
 * 地址由接入点在连接时下发（文档没有写明固定主机），清单不支持通配，故不列出。
 */
export default definePlugin({
  name: "lark",
  version: "0.1.0",
  sdk: "^0.1.0",
  provides: [CHANNEL_CAPABILITY],
  permissions: { network: ["open.larksuite.com"] },
  config: { deployment: LarkDeployment },
  setup(ctx) {
    const dep = LarkDeployment.parse(ctx.config ?? {});
    ctx.provide(CHANNEL_CAPABILITY, createLarkChannel({ apiUrl: apiBaseOf(dep), log: ctx.log }));
  },
});
