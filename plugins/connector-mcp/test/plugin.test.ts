import {
  CONNECTOR_EXTENSION_POINT,
  type Connector,
  type ExtensionContext,
} from "@capybara-hq/plugin-sdk";
import { expect, it } from "vitest";
import plugin from "../src/index.js";

it("manifest: connector-mcp provides connector@1 and has no deployment config", () => {
  expect(plugin.name).toBe("connector-mcp");
  expect(plugin.provides).toEqual([CONNECTOR_EXTENSION_POINT]);
  expect(plugin.config?.deployment).toBeUndefined();
});

it("setup provides a connector of kind mcp that accepts http and https endpoints", async () => {
  const provided = new Map<string, unknown>();
  const log = { info() {}, warn() {}, error() {} };
  await plugin.setup({
    provide: (cap: string, impl: unknown) => provided.set(cap, impl),
    log,
    net: { fetch: () => Promise.reject(new Error("unused")) },
    config: undefined,
  } as unknown as ExtensionContext);
  const c = provided.get(CONNECTOR_EXTENSION_POINT) as Connector;
  expect(c.kind).toBe("mcp");
  expect(typeof c.open).toBe("function");
  expect(c.endpointSchema.safeParse({ url: "https://x.example.com/mcp" }).success).toBe(true);
  // whether an http endpoint is reachable is ctx.net's call at request time
  expect(c.endpointSchema.safeParse({ url: "http://mcp.internal:8080/mcp" }).success).toBe(true);
});
