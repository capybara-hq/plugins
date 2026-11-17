import {
  CONNECTOR_EXTENSION_POINT,
  type Connector,
  type ExtensionContext,
} from "@capybara-hq/plugin-sdk";
import { expect, it } from "vitest";
import plugin from "../src/index.js";

async function setup(config: unknown): Promise<Connector> {
  const provided = new Map<string, unknown>();
  const log = { info() {}, warn() {}, error() {} };
  await plugin.setup({
    provide: (cap: string, impl: unknown) => provided.set(cap, impl),
    log,
    net: { fetch: () => Promise.reject(new Error("unused")) },
    config,
  } as unknown as ExtensionContext);
  return provided.get(CONNECTOR_EXTENSION_POINT) as Connector;
}

it("manifest: connector-openapi provides connector@1 and has no deployment config", () => {
  expect(plugin.name).toBe("connector-openapi");
  expect(plugin.provides).toEqual([CONNECTOR_EXTENSION_POINT]);
  expect(plugin.config?.deployment).toBeUndefined();
});

it("setup 提供 kind = openapi 的连接器，带 inspect", async () => {
  const c = await setup(undefined);
  expect(c.kind).toBe("openapi");
  expect(typeof c.open).toBe("function");
  expect(typeof c.inspect).toBe("function");
});

it("endpoint: exactly one of specUrl and specText; http or https (ctx.net decides reachability)", async () => {
  const c = await setup(undefined);
  const ok = (v: unknown) => c.endpointSchema.safeParse(v).success;
  expect(ok({ specUrl: "https://api.example.com/openapi.json" })).toBe(true);
  expect(ok({ specText: '{"openapi":"3.1.0"}', baseUrl: "https://api.example.com/v1" })).toBe(true);
  expect(ok({})).toBe(false);
  expect(
    ok({ specUrl: "https://api.example.com/openapi.json", specText: '{"openapi":"3.1.0"}' }),
  ).toBe(false);
  expect(ok({ specUrl: "http://api.example.com/openapi.json" })).toBe(true);
  expect(ok({ specUrl: "http://127.0.0.1:8080/openapi.json" })).toBe(true);
  expect(ok({ specText: "{}", baseUrl: "http://api.internal:8080" })).toBe(true);
  expect(ok({ specUrl: "ftp://api.example.com/openapi.json" })).toBe(false);
  expect(ok({ specText: "{}", baseUrl: "file:///etc/passwd" })).toBe(false);
  expect(ok({ specUrl: "https://api.example.com/o.json", operations: ["listPets"] })).toBe(true);
  expect(ok({ specUrl: "https://api.example.com/o.json", operations: [] })).toBe(false);
  expect(ok({ specUrl: "https://api.example.com/o.json", extra: 1 })).toBe(false);
  // the 2 MB limit counts UTF-8 bytes
  expect(ok({ specText: "x".repeat(2 * 1024 * 1024) })).toBe(true);
  expect(ok({ specText: "x".repeat(2 * 1024 * 1024 + 1) })).toBe(false);
  expect(ok({ specText: "é".repeat(1024 * 1024 + 1) })).toBe(false);
});
