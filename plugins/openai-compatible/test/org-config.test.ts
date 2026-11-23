import {
  isModelError,
  isPlatformOnly,
  type ModelProvider,
  type ModelRequest,
  NetDeniedError,
} from "@capybara-hq/plugin-sdk";
import { type FakeModelServer, startFakeModelServer } from "@capybara-hq/testing";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { z } from "zod";
import plugin, { type EndpointConfig } from "../src/index.js";
import { chatRoutes } from "./fixtures.js";

/**
 * Org-overridable `endpoints` and `apiKeys` (core#720): an org copy is resolved as a whole per
 * call; an endpoint URL the platform also has keeps the global fetch, any other URL goes through
 * the kernel's guarded client (`ctx.net.fetch`) with the org's id.
 */

type SetupCtx = Parameters<typeof plugin.setup>[0];
type NetFetch = (url: string, init?: RequestInit, opts?: { orgId?: string }) => Promise<Response>;

const ORG = "org-1";

const model = { id: "m", contextWindow: 128_000, maxOutputTokens: 8192 };

let server: FakeModelServer;
beforeAll(async () => {
  server = await startFakeModelServer(chatRoutes("generic"));
});
afterAll(async () => {
  await server?.stop();
});

const platformEndpoint = (): EndpointConfig => ({
  name: "plat",
  baseUrl: `${server.url}/v1`,
  dialect: "generic",
  models: [model],
});

/** Runs the extension's setup over a fake ctx and returns the provider it registered. */
function setup(config: unknown, netFetch: NetFetch): ModelProvider {
  let provided: ModelProvider | undefined;
  const ctx = {
    config,
    net: { fetch: netFetch },
    log: { debug() {}, info() {}, warn() {}, error() {} },
    provide: (_point: string, impl: ModelProvider) => {
      provided = impl;
    },
  } as unknown as SetupCtx;
  plugin.setup(ctx);
  if (provided === undefined) throw new Error("setup provided no model provider");
  return provided;
}

const req = (modelId: string): ModelRequest => ({
  model: modelId,
  system: [],
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  tools: [],
  maxOutputTokens: 256,
  params: {},
});

async function drain(
  p: ModelProvider,
  r: ModelRequest,
  opts: { orgId?: string; config?: unknown },
) {
  for await (const _ of p.stream(r, { signal: new AbortController().signal, ...opts })) {
    // drain
  }
}

describe("org-overridable endpoints and apiKeys", () => {
  it("leaves both fields overridable (not platform-only)", () => {
    const schema = plugin.config?.deployment as z.ZodObject | undefined;
    const shape = (schema?.shape ?? {}) as Record<string, z.ZodTypeAny>;
    expect(isPlatformOnly(shape.endpoints as z.ZodTypeAny)).toBe(false);
    expect(isPlatformOnly(shape.apiKeys as z.ZodTypeAny)).toBe(false);
  });

  it("setup with an empty platform config does not throw and lists no models", async () => {
    const net = vi.fn<NetFetch>();
    const p = setup({}, net);
    expect(await p.listModels()).toEqual([]);
  });

  it("an org copy keeping a platform endpoint uses the global fetch with the org's key", async () => {
    const net = vi.fn<NetFetch>(async () => {
      throw new Error("net.fetch must not be used for a platform endpoint");
    });
    const p = setup({ endpoints: [platformEndpoint()], apiKeys: { plat: "sk-platform" } }, net);
    const before = server.requests.length;
    await drain(p, req("plat/m"), {
      orgId: ORG,
      config: { endpoints: [platformEndpoint()], apiKeys: { plat: "sk-org" } },
    });
    expect(net).not.toHaveBeenCalled();
    const sent = server.requests.slice(before).at(-1);
    expect(sent?.headers.authorization).toBe("Bearer sk-org");
  });

  it("a copy with apiKeys {} calls the kept endpoint without Authorization", async () => {
    const net = vi.fn<NetFetch>();
    const p = setup({ endpoints: [platformEndpoint()], apiKeys: { plat: "sk-platform" } }, net);
    const before = server.requests.length;
    await drain(p, req("plat/m"), {
      orgId: ORG,
      config: { endpoints: [platformEndpoint()], apiKeys: {} },
    });
    expect(net).not.toHaveBeenCalled();
    const sent = server.requests.slice(before).at(-1);
    expect(sent).toBeDefined();
    expect(sent?.headers.authorization).toBeUndefined();
  });

  it("an org's own endpoint at a private address is refused through the net fetch", async () => {
    const net = vi.fn<NetFetch>(async () => {
      throw new NetDeniedError(
        "net.private_address",
        "10.0.0.2",
        "Requests to 10.0.0.2 (a private address) are not allowed.",
      );
    });
    const p = setup({ endpoints: [platformEndpoint()] }, net);
    const mine: EndpointConfig = {
      name: "mine",
      baseUrl: "http://10.0.0.2/v1",
      dialect: "generic",
      models: [model],
    };
    const err = await drain(p, req("mine/m"), {
      orgId: ORG,
      config: { endpoints: [platformEndpoint(), mine], apiKeys: { mine: "sk-org" } },
    }).catch((e: unknown) => e);
    expect(net).toHaveBeenCalled();
    const [url, , opts] = net.mock.calls[0] ?? [];
    expect(String(url)).toMatch(/^http:\/\/10\.0\.0\.2\/v1\//);
    expect(opts).toEqual({ orgId: ORG });
    expect(isModelError(err)).toBe(true);
    expect((err as { kind?: string }).kind).toBe("invalid_request");
    expect((err as Error).message).toContain("10.0.0.2");
  });

  it("an org copy never borrows a platform key for an endpoint it lacks a key for", async () => {
    const net = vi.fn<NetFetch>();
    const p = setup({ endpoints: [platformEndpoint()], apiKeys: { plat: "sk-platform" } }, net);
    const before = server.requests.length;
    await drain(p, req("plat/m"), { orgId: ORG, config: { endpoints: [platformEndpoint()] } });
    const sent = server.requests.slice(before).at(-1);
    expect(sent?.headers.authorization).toBeUndefined();
  });

  it("lists the org copy's models, not the platform's", async () => {
    const p = setup({ endpoints: [platformEndpoint()] }, vi.fn<NetFetch>());
    const own: EndpointConfig = { ...platformEndpoint(), name: "own" };
    const models = await p.listModels({ orgId: ORG, config: { endpoints: [own] } });
    expect(models.map((m) => m.id)).toEqual(["own/m"]);
  });
});
