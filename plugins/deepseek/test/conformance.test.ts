import {
  isModelError,
  type ModelProvider,
  type ModelRequest,
  type ModelStreamEvent,
} from "@capybara-hq/plugin-sdk";
import {
  assertExtensionSecretsReachable,
  describeModelProviderConformance,
  extensionDeploymentSecretValues,
  type FakeModelServer,
  type FakeResponse,
  startFakeModelServer,
} from "@capybara-hq/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import plugin, { createDeepSeekProvider } from "../src/index.js";
import { deepseekRoutes, errorJson, sseChat, usageFor } from "./fixtures.js";

const PLUGIN = "deepseek";

describeModelProviderConformance("deepseek (fixtures)", async () => {
  const server = await startFakeModelServer(deepseekRoutes());
  return {
    contract: 2,
    plugin: PLUGIN,
    provider: createDeepSeekProvider({ apiKey: "sk-fixture", baseUrl: server.url }),
    model: "deepseek-flash",
    expect: { thinking: true, caching: true },
    teardown: () => server.stop(),
  };
});

// ---- live mode: the key falls back to the openai-compatible test key (a DeepSeek endpoint) ----
const LIVE_KEY =
  process.env.CAPYBARA_TEST_DEEPSEEK_API_KEY ?? process.env.CAPYBARA_TEST_OAICOMPAT_API_KEY;
if (!LIVE_KEY) {
  console.info(
    "[plugin-deepseek] CAPYBARA_TEST_DEEPSEEK_API_KEY not set: live conformance skipped",
  );
}
describe.skipIf(!LIVE_KEY)("live", { timeout: 120_000 }, () => {
  describeModelProviderConformance("deepseek (live, deepseek-flash)", async () => {
    const provider = createDeepSeekProvider({ apiKey: LIVE_KEY ?? "" });
    // the model comes from the live list
    const models = await provider.listModels();
    const flash = models.find((m) => m.id === "deepseek-flash") ?? models[0];
    return {
      contract: 2,
      plugin: PLUGIN,
      provider,
      model: flash?.id ?? "deepseek-flash",
      expect: { thinking: true, caching: true },
      cachePrefixTokens: 2000,
      teardown: async () => {},
    };
  });
});

// ---- stream edge cases, errors and per-call config ----
const req = (over: Partial<ModelRequest> = {}): ModelRequest => ({
  model: "deepseek-flash",
  system: [{ text: "Be brief.", cache: false }],
  messages: [{ role: "user", content: [{ type: "text", text: "Hi" }] }],
  tools: [],
  maxOutputTokens: 256,
  params: {},
  ...over,
});

async function drain(
  p: ModelProvider,
  r: ModelRequest,
  opts: { signal?: AbortSignal; config?: unknown } = {},
): Promise<ModelStreamEvent[]> {
  const out: ModelStreamEvent[] = [];
  for await (const e of p.stream(r, {
    signal: opts.signal ?? new AbortController().signal,
    ...(opts.config !== undefined ? { config: opts.config } : {}),
  })) {
    out.push(e);
  }
  return out;
}

async function streamError(p: ModelProvider, r: ModelRequest = req(), config?: unknown) {
  try {
    await drain(p, r, config !== undefined ? { config } : {});
  } catch (e) {
    return e;
  }
  throw new Error("expected stream to throw");
}

const complete = (events: ModelStreamEvent[]) => {
  const done = events.at(-1);
  if (done?.type !== "message_complete") throw new Error("expected message_complete last");
  return done;
};
const kindOf = (e: unknown) => (isModelError(e) ? e.kind : `not a ModelError: ${String(e)}`);

describe("deepseek: stream edge cases and errors", () => {
  let server: FakeModelServer;
  let next: () => FakeResponse;
  const provider = () => createDeepSeekProvider({ apiKey: "sk-fixture", baseUrl: server.url });
  const usage = usageFor({ total: 5, output: 1 });

  beforeAll(async () => {
    server = await startFakeModelServer(() => next());
  });
  afterAll(async () => {
    await server?.stop();
  });

  it("accumulates reasoning, text and parallel tool calls; usage subtracts cache hits", async () => {
    next = () =>
      sseChat({
        reasoning: "Think twice.",
        text: "Checking both.",
        toolCalls: [
          { id: "call_a", name: "get_weather", args: '{"city":"Paris"}' },
          { id: "call_b", name: "get_weather", args: '{"city":"Rome"}' },
        ],
        finish: "tool_calls",
        usage: usageFor({ total: 100, cached: 64, output: 20 }),
      });
    const events = await drain(provider(), req());
    const done = complete(events);
    expect(done.stopReason).toBe("tool_use");
    expect(events.flatMap((e) => (e.type === "thinking_delta" ? [e.text] : [])).join("")).toBe(
      "Think twice.",
    );
    expect(done.content).toEqual([
      {
        type: "thinking",
        text: "Think twice.",
        opaque: {
          provider: "deepseek",
          model: "deepseek-flash",
          data: { field: "reasoning_content" },
        },
      },
      { type: "text", text: "Checking both." },
      { type: "tool_call", id: "call_a", name: "get_weather", input: { city: "Paris" } },
      { type: "tool_call", id: "call_b", name: "get_weather", input: { city: "Rome" } },
    ]);
    expect(done.usage).toEqual({
      inputTokens: 36,
      outputTokens: 20,
      cacheReadTokens: 64,
      cacheWriteTokens: 0,
    });
  });

  it("finish_reason: length -> max_tokens (partial tool calls dropped), content_filter -> refusal", async () => {
    next = () =>
      sseChat({
        text: "Partial",
        toolCalls: [{ id: "call_x", name: "t", args: '{"a":' }],
        finish: "length",
        usage,
      });
    const d1 = complete(await drain(provider(), req()));
    expect(d1.stopReason).toBe("max_tokens");
    expect(d1.content).toEqual([{ type: "text", text: "Partial" }]);
    next = () => sseChat({ finish: "content_filter", usage });
    expect(complete(await drain(provider(), req())).stopReason).toBe("refusal");
  });

  it.each(["insufficient_system_resource", "aborted"])(
    "finish_reason %s -> server (retryable)",
    async (finish) => {
      next = () => sseChat({ text: "cut", finish, usage });
      const e = await streamError(provider());
      expect(kindOf(e)).toBe("server");
      expect(isModelError(e) && e.retryable).toBe(true);
    },
  );

  it("a stream that ends before finish_reason -> network", async () => {
    next = () => sseChat({ text: "cut", finish: null });
    expect(kindOf(await streamError(provider()))).toBe("network");
  });

  it("malformed tool_calls arguments -> invalid_request", async () => {
    next = () =>
      sseChat({
        toolCalls: [{ id: "call_bad", name: "get_weather", args: '{"city": Paris' }],
        finish: "tool_calls",
        usage,
      });
    expect(kindOf(await streamError(provider()))).toBe("invalid_request");
  });

  it("stops reading after finish_reason + usage even if the connection stays open", async () => {
    next = () => sseChat({ text: "Done", finish: "stop", usage, keepOpen: true, omitDone: true });
    expect(complete(await drain(provider(), req())).content).toEqual([
      { type: "text", text: "Done" },
    ]);
  });

  describe("HTTP errors", () => {
    it.each([
      [400, "invalid_request"],
      [422, "invalid_request"],
      [401, "auth"],
      [402, "auth"],
      [429, "rate_limited"],
      [500, "server"],
      [503, "overloaded"],
    ])("%s -> %s", async (status, kind) => {
      next = () => errorJson(status, { message: "boom" });
      expect(kindOf(await streamError(provider()))).toBe(kind);
    });

    it("429 carries retry-after as retryAfterMs", async () => {
      next = () => errorJson(429, { message: "slow down" }, { "retry-after": "7" });
      const e = await streamError(provider());
      expect(isModelError(e) && e.retryAfterMs).toBe(7000);
    });

    it("context-length codes -> context_overflow", async () => {
      next = () => errorJson(400, { message: "too long", code: "context_length_exceeded" });
      expect(kindOf(await streamError(provider()))).toBe("context_overflow");
    });
  });

  describe("per-call config", () => {
    it("no key in opts.config nor defaults -> auth before any request", async () => {
      const before = server.requests.length;
      const e = await streamError(createDeepSeekProvider({ baseUrl: server.url }));
      expect(kindOf(e)).toBe("auth");
      expect(server.requests.length).toBe(before);
    });

    it("an org key in opts.config is the one sent", async () => {
      next = () => sseChat({ text: "ok", finish: "stop", usage });
      await drain(provider(), req(), { config: { apiKey: "sk-org", baseUrl: server.url } });
      expect(server.requests.at(-1)?.headers.authorization).toBe("Bearer sk-org");
      await drain(provider(), req());
      expect(server.requests.at(-1)?.headers.authorization).toBe("Bearer sk-fixture");
    });

    it("an invalid opts.config -> invalid_request", async () => {
      expect(kindOf(await streamError(provider(), req(), { apiKey: 5 }))).toBe("invalid_request");
    });
  });

  it("passes the kernel's secret reachability check and the key is redacted", () => {
    expect(() => assertExtensionSecretsReachable(plugin)).not.toThrow();
    expect(extensionDeploymentSecretValues(plugin, { apiKey: "sk-deepseek-secret-123" })).toEqual([
      "sk-deepseek-secret-123",
    ]);
  });
});
