import {
  CHANNEL_EXTENSION_POINT,
  DIRECTORY_EXTENSION_POINT,
  defineExtension,
  IDENTITY_SOURCE_EXTENSION_POINT,
} from "@capybara-hq/plugin-sdk";
import { createLarkChannel } from "./channel.js";
import { apiBaseOf, LarkDeployment, LarkOrgConfig, loginAppOf } from "./config.js";
import { createLarkDirectory } from "./directory.js";
import { createLarkIdentitySource } from "./identity.js";

export { createLarkChannel, LarkConnection, MIN_EDIT_INTERVAL_MS } from "./channel.js";
export { LarkDeployment, LarkOrgConfig } from "./config.js";
export { createLarkDirectory } from "./directory.js";
export { createLarkIdentitySource } from "./identity.js";

/**
 * Lark（飞书国际版）插件：三种能力共用一个身份键（`identities.source` = `lark:<tenant_key>`，`external_id` = 用户
 * `open_id`）。**`open_id` 按应用区分**，所以登录、机器人、通讯录必须用同一个 Lark 自建应用；插件在校验渠道连接与
 * 同步通讯录时，发现同一租户用了与部署级登录不同的应用就报错。
 * - `channel@1`（机器人）：经 Lark 长连接（官方 SDK 的 `WSClient`，无需公网回调地址）收消息事件与卡片回调，
 *   经 OpenAPI 发消息，所有消息与审批 / 提问 / 连接 / 绑定卡片都渲染为交互卡片（JSON 2.0）。凭据按渠道连接配置传入。
 *   Webhook inbound mode (event and card callback Request URLs, decrypted / verified with the
 *   connection's `encryptKey` or `verificationToken`) is the alternative to the long connection.
 * - `identity-source@1`（网页登录，OAuth 授权码 + PKCE）：部署级 `appId` / `appSecret`，经 `auth.loginSources` 启用。
 * - `directory@1`（通讯录，按部门遍历）：组织级 `appId` / `appSecret`。
 * 凭据都由内核按配置传入，故不需要 `secrets` 权限。
 *
 * `permissions.network` 只展示：OpenAPI、取 token、OAuth 换 token、用户信息与长连接接入点都在 `open.larksuite.com`；
 * 网页授权页在 `accounts.larksuite.com`（浏览器跳转过去，服务端不请求它）。长连接的 WebSocket 地址由接入点在连接时
 * 下发（文档没有写明固定主机），清单不支持通配，故不列出。
 */
export default defineExtension({
  name: "lark",
  version: "0.1.0-rc.0",
  sdk: "^0.1.0-rc.0",
  provides: [CHANNEL_EXTENSION_POINT, IDENTITY_SOURCE_EXTENSION_POINT, DIRECTORY_EXTENSION_POINT],
  permissions: { network: ["open.larksuite.com", "accounts.larksuite.com"] },
  config: { deployment: LarkDeployment, org: LarkOrgConfig },
  setup(ctx) {
    const dep = LarkDeployment.parse(ctx.config ?? {});
    const apiUrl = apiBaseOf(dep);
    const loginApp = loginAppOf(dep);
    ctx.provide(
      CHANNEL_EXTENSION_POINT,
      createLarkChannel({ apiUrl, log: ctx.log, kv: ctx.kv, ...(loginApp && { loginApp }) }),
    );
    ctx.provide(IDENTITY_SOURCE_EXTENSION_POINT, createLarkIdentitySource());
    ctx.provide(
      DIRECTORY_EXTENSION_POINT,
      createLarkDirectory({ apiUrl, ...(loginApp && { loginApp }) }),
    );
  },
});
