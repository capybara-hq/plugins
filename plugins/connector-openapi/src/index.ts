import { CONNECTOR_EXTENSION_POINT, defineExtension } from "@capybara-hq/plugin-sdk";
import { z } from "zod";
import { createOpenApiConnector } from "./connector.js";

/** 部署级配置。 */
const DeploymentConfig = z.object({
  /** 允许文档地址、baseUrl 与文档里的 server 用本机 http（127.0.0.1 / localhost / [::1]），仅供开发与测试；默认关闭。 */
  allowInsecureLoopback: z.boolean().default(false),
});

/**
 * OpenAPI 连接器：把一个 OpenAPI 3.0 / 3.1 描述的 HTTP API 作为连接器接入，每个 operation 一个工具。
 * 文档按次读取（specText 或不带凭据去取 specUrl），不在进程内缓存；鉴权由内核在每个请求前注入。
 */
export default defineExtension({
  name: "connector-openapi",
  version: "0.1.0-rc.0",
  sdk: "^0.1.0-rc.0",
  provides: [CONNECTOR_EXTENSION_POINT],
  config: { deployment: DeploymentConfig },
  setup(ctx) {
    const { allowInsecureLoopback } = DeploymentConfig.parse(ctx.config ?? {});
    ctx.provide(
      CONNECTOR_EXTENSION_POINT,
      createOpenApiConnector({ log: ctx.log, allowInsecureLoopback }),
    );
  },
});
