import { CONNECTOR_EXTENSION_POINT, defineExtension } from "@capybara-hq/plugin-sdk";
import { z } from "zod";
import { createMcpConnector } from "./session.js";

/** 部署级配置。 */
const DeploymentConfig = z.object({
  /** 允许端点用本机 http（127.0.0.1 / localhost / [::1]），仅供开发与测试；默认关闭，生产只接受 https。 */
  allowInsecureLoopback: z.boolean().default(false),
});

/**
 * MCP 连接器：把远端 MCP 服务（Streamable HTTP）作为连接器接入。工具清单由内核快照进 `connector_tools`，
 * 每次调用打开一个会话、用完关闭；鉴权由内核在每个请求前注入（静态凭据 / 之后的 OAuth）。
 * 部署级配置只有 `allowInsecureLoopback`；无进程内状态。
 */
export default defineExtension({
  name: "connector-mcp",
  version: "0.1.0-rc.0",
  sdk: "^0.1.0-rc.0",
  provides: [CONNECTOR_EXTENSION_POINT],
  config: { deployment: DeploymentConfig },
  setup(ctx) {
    const { allowInsecureLoopback } = DeploymentConfig.parse(ctx.config ?? {});
    ctx.provide(
      CONNECTOR_EXTENSION_POINT,
      createMcpConnector({ log: ctx.log, allowInsecureLoopback }),
    );
  },
});
