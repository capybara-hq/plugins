import type { ModelRequest } from "@capybara-hq/plugin-sdk";
import { validateModelCache } from "@capybara-hq/plugin-sdk";
import { describe, expect, it } from "vitest";
import { acceptsCacheOptions } from "../src/cache.js";
import { createOpenAIProvider, type ModelConfig } from "../src/index.js";
import { buildRequest, type ModelTraits } from "../src/map-request.js";
import { toComplete } from "../src/map-stream.js";
import { refusingNetFetch } from "./fixtures.js";

const gpt = (id: string): ModelConfig => ({
  id,
  contextWindow: 400_000,
  maxOutputTokens: 128_000,
  reasoning: true,
  vision: true,
});
const TRAITS: ModelTraits = { reasoning: true, reasoningSummary: "auto" };
const req = (model: string, over: Partial<ModelRequest> = {}): ModelRequest => ({
  model,
  system: [{ text: "Be brief.", cache: true }],
  messages: [{ role: "user", content: [{ type: "text", text: "Hi" }] }],
  tools: [],
  maxOutputTokens: 1024,
  params: {},
  ...over,
});

describe("acceptsCacheOptions", () => {
  it.each([
    ["gpt-5.6-luna", true],
    ["gpt-5.6", true],
    ["gpt-5.10-x", true],
    ["gpt-6-sol", true],
    ["gpt-6.1-terra", true],
    ["gpt-6.2-foo", true],
    ["gpt-10", true],
    ["gpt-5.5", false],
    ["gpt-5.5-mini", false],
    ["gpt-5-nano", false],
    ["gpt-5-mini", false],
    ["gpt-4o", false],
    ["o3", false],
    ["gpt-image-1", false],
    ["my-gpt-6", false],
  ])("%s -> %s", (id, ok) => {
    expect(acceptsCacheOptions(id)).toBe(ok);
  });
});

describe("cache declaration", () => {
  const list = async () =>
    createOpenAIProvider({
      netFetch: refusingNetFetch,
      apiKey: "k",
      models: [gpt("gpt-5.6-luna"), gpt("gpt-6.1-sol"), gpt("gpt-5.5"), gpt("gpt-5-nano")],
      imageModels: ["gpt-image-1-mini"],
    }).listModels();

  it("GPT-5.6+ declares an implicit 30m / 12h cache with a lifetime floor", async () => {
    const models = await list();
    for (const id of ["gpt-5.6-luna", "gpt-6.1-sol"]) {
      const cache = models.find((m) => m.id === id)?.cache;
      expect(cache).toEqual({
        mechanism: "implicit",
        ttlOptions: [1800, 43200],
        defaultTtl: 1800,
        ttlIsMinimum: true,
        refreshOnHit: true,
        ttlClock: "unknown",
        minTokens: 1024,
        guaranteed: true,
      });
      expect(validateModelCache(cache)).toBeNull();
    }
  });

  it("earlier models declare an implicit cache without options or guarantee", async () => {
    const models = await list();
    for (const id of ["gpt-5.5", "gpt-5-nano"]) {
      const cache = models.find((m) => m.id === id)?.cache;
      expect(cache).toEqual({
        mechanism: "implicit",
        ttlOptions: [],
        ttlIsMinimum: false,
        refreshOnHit: false,
        ttlClock: "unknown",
        minTokens: 1024,
        guaranteed: false,
      });
      expect(validateModelCache(cache)).toBeNull();
    }
  });

  it("image models declare no cache", async () => {
    const image = (await list()).find((m) => m.id === "gpt-image-1-mini");
    expect(image).toBeDefined();
    expect(image?.cache).toBeUndefined();
  });
});

describe("cacheTtl mapping", () => {
  it("1800 -> 30m, 43200 -> 12h on GPT-5.6+", () => {
    expect(
      buildRequest(req("gpt-5.6-luna", { cacheTtl: 1800 }), TRAITS).prompt_cache_options,
    ).toEqual({
      ttl: "30m",
    });
    expect(
      buildRequest(req("gpt-6.1-sol", { cacheTtl: 43200 }), TRAITS).prompt_cache_options,
    ).toEqual({
      ttl: "12h",
    });
  });

  it("absent cacheTtl sends no field", () => {
    expect(buildRequest(req("gpt-5.6-luna"), TRAITS)).not.toHaveProperty("prompt_cache_options");
  });

  it("never sends the field on a pre-5.6 model", () => {
    for (const model of ["gpt-5.5", "gpt-5-nano"]) {
      expect(buildRequest(req(model, { cacheTtl: 1800 }), TRAITS)).not.toHaveProperty(
        "prompt_cache_options",
      );
    }
  });
});

describe("cacheWriteByTtl", () => {
  const complete = (usage: Record<string, unknown>) =>
    toComplete(
      {
        id: "r",
        status: "completed",
        output: [],
        usage: { input_tokens: 1000, output_tokens: 5, ...usage },
      } as never,
      "gpt-5.6-luna",
    );

  it("maps the 30m and 12h write counts, leaving out zeros", () => {
    const u = complete({
      input_tokens_details: {
        cached_tokens: 100,
        cache_write_tokens: 800,
        cache_write_tokens_details: { ttl_30m_tokens: 800, ttl_12h_tokens: 0 },
      },
    }).usage;
    expect(u.cacheWriteTokens).toBe(800);
    expect(u.cacheWriteByTtl).toEqual([{ ttl: 1800, tokens: 800 }]);
    const both = complete({
      input_tokens_details: {
        cached_tokens: 0,
        cache_write_tokens: 700,
        cache_write_tokens_details: { ttl_30m_tokens: 300, ttl_12h_tokens: 400 },
      },
    }).usage;
    expect(both.cacheWriteByTtl).toEqual([
      { ttl: 1800, tokens: 300 },
      { ttl: 43200, tokens: 400 },
    ]);
  });

  it("drops a split that does not sum to the written tokens", () => {
    const u = complete({
      input_tokens_details: {
        cached_tokens: 0,
        cache_write_tokens: 900,
        cache_write_tokens_details: { ttl_30m_tokens: 300, ttl_12h_tokens: 400 },
      },
    }).usage;
    expect(u.cacheWriteTokens).toBe(900);
    expect(u).not.toHaveProperty("cacheWriteByTtl");
  });

  it("no details -> no cacheWriteByTtl", () => {
    const u = complete({
      input_tokens_details: { cached_tokens: 0, cache_write_tokens: 50 },
    }).usage;
    expect(u).not.toHaveProperty("cacheWriteByTtl");
  });
});
