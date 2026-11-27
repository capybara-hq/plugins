import { type ModelRequest, validateModelCache } from "@capybara-hq/plugin-sdk";
import { startFakeModelServer } from "@capybara-hq/testing";
import { describe, expect, it } from "vitest";
import { MinTokens, minTokensOf } from "../src/cache.js";
import { createAnthropicProvider } from "../src/index.js";
import { buildRequest } from "../src/map-request.js";
import { anthropicRoutes, sseMessage } from "./fixtures.js";

const base = (over: Partial<ModelRequest> = {}): ModelRequest => ({
  model: "claude-opus-5-5",
  system: [{ text: "stable", cache: true }],
  messages: [{ role: "user", content: [{ type: "text", text: "Hi" }] }],
  tools: [],
  maxOutputTokens: 2048,
  params: {},
  ...over,
});
const build = (req: ModelRequest) => buildRequest(req, { serverFallbacks: "default" });

const memoryKv = () => {
  const store = new Map<string, string>();
  return {
    get: async (k: string) => store.get(k) ?? null,
    set: async (k: string, v: string) => void store.set(k, v),
  };
};

describe("model cache declaration", () => {
  it("declares explicit [300, 3600] with the per-model minimum", async () => {
    const server = await startFakeModelServer(anthropicRoutes());
    try {
      const provider = createAnthropicProvider({
        kv: memoryKv(),
        net: { fetch },
        apiKey: "k",
        baseUrl: server.url,
        models: ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"],
        serverFallbacks: "default",
      });
      const models = await provider.listModels();
      expect(models.map((m) => m.id)).toHaveLength(3);
      for (const m of models) {
        expect(m.cache).toEqual({
          mechanism: "explicit",
          ttlOptions: [300, 3600],
          defaultTtl: 300,
          ttlIsMinimum: false,
          refreshOnHit: true,
          ttlClock: "request_start",
          minTokens: 512,
          guaranteed: true,
        });
        expect(validateModelCache(m.cache)).toBeNull();
      }
    } finally {
      await server.stop();
    }
  });

  it("minTokens table by id; unknown id falls back to 4096", () => {
    expect(minTokensOf("claude-fable-5-2")).toBe(512);
    expect(minTokensOf("claude-opus-5")).toBe(512);
    expect(minTokensOf("claude-opus-4-8")).toBe(1024);
    expect(minTokensOf("claude-sonnet-4-5")).toBe(1024);
    expect(minTokensOf("claude-opus-4-7")).toBe(2048);
    expect(minTokensOf("claude-opus-4-6")).toBe(4096);
    expect(minTokensOf("claude-haiku-4-5-20251001")).toBe(4096);
    expect(minTokensOf("claude-unknown-9")).toBe(4096);
    expect(Object.keys(MinTokens).length).toBeGreaterThan(15);
  });
});

describe("buildRequest: cacheTtl", () => {
  it("3600 puts ttl 1h on the system breakpoint and the top-level one", () => {
    const { params } = build(base({ cacheTtl: 3600 }));
    expect(params.system).toEqual([
      { type: "text", text: "stable", cache_control: { type: "ephemeral", ttl: "1h" } },
    ]);
    expect(params.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
  });
  it("absent or 300 sends no ttl", () => {
    for (const cacheTtl of [undefined, 300]) {
      const { params } = build(base(cacheTtl === undefined ? {} : { cacheTtl }));
      expect(JSON.stringify(params)).not.toContain("ttl");
    }
  });
});

describe("usage: cacheWriteByTtl", () => {
  const run = async (usage: Partial<Parameters<typeof sseMessage>[0]["usage"]>) => {
    const server = await startFakeModelServer(() =>
      sseMessage({
        model: "claude-opus-5-5",
        blocks: [{ type: "text", text: "ok" }],
        stopReason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1, ...usage },
      }),
    );
    try {
      const provider = createAnthropicProvider({
        kv: memoryKv(),
        net: { fetch },
        apiKey: "k",
        baseUrl: server.url,
        models: ["claude-opus-5-5"],
        serverFallbacks: "default",
      });
      let done: unknown;
      for await (const e of provider.stream(base(), { signal: new AbortController().signal })) {
        if (e.type === "message_complete") done = e.usage;
      }
      return done as Record<string, unknown>;
    } finally {
      await server.stop();
    }
  };
  it("maps the split, leaving zero entries out", async () => {
    const u = await run({
      cache_creation_input_tokens: 100,
      cache_creation: { ephemeral_5m_input_tokens: 10, ephemeral_1h_input_tokens: 90 },
    });
    expect(u.cacheWriteByTtl).toEqual([
      { ttl: 300, tokens: 10 },
      { ttl: 3600, tokens: 90 },
    ]);
    const only1h = await run({
      cache_creation_input_tokens: 90,
      cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 90 },
    });
    expect(only1h.cacheWriteByTtl).toEqual([{ ttl: 3600, tokens: 90 }]);
  });
  it("field absent when there is no split or no write", async () => {
    expect("cacheWriteByTtl" in (await run({ cache_creation_input_tokens: 5 }))).toBe(false);
    const none = await run({
      cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 },
    });
    expect("cacheWriteByTtl" in none).toBe(false);
  });
});
