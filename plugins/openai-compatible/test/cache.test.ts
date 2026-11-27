import { type ModelCacheInfo, validateModelCache } from "@capybara-hq/plugin-sdk";
import { describe, expect, it } from "vitest";
import { DIALECTS } from "../src/dialects.js";
import { createOpenAICompatibleProvider, type EndpointModelConfig } from "../src/index.js";

/** The prompt cache each dialect declares, the per-model `caching` override and the usage tiers. */

const base = { id: "m", contextWindow: 128_000, maxOutputTokens: 8192 };

async function cacheOf(
  dialect: "generic" | "deepseek" | "qwen" | "ark",
  over: Partial<EndpointModelConfig> = {},
): Promise<ModelCacheInfo | undefined> {
  const provider = createOpenAICompatibleProvider({
    endpoints: [
      { name: "e", baseUrl: "http://127.0.0.1:1/v1", dialect, models: [{ ...base, ...over }] },
    ],
    apiKeys: {},
  });
  const [info] = await provider.listModels();
  return info?.cache;
}

const implicit: ModelCacheInfo = {
  mechanism: "implicit",
  ttlOptions: [],
  ttlIsMinimum: false,
  refreshOnHit: false,
  ttlClock: "unknown",
  guaranteed: false,
};

describe("cache declarations", () => {
  it("generic declares none, deepseek and ark implicit non-guaranteed, qwen explicit 300 s", async () => {
    expect(await cacheOf("generic")).toBeUndefined();
    expect(await cacheOf("deepseek")).toEqual({ ...implicit, minTokens: 256 });
    expect(await cacheOf("ark")).toEqual(implicit);
    expect(await cacheOf("qwen")).toEqual({
      mechanism: "explicit",
      ttlOptions: [300],
      defaultTtl: 300,
      ttlIsMinimum: false,
      refreshOnHit: true,
      ttlClock: "unknown",
      minTokens: 1024,
      guaranteed: true,
    });
  });

  it("every declaration is valid", async () => {
    for (const d of ["generic", "deepseek", "qwen", "ark"] as const) {
      expect(validateModelCache(await cacheOf(d))).toBeNull();
    }
  });

  it("the per-model caching field overrides the dialect default", async () => {
    expect(await cacheOf("qwen", { caching: false })).toBeUndefined();
    expect(await cacheOf("deepseek", { caching: false })).toBeUndefined();
    expect(await cacheOf("ark", { caching: false })).toBeUndefined();
    expect(await cacheOf("generic", { caching: true })).toEqual(implicit);
    expect(await cacheOf("qwen", { caching: true })).toEqual(await cacheOf("qwen"));
  });
});

describe("qwen usage tiers", () => {
  it("reports the write under its 300 s tier, and none when nothing is written", () => {
    const u = DIALECTS.qwen.usage({
      prompt_tokens: 2000,
      completion_tokens: 5,
      prompt_tokens_details: { cached_tokens: 0, cache_creation_input_tokens: 1900 },
    });
    expect(u.cacheWriteTokens).toBe(1900);
    expect(u.cacheWriteByTtl).toEqual([{ ttl: 300, tokens: 1900 }]);
    const hit = DIALECTS.qwen.usage({
      prompt_tokens: 2000,
      completion_tokens: 5,
      prompt_tokens_details: { cached_tokens: 1900, cache_creation_input_tokens: 0 },
    });
    expect(hit.cacheWriteByTtl).toBeUndefined();
  });
});
