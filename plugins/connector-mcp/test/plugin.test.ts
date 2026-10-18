import { CONNECTOR_CAPABILITY, type Connector, type PluginContext } from "@capybara-hq/plugin-sdk";
import { expect, it } from "vitest";
import plugin from "../src/index.js";

it("清单：connector-mcp 提供 connector@1", () => {
  expect(plugin.name).toBe("connector-mcp");
  expect(plugin.provides).toEqual([CONNECTOR_CAPABILITY]);
});

it("setup 提供 kind = mcp 的连接器", async () => {
  const provided = new Map<string, unknown>();
  const log = { info() {}, warn() {}, error() {} };
  await plugin.setup({
    provide: (cap: string, impl: unknown) => provided.set(cap, impl),
    log,
    config: undefined,
  } as unknown as PluginContext);
  const c = provided.get(CONNECTOR_CAPABILITY) as Connector;
  expect(c.kind).toBe("mcp");
  expect(typeof c.open).toBe("function");
  expect(c.endpointSchema.safeParse({ url: "https://x.example.com/mcp" }).success).toBe(true);
});
