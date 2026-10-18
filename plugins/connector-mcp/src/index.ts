import { CONNECTOR_CAPABILITY, definePlugin } from "@capybara-hq/plugin-sdk";
import { createMcpConnector } from "./session.js";

/**
 * MCP 连接器：把远端 MCP 服务（Streamable HTTP）作为应用接入。工具清单由内核快照进 `app_tools`，
 * 每次调用打开一个会话、用完关闭；鉴权由内核在每个请求前注入（静态凭据 / 之后的 OAuth）。
 * 无部署级配置、无进程内状态。
 */
export default definePlugin({
  name: "connector-mcp",
  version: "0.1.0",
  sdk: "^0.1.0",
  provides: [CONNECTOR_CAPABILITY],
  setup(ctx) {
    ctx.provide(CONNECTOR_CAPABILITY, createMcpConnector({ log: ctx.log }));
  },
});
