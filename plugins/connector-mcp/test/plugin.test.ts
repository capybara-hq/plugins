import {
  CONNECTOR_EXTENSION_POINT,
  type Connector,
  type ExtensionContext,
} from "@capybara-hq/plugin-sdk";
import { expect, it } from "vitest";
import plugin from "../src/index.js";

it("清单：connector-mcp 提供 connector@1", () => {
  expect(plugin.name).toBe("connector-mcp");
  expect(plugin.provides).toEqual([CONNECTOR_EXTENSION_POINT]);
});

it("setup 提供 kind = mcp 的连接器", async () => {
  const provided = new Map<string, unknown>();
  const log = { info() {}, warn() {}, error() {} };
  await plugin.setup({
    provide: (cap: string, impl: unknown) => provided.set(cap, impl),
    log,
    config: undefined,
  } as unknown as ExtensionContext);
  const c = provided.get(CONNECTOR_EXTENSION_POINT) as Connector;
  expect(c.kind).toBe("mcp");
  expect(typeof c.open).toBe("function");
  expect(c.endpointSchema.safeParse({ url: "https://x.example.com/mcp" }).success).toBe(true);
  // 默认不允许本机 http
  expect(c.endpointSchema.safeParse({ url: "http://127.0.0.1/mcp" }).success).toBe(false);
});

it("部署配置 allowInsecureLoopback 打开后放行本机 http", async () => {
  const provided = new Map<string, unknown>();
  const log = { info() {}, warn() {}, error() {} };
  await plugin.setup({
    provide: (cap: string, impl: unknown) => provided.set(cap, impl),
    log,
    config: { allowInsecureLoopback: true },
  } as unknown as ExtensionContext);
  const c = provided.get(CONNECTOR_EXTENSION_POINT) as Connector;
  expect(c.endpointSchema.safeParse({ url: "http://127.0.0.1/mcp" }).success).toBe(true);
  expect(plugin.config?.deployment?.parse({})).toEqual({ allowInsecureLoopback: false });
});
