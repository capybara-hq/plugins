import {
  isModelError,
  type ModelProvider,
  type ModelRequest,
  type ModelStreamEvent,
} from "@capybara-hq/plugin-sdk";
import {
  describeModelProviderConformance,
  type FakeModelServer,
  type FakeRequest,
  type FakeResponse,
  startFakeModelServer,
} from "@capybara-hq/testing";
import { afterEach, describe, expect, it } from "vitest";
import { createBailianProvider } from "../src/index.js";
import {
  bailianRoutes,
  errorJson,
  fixtureModels,
  listResponse,
  sseGeneration,
} from "./fixtures.js";

const PLUGIN = "bailian";

// Fixture conformance on both native endpoints: a vision model (multimodal-generation) and a
// text-only one (text-generation), each with thinking and an embedding model.
for (const model of ["qwen3.8-flash", "qwen-flash"]) {
  describeModelProviderConformance(`bailian (fixtures, ${model})`, async () => {
    const server = await startFakeModelServer(bailianRoutes());
    return {
      contract: 2,
      plugin: PLUGIN,
      provider: createBailianProvider({ apiKey: "sk-fixture", baseUrl: server.url }),
      model,
      expect: {
        thinking: true,
        caching: true,
        embedding: { model: "text-embedding-v4", dimensions: 512 },
      },
      teardown: () => server.stop(),
    };
  });
}

// ---- stream edge cases and the error table ----

const req = (over: Partial<ModelRequest> = {}): ModelRequest => ({
  model: "qwen-flash",
  system: [],
  messages: [{ role: "user", content: [{ type: "text", text: "Hi" }] }],
  tools: [],
  maxOutputTokens: 512,
  params: {},
  ...over,
});

let server: FakeModelServer | undefined;
afterEach(async () => {
  await server?.stop();
  server = undefined;
});

/** A server whose generation route answers `gen`; the list is the fixture list. */
async function withGeneration(gen: (r: FakeRequest) => FakeResponse) {
  server = await startFakeModelServer((r) =>
    r.path.startsWith("/api/v1/models") ? listResponse(r.path, fixtureModels()) : gen(r),
  );
  return createBailianProvider({ apiKey: "sk-fixture", baseUrl: server.url });
}

async function run(provider: ModelProvider, r: ModelRequest = req(), signal?: AbortSignal) {
  const events: ModelStreamEvent[] = [];
  let error: unknown;
  try {
    for await (const ev of provider.stream(r, { signal: signal ?? new AbortController().signal })) {
      events.push(ev);
    }
  } catch (e) {
    error = e;
  }
  return { events, error, done: events.find((e) => e.type === "message_complete") };
}

const kindOf = (e: unknown) => (isModelError(e) ? e.kind : `not a ModelError: ${String(e)}`);

describe("stream", () => {
  it("routes a vision model to multimodal-generation and a text model to text-generation", async () => {
    const provider = await withGeneration((r) =>
      sseGeneration({ text: "ok", finish: "stop", multimodal: r.path.includes("multimodal") }),
    );
    await run(provider, req({ model: "qwen3.8-flash" }));
    await run(provider, req({ model: "qwen-flash" }));
    const gen = server?.requests.filter((r) => !r.path.startsWith("/api/v1/models")) ?? [];
    expect(gen.map((r) => r.path)).toEqual([
      "/api/v1/services/aigc/multimodal-generation/generation",
      "/api/v1/services/aigc/text-generation/generation",
    ]);
    for (const r of gen) {
      expect(r.headers["x-dashscope-sse"]).toBe("enable");
      expect(r.headers.authorization).toBe("Bearer sk-fixture");
    }
  });

  it("caches the endpoint of a model in kv", async () => {
    const store = new Map<string, string>();
    const kv = {
      get: async (k: string) => store.get(k) ?? null,
      set: async (k: string, v: string, o: { ttlSeconds: number }) => {
        expect(o.ttlSeconds).toBe(86_400);
        store.set(k, v);
      },
    };
    server = await startFakeModelServer(bailianRoutes());
    const provider = createBailianProvider({ apiKey: "sk-fixture", baseUrl: server.url }, { kv });
    await run(provider, req({ model: "qwen3.8-flash" }));
    await run(provider, req({ model: "qwen3.8-flash" }));
    const lookups = server.requests.filter((r) => r.path.startsWith("/api/v1/models"));
    expect(lookups).toHaveLength(1);
    expect(new URL(lookups[0]?.path ?? "", "http://x").searchParams.get("model")).toBe(
      "qwen3.8-flash",
    );
  });

  it.each(["get", "set", "both"])(
    "a failing kv (%s) is a miss with one warn, never a failed stream",
    async (which) => {
      const boom = async () => {
        throw new Error("redis down");
      };
      const kv = {
        get: which === "set" ? async () => null : boom,
        set: which === "get" ? async () => {} : boom,
      };
      const warns: unknown[] = [];
      server = await startFakeModelServer(bailianRoutes());
      const provider = createBailianProvider(
        { apiKey: "sk-fixture", baseUrl: server.url },
        { kv, log: { warn: (...a: unknown[]) => warns.push(a) } },
      );
      const { error, done } = await run(provider, req({ model: "qwen3.8-flash" }));
      expect(error).toBeUndefined();
      expect(done?.type).toBe("message_complete");
      expect(warns).toHaveLength(1);
    },
  );

  it("an unlisted model is invalid_request before any generation request", async () => {
    const provider = await withGeneration(() => sseGeneration({ text: "x", finish: "stop" }));
    const { error } = await run(provider, req({ model: "nope" }));
    expect(kindOf(error)).toBe("invalid_request");
    expect(server?.requests.some((r) => r.path.includes("generation"))).toBe(false);
  });

  it("accumulates text, thinking and tool calls by index; usage subtracts cache tokens", async () => {
    const provider = await withGeneration(() =>
      sseGeneration({
        reasoning: "Two cities, two calls.",
        text: "Checking both.",
        toolCalls: [
          { id: "call_a", name: "get_weather", args: '{"city": "Paris"}' },
          { id: "call_b", name: "get_weather", args: '{"city": "Rome"}' },
        ],
        finish: "tool_calls",
        usage: {
          input_tokens: 5035,
          output_tokens: 40,
          prompt_tokens_details: { cached_tokens: 3000, cache_creation_input_tokens: 2000 },
        },
      }),
    );
    const { events, done, error } = await run(provider);
    expect(error).toBeUndefined();
    const text = events.flatMap((e) => (e.type === "text_delta" ? [e.text] : [])).join("");
    const thinking = events.flatMap((e) => (e.type === "thinking_delta" ? [e.text] : [])).join("");
    expect(text).toBe("Checking both.");
    expect(thinking).toBe("Two cities, two calls.");
    expect(done).toEqual({
      type: "message_complete",
      content: [
        {
          type: "thinking",
          text: "Two cities, two calls.",
          opaque: {
            provider: "bailian",
            model: "qwen-flash",
            data: { field: "reasoning_content" },
          },
        },
        { type: "text", text: "Checking both." },
        { type: "tool_call", id: "call_a", name: "get_weather", input: { city: "Paris" } },
        { type: "tool_call", id: "call_b", name: "get_weather", input: { city: "Rome" } },
      ],
      stopReason: "tool_use",
      usage: { inputTokens: 35, outputTokens: 40, cacheReadTokens: 3000, cacheWriteTokens: 2000 },
    });
  });

  it("length drops partial tool calls and is max_tokens", async () => {
    const provider = await withGeneration(() =>
      sseGeneration({
        text: "abc",
        toolCalls: [{ id: "c", name: "get_weather", args: '{"ci' }],
        finish: "length",
      }),
    );
    const { done } = await run(provider);
    expect(done?.type === "message_complete" && done.stopReason).toBe("max_tokens");
    expect(done?.type === "message_complete" && done.content).toEqual([
      { type: "text", text: "abc" },
    ]);
  });

  it("malformed tool arguments are invalid_request", async () => {
    const provider = await withGeneration(() =>
      sseGeneration({
        toolCalls: [{ id: "c", name: "f", args: "{not json" }],
        finish: "tool_calls",
      }),
    );
    const { error, done } = await run(provider);
    expect(kindOf(error)).toBe("invalid_request");
    expect(done).toBeUndefined();
  });

  it("a stream cut before finish_reason is network, never a half message_complete", async () => {
    const provider = await withGeneration(() => sseGeneration({ text: "partial", finish: null }));
    const { error, done, events } = await run(provider);
    expect(kindOf(error)).toBe("network");
    expect(done).toBeUndefined();
    expect(events.some((e) => e.type === "text_delta")).toBe(true);
  });

  it.each([
    ["Throttling.RateQuota", "Requests rate limit exceeded", "rate_limited"],
    [
      "InvalidParameter",
      "<400> InternalError.Algo.InvalidParameter: Range of input length should be [1, 30720]",
      "context_overflow",
    ],
    ["InvalidParameter", "The product is not activated", "invalid_request"],
    ["DataInspectionFailed", "Output data may contain inappropriate content.", "invalid_request"],
    ["InternalError", "An internal error has occured", "server"],
    ["SomethingNew", "?", "server"],
  ])("a mid-stream error event %s after text is %s", async (code, message, kind) => {
    const provider = await withGeneration(() =>
      sseGeneration({ text: "some text", finish: null, midStreamError: { code, message } }),
    );
    const { error, done } = await run(provider);
    expect(kindOf(error)).toBe(kind);
    expect(done).toBeUndefined();
  });

  it.each<[string, FakeResponse, string, number?]>([
    ["400 InvalidParameter", errorJson(400, "InvalidParameter", "bad"), "invalid_request"],
    [
      "400 SSE-bodied input length",
      {
        status: 200,
        sse: [
          {
            event: "error",
            data: JSON.stringify({
              code: "InvalidParameter",
              message:
                "<400> InternalError.Algo.InvalidParameter: Range of input length should be [1, 30720]",
            }),
          },
        ],
      },
      "context_overflow",
    ],
    ["401 InvalidApiKey", errorJson(401, "InvalidApiKey", "Invalid API-key provided."), "auth"],
    ["403 AccessDenied", errorJson(403, "AccessDenied", "denied"), "auth"],
    ["403 AccessDenied.Unpurchased", errorJson(403, "AccessDenied.Unpurchased", "x"), "auth"],
    ["400 Arrearage", errorJson(400, "Arrearage", "overdue"), "auth"],
    ["404 model", errorJson(404, "ModelNotFound", "Model not exist."), "invalid_request"],
    [
      "429 Throttling.RateQuota with retry-after",
      errorJson(429, "Throttling.RateQuota", "slow down", { "retry-after": "3" }),
      "rate_limited",
      3000,
    ],
    [
      "429 Throttling.AllocationQuota",
      errorJson(429, "Throttling.AllocationQuota", "quota"),
      "rate_limited",
    ],
    [
      "400 DataInspectionFailed",
      errorJson(400, "DataInspectionFailed", "inappropriate"),
      "invalid_request",
    ],
    ["408", errorJson(408, "RequestTimeOut", "timeout"), "timeout"],
    ["413", errorJson(413, "RequestTooLarge", "too large"), "context_overflow"],
    ["500 InternalError", errorJson(500, "InternalError", "oops"), "server"],
    ["503 ServiceUnavailable", errorJson(503, "ServiceUnavailable", "busy"), "overloaded"],
  ])("HTTP %s is %s", async (_name, response, kind, retryAfterMs) => {
    const provider = await withGeneration(() => response);
    const { error, done } = await run(provider);
    expect(kindOf(error)).toBe(kind);
    expect(done).toBeUndefined();
    if (retryAfterMs !== undefined && isModelError(error)) {
      expect(error.retryAfterMs).toBe(retryAfterMs);
    }
  });

  it("a connection failure is network", async () => {
    const s = await startFakeModelServer(() => errorJson(500, "x", "x"));
    const url = s.url;
    await s.stop();
    const provider = createBailianProvider({ apiKey: "sk-fixture", baseUrl: url });
    const { error } = await run(provider);
    expect(kindOf(error)).toBe("network");
  });

  it("aborting a stalled stream is aborted", async () => {
    const provider = await withGeneration(() => ({ stall: true }));
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 200);
    const { error } = await run(provider, req(), ac.signal);
    expect(kindOf(error)).toBe("aborted");
  });

  it("an already aborted signal sends nothing", async () => {
    const provider = await withGeneration(() => sseGeneration({ text: "x", finish: "stop" }));
    const ac = new AbortController();
    ac.abort();
    const { error } = await run(provider, req(), ac.signal);
    expect(kindOf(error)).toBe("aborted");
    expect(server?.requests).toHaveLength(0);
  });
});
