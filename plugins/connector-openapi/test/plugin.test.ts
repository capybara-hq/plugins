import { CONNECTOR_CAPABILITY, type Connector, type PluginContext } from "@capybara-hq/plugin-sdk";
import { expect, it } from "vitest";
import plugin from "../src/index.js";

async function setup(config: unknown): Promise<Connector> {
  const provided = new Map<string, unknown>();
  const log = { info() {}, warn() {}, error() {} };
  await plugin.setup({
    provide: (cap: string, impl: unknown) => provided.set(cap, impl),
    log,
    config,
  } as unknown as PluginContext);
  return provided.get(CONNECTOR_CAPABILITY) as Connector;
}

it("清单：connector-openapi 提供 connector@1", () => {
  expect(plugin.name).toBe("connector-openapi");
  expect(plugin.provides).toEqual([CONNECTOR_CAPABILITY]);
  expect(plugin.config?.deployment?.parse({})).toEqual({ allowInsecureLoopback: false });
});

it("setup 提供 kind = openapi 的连接器，带 inspect", async () => {
  const c = await setup(undefined);
  expect(c.kind).toBe("openapi");
  expect(typeof c.open).toBe("function");
  expect(typeof c.inspect).toBe("function");
});

it("端点：specUrl 与 specText 二选一；https；本机 http 只在部署配置打开时放行", async () => {
  const c = await setup(undefined);
  const ok = (v: unknown) => c.endpointSchema.safeParse(v).success;
  expect(ok({ specUrl: "https://api.example.com/openapi.json" })).toBe(true);
  expect(ok({ specText: '{"openapi":"3.1.0"}', baseUrl: "https://api.example.com/v1" })).toBe(true);
  expect(ok({})).toBe(false);
  expect(
    ok({ specUrl: "https://api.example.com/openapi.json", specText: '{"openapi":"3.1.0"}' }),
  ).toBe(false);
  expect(ok({ specUrl: "http://api.example.com/openapi.json" })).toBe(false);
  expect(ok({ specUrl: "http://127.0.0.1:8080/openapi.json" })).toBe(false);
  expect(ok({ specText: "{}", baseUrl: "http://api.example.com" })).toBe(false);
  expect(ok({ specUrl: "https://api.example.com/o.json", operations: ["listPets"] })).toBe(true);
  expect(ok({ specUrl: "https://api.example.com/o.json", operations: [] })).toBe(false);
  expect(ok({ specUrl: "https://api.example.com/o.json", extra: 1 })).toBe(false);
  // 2 MB 上限按 UTF-8 字节数
  expect(ok({ specText: "x".repeat(2 * 1024 * 1024) })).toBe(true);
  expect(ok({ specText: "x".repeat(2 * 1024 * 1024 + 1) })).toBe(false);
  expect(ok({ specText: "é".repeat(1024 * 1024 + 1) })).toBe(false);

  const dev = await setup({ allowInsecureLoopback: true });
  expect(dev.endpointSchema.safeParse({ specUrl: "http://127.0.0.1:8080/o.json" }).success).toBe(
    true,
  );
  expect(
    dev.endpointSchema.safeParse({ specUrl: "http://localhost.evil.com/o.json" }).success,
  ).toBe(false);
});
