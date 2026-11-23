import { createHash } from "node:crypto";
import {
  isModelError,
  isPlatformOnly,
  type ModelProvider,
  type ModelRequest,
} from "@capybara-hq/plugin-sdk";
import { type FakeModelServer, startFakeModelServer } from "@capybara-hq/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { z } from "zod";
import plugin, { createAnthropicProvider, type Kv } from "../src/index.js";
import { SERVER_FALLBACK_BETA } from "../src/map-request.js";
import { anthropicRoutes } from "./fixtures.js";

/*
 * Org-overridable config (core#720): the key, endpoint and models come from the per-call config of
 * the org (`opts.config`); `serverFallbacks` is platform-only and read from `ctx.config`.
 */

const memoryKv = (): Kv & { store: Map<string, string> } => {
  const store = new Map<string, string>();
  return {
    store,
    get: async (k) => store.get(k) ?? null,
    set: async (k, v) => {
      store.set(k, v);
    },
  };
};

/** Stands in for `ctx.net.fetch` (the fake server runs on loopback): plain fetch, recording calls. */
function recordingNet() {
  const calls: { url: string; orgId: string | undefined }[] = [];
  return {
    calls,
    fetch: (url: string, init?: RequestInit, opts?: { orgId?: string }) => {
      calls.push({ url, orgId: opts?.orgId });
      return fetch(url, init);
    },
  };
}

/** A `ctx.net.fetch` that refuses every host as a private address (a kernel `NetDeniedError`). */
const refusingNet = {
  fetch: async (url: string): Promise<Response> => {
    const host = new URL(url).hostname;
    throw Object.assign(
      new Error(`Access to ${host} is refused: it resolves to a private or reserved address.`),
      { name: "NetDeniedError", code: "net.private_address", host },
    );
  },
};

const hash = (url: string) => createHash("sha256").update(url).digest("hex");

const req = (model: string): ModelRequest => ({
  model,
  system: [],
  messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
  tools: [],
  maxOutputTokens: 100,
  params: {},
});

async function drain(p: ModelProvider, r: ModelRequest, opts: object = {}) {
  for await (const _ of p.stream(r, { signal: new AbortController().signal, ...opts })) {
    // drain
  }
}

/** Runs the extension's setup against a minimal ctx and returns the provider it registers. */
function setupWith(ctx: { config: unknown; kv?: Kv; net?: { fetch: unknown } }): ModelProvider {
  let provided: ModelProvider | undefined;
  const fakeCtx = {
    // read through, so a test can change the platform's config after setup (hot config)
    get config() {
      return ctx.config;
    },
    kv: ctx.kv ?? memoryKv(),
    net: ctx.net ?? recordingNet(),
    log: { warn() {}, info() {}, error() {}, debug() {} },
    provide: (_point: string, impl: ModelProvider) => {
      provided = impl;
    },
  };
  // biome-ignore lint/suspicious/noExplicitAny: a minimal stand-in for the kernel's ctx
  (plugin.setup as (c: any) => void)(fakeCtx);
  if (provided === undefined) throw new Error("setup provided nothing");
  return provided;
}

let server: FakeModelServer;
beforeAll(async () => {
  server = await startFakeModelServer(anthropicRoutes());
});
afterAll(() => server.stop());

describe("anthropic org-overridable config", () => {
  it("serverFallbacks is platform-only; key, endpoint and models stay overridable", () => {
    const schema = plugin.config?.deployment as z.ZodObject;
    expect(isPlatformOnly(schema.shape.serverFallbacks as z.ZodTypeAny)).toBe(true);
    for (const k of ["apiKey", "baseUrl", "models"]) {
      expect(isPlatformOnly(schema.shape[k] as z.ZodTypeAny)).toBe(false);
    }
  });

  it("setup with an empty platform config does not throw; a call without a key is auth", async () => {
    const p = setupWith({ config: {} });
    const before = server.requests.length;
    const e = await p.listModels().catch((x: unknown) => x);
    expect(isModelError(e) && e.kind).toBe("auth");
    expect(server.requests.length).toBe(before);
  });

  it("an org config without apiKey -> auth before any request, never the platform key", async () => {
    const p = setupWith({ config: { apiKey: "sk-platform", baseUrl: server.url } });
    const before = server.requests.length;
    const e = await p
      .listModels({ orgId: "org-1", config: { baseUrl: server.url } })
      .catch((x: unknown) => x);
    expect(isModelError(e) && e.kind).toBe("auth");
    const s = await drain(p, req("claude-haiku-5-5"), {
      orgId: "org-1",
      config: { baseUrl: server.url },
    }).catch((x: unknown) => x);
    expect(isModelError(s) && s.kind).toBe("auth");
    expect(server.requests.length).toBe(before);
  });

  it("uses the org's key and models from opts.config", async () => {
    const p = setupWith({ config: { apiKey: "sk-platform", baseUrl: server.url } });
    const models = await p.listModels({
      orgId: "org-1",
      config: { apiKey: "sk-org", baseUrl: server.url, models: ["claude-sonnet-5"] },
    });
    expect(models.map((m) => m.id)).toEqual(["claude-sonnet-5"]);
    expect(server.requests.at(-1)?.headers["x-api-key"]).toBe("sk-org");
  });

  it("an org's own baseUrl goes through ctx.net; the platform's keeps the global fetch", async () => {
    const net = recordingNet();
    const p = setupWith({ config: { apiKey: "sk-platform", baseUrl: server.url }, net });
    // following the platform's endpoint (trailing slash ignored): global fetch
    await p.listModels({
      orgId: "org-1",
      config: { apiKey: "sk-org", baseUrl: `${server.url}/`, models: ["claude-haiku-5-5"] },
    });
    expect(net.calls).toEqual([]);
    // the org's own endpoint: ctx.net with the org's id
    const own = server.url.replace("127.0.0.1", "localhost");
    await p.listModels({
      orgId: "org-2",
      config: { apiKey: "sk-org", baseUrl: own, models: ["claude-haiku-5-5"] },
    });
    expect(net.calls).toEqual([{ url: `${own}/v1/models/claude-haiku-5-5`, orgId: "org-2" }]);
  });

  it("an org baseUrl ctx.net refuses -> invalid_request naming the host, nothing sent", async () => {
    const p = setupWith({ config: { apiKey: "sk-platform" }, net: refusingNet });
    const before = server.requests.length;
    const config = { apiKey: "sk-org", baseUrl: "http://10.0.0.1", models: ["claude-haiku-5-5"] };
    for (const call of [
      () => p.listModels({ orgId: "org-1", config }),
      () => drain(p, req("claude-haiku-5-5"), { orgId: "org-1", config }),
    ]) {
      const e = await call().catch((x: unknown) => x);
      expect(isModelError(e) && e.kind).toBe("invalid_request");
      const message = e instanceof Error ? e.message : "";
      expect(message).toContain("10.0.0.1");
      expect(message).toMatch(/refused by the platform's network rules/);
      expect(message).not.toContain("sk-org");
    }
    expect(server.requests.length).toBe(before);
  });

  it("two org endpoints write and read distinct kv keys", async () => {
    const kv = memoryKv();
    const p = setupWith({ config: { apiKey: "sk-platform", baseUrl: server.url }, kv });
    const a = server.url;
    const b = server.url.replace("127.0.0.1", "localhost");
    const before = server.requests.length;
    await p.listModels({
      orgId: "org-a",
      config: { apiKey: "sk-a", baseUrl: a, models: ["claude-haiku-5-5"] },
    });
    // org b must not read org a's entry: its own endpoint is asked
    await p.listModels({
      orgId: "org-b",
      config: { apiKey: "sk-b", baseUrl: b, models: ["claude-haiku-5-5"] },
    });
    expect(server.requests.length - before).toBe(2);
    expect([...kv.store.keys()].sort()).toEqual(
      [`models:v4:${hash(a)}:claude-haiku-5-5`, `models:v4:${hash(b)}:claude-haiku-5-5`].sort(),
    );
    // each reads its own entry back
    await p.listModels({
      orgId: "org-b",
      config: { apiKey: "sk-b", baseUrl: b, models: ["claude-haiku-5-5"] },
    });
    expect(server.requests.length - before).toBe(2);
  });

  it("serverFallbacks comes from ctx.config only, read at call time", async () => {
    const ctx = {
      config: { apiKey: "sk-platform", baseUrl: server.url } as Record<string, unknown>,
    };
    const p = setupWith(ctx);
    const org = { apiKey: "sk-org", baseUrl: server.url, serverFallbacks: "off" };
    await drain(p, req("claude-opus-5-5"), { orgId: "org-1", config: org });
    expect(server.requests.at(-1)?.headers["anthropic-beta"]).toContain(SERVER_FALLBACK_BETA);
    // the platform switches it off: the next call follows without a new setup
    ctx.config = { ...ctx.config, serverFallbacks: "off" };
    // the fixture refuses an opus-5-5 request without fallbacks; only the request matters here
    await drain(p, req("claude-opus-5-5"), {
      orgId: "org-1",
      config: { ...org, serverFallbacks: "default" },
    }).catch(() => {});
    expect(server.requests.at(-1)?.headers["anthropic-beta"] ?? "").not.toContain(
      SERVER_FALLBACK_BETA,
    );
  });

  it("host ANTHROPIC_CUSTOM_HEADERS never reach an org's own endpoint", async () => {
    const saved = process.env.ANTHROPIC_CUSTOM_HEADERS;
    process.env.ANTHROPIC_CUSTOM_HEADERS = "X-Secret: s";
    try {
      const net = recordingNet();
      const p = setupWith({ config: { apiKey: "sk-platform", baseUrl: server.url }, net });
      const own = server.url.replace("127.0.0.1", "localhost");
      await p.listModels({
        orgId: "org-1",
        config: { apiKey: "sk-org", baseUrl: own, models: ["claude-sonnet-5-5"] },
      });
      expect(net.calls).toHaveLength(1);
      expect(server.requests.at(-1)?.headers["x-api-key"]).toBe("sk-org");
      expect(server.requests.at(-1)?.headers["x-secret"]).toBeUndefined();
    } finally {
      if (saved === undefined) delete process.env.ANTHROPIC_CUSTOM_HEADERS;
      else process.env.ANTHROPIC_CUSTOM_HEADERS = saved;
    }
  });

  it("createAnthropicProvider without a key anywhere -> auth before any request", async () => {
    const before = server.requests.length;
    const e = await createAnthropicProvider({
      kv: memoryKv(),
      net: recordingNet(),
      baseUrl: server.url,
      serverFallbacks: "default",
    })
      .listModels()
      .catch((x: unknown) => x);
    expect(isModelError(e) && e.kind).toBe("auth");
    expect(server.requests.length).toBe(before);
  });
});
