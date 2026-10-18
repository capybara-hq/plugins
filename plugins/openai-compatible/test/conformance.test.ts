import {
  isModelError,
  type ModelProvider,
  type ModelRequest,
  type ModelStreamEvent,
} from "@capybara-hq/plugin-sdk";
import {
  assertPluginSecretsReachable,
  describeModelProviderConformance,
  type FakeModelServer,
  type FakeResponse,
  pluginDeploymentSecretValues,
  startFakeModelServer,
} from "@capybara-hq/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import plugin, {
  createOpenAICompatibleProvider,
  type EndpointConfig,
  type EndpointModelConfig,
} from "../src/index.js";
import { chatRoutes, type Dialect, errorJson, sseChat, usageFor } from "./fixtures.js";

const PLUGIN = "openai-compatible";

const model = (id: string, over: Partial<EndpointModelConfig> = {}): EndpointModelConfig => ({
  id,
  contextWindow: 128_000,
  maxOutputTokens: 8192,
  ...over,
});

// ---- 夹具模式：三种方言各跑一遍 ----
const fixtureModels: Record<Dialect, EndpointModelConfig> = {
  generic: model("Qwen/Qwen3-8B"),
  deepseek: model("deepseek-flash", { reasoning: true, caching: true }),
  qwen: model("qwen3.8-plus", { reasoning: true, caching: true }),
};

for (const dialect of ["generic", "deepseek", "qwen"] as const) {
  describeModelProviderConformance(`openai-compatible ${dialect} (fixtures)`, async () => {
    const server = await startFakeModelServer(chatRoutes(dialect));
    const m = fixtureModels[dialect];
    return {
      contract: 2,
      plugin: PLUGIN,
      provider: createOpenAICompatibleProvider({
        endpoints: [
          {
            name: dialect,
            baseUrl: `${server.url}/v1`,
            dialect,
            models: [m],
          },
        ],
        apiKeys: { [dialect]: "sk-fixture" },
      }),
      model: `${dialect}/${m.id}`,
      expect: { thinking: dialect !== "generic", caching: true },
      teardown: () => server.stop(),
    };
  });
}

// ---- 真实接口模式 ----
const LIVE = {
  baseUrl: process.env.CAPYBARA_TEST_OAICOMPAT_BASE_URL,
  apiKey: process.env.CAPYBARA_TEST_OAICOMPAT_API_KEY,
  model: process.env.CAPYBARA_TEST_OAICOMPAT_MODEL,
  dialect: process.env.CAPYBARA_TEST_OAICOMPAT_DIALECT as Dialect | undefined,
};
const liveReady = Boolean(LIVE.baseUrl && LIVE.apiKey && LIVE.model && LIVE.dialect);
if (!liveReady) {
  console.info(
    "[plugin-openai-compatible] CAPYBARA_TEST_OAICOMPAT_BASE_URL / _API_KEY / _MODEL / _DIALECT not set: live conformance skipped",
  );
}
// 真实接口的思考与缓存用例常超过默认 5 秒
describe.skipIf(!liveReady)("live", { timeout: 120_000 }, () => {
  const dialect = LIVE.dialect ?? "generic";
  describeModelProviderConformance(
    `openai-compatible (live, ${dialect}, ${LIVE.model})`,
    async () => ({
      contract: 2,
      plugin: PLUGIN,
      provider: createOpenAICompatibleProvider({
        endpoints: [
          {
            name: "live",
            baseUrl: LIVE.baseUrl ?? "",
            dialect,
            models: [model(LIVE.model ?? "", { reasoning: dialect !== "generic" })],
          },
        ],
        apiKeys: { live: LIVE.apiKey ?? "" },
      }),
      model: `live/${LIVE.model}`,
      // DeepSeek 的磁盘缓存对重复前缀稳定命中；其余服务的隐式缓存不保证命中
      expect: { thinking: dialect !== "generic", caching: dialect === "deepseek" },
      cachePrefixTokens: 2000,
      teardown: async () => {},
    }),
  );
});

// ---- 流的边界与错误映射 ----
const req = (over: Partial<ModelRequest> = {}): ModelRequest => ({
  model: "ds/deepseek-flash",
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
  signal = new AbortController().signal,
): Promise<ModelStreamEvent[]> {
  const out: ModelStreamEvent[] = [];
  for await (const e of p.stream(r, { signal })) out.push(e);
  return out;
}

async function streamError(p: ModelProvider, r: ModelRequest = req()): Promise<unknown> {
  try {
    await drain(p, r);
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

describe("openai-compatible: stream edge cases and errors", () => {
  let server: FakeModelServer;
  let next: () => FakeResponse;
  const endpoints = (over: Partial<EndpointConfig> = {}): EndpointConfig[] => [
    {
      name: "ds",
      baseUrl: `${server.url}/v1`,
      dialect: "deepseek",
      models: [model("deepseek-flash", { reasoning: true })],
      ...over,
    },
    {
      name: "local",
      baseUrl: `${server.url}/v1`,
      dialect: "generic",
      models: [model("org/model-a", { streamIdleTimeoutMs: 120_000, vision: true })],
    },
  ];
  const provider = (over: Partial<EndpointConfig> = {}) =>
    createOpenAICompatibleProvider({ endpoints: endpoints(over), apiKeys: { ds: "sk-fixture" } });
  const ds = (o: Parameters<typeof sseChat>[0]) => () => sseChat(o);

  beforeAll(async () => {
    server = await startFakeModelServer(() => next());
  });
  afterAll(async () => {
    await server?.stop();
  });

  it("lists models as <endpoint>/<model> with capabilities and parameters", async () => {
    const models = await provider().listModels();
    expect(models.map((m) => m.id)).toEqual(["ds/deepseek-flash", "local/org/model-a"]);
    const local = models[1];
    expect(local?.capabilities).toEqual({
      tools: true,
      vision: true,
      reasoning: false,
      caching: false,
      midConversationSystem: false,
    });
    expect(local?.streamIdleTimeoutMs).toBe(120_000);
    expect(models[0]?.capabilities.midConversationSystem).toBe(true);
    expect(models[0]?.parameters.map((p) => p.key)).toEqual([
      "thinking",
      "effort",
      "temperature",
      "maxOutputTokens",
    ]);
  });

  it("routes by endpoint, sends the upstream model id, omits Authorization without apiKey", async () => {
    next = ds({
      model: "x",
      text: "ok",
      finish: "stop",
      usage: usageFor("generic", { total: 5, output: 1 }),
    });
    await drain(provider(), req({ model: "local/org/model-a" }));
    const sent = server.requests.at(-1);
    expect(sent?.path).toBe("/v1/chat/completions");
    expect((sent?.body as { model?: string } | undefined)?.model).toBe("org/model-a");
    expect(sent?.headers.authorization).toBeUndefined();
    await drain(provider(), req());
    expect(server.requests.at(-1)?.headers.authorization).toBe("Bearer sk-fixture");
  });

  it('deepseek model configured reasoning: false -> request sends thinking { type: "disabled" }', async () => {
    const reply = () =>
      ds({
        model: "x",
        text: "ok",
        finish: "stop",
        usage: usageFor("deepseek", { total: 5, output: 1 }),
      })();
    next = reply;
    await drain(provider({ models: [model("deepseek-flash", { reasoning: false })] }), req());
    expect((server.requests.at(-1)?.body as { thinking?: unknown } | undefined)?.thinking).toEqual({
      type: "disabled",
    });
    next = reply;
    await drain(provider(), req());
    expect(server.requests.at(-1)?.body).not.toHaveProperty("thinking");
  });

  it("unknown model -> invalid_request", async () => {
    expect(kindOf(await streamError(provider(), req({ model: "ds/nope" })))).toBe(
      "invalid_request",
    );
    expect(kindOf(await streamError(provider(), req({ model: "nope" })))).toBe("invalid_request");
  });

  it("accumulates reasoning, text and parallel tool calls; opaque tags the request model", async () => {
    next = ds({
      model: "deepseek-flash",
      reasoning: "Think twice.",
      text: "Checking both.",
      toolCalls: [
        { id: "call_a", name: "get_weather", args: '{"city":"Paris"}' },
        { id: "call_b", name: "get_weather", args: '{"city":"Rome"}' },
      ],
      finish: "tool_calls",
      usage: usageFor("deepseek", { total: 100, cached: 64, output: 20 }),
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
          provider: PLUGIN,
          model: "ds/deepseek-flash",
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

  it("generic dialect ignores reasoning_content", async () => {
    next = ds({
      model: "m",
      reasoning: "hidden",
      text: "Hi",
      finish: "stop",
      usage: usageFor("generic", { total: 5, output: 1 }),
    });
    const done = complete(await drain(provider(), req({ model: "local/org/model-a" })));
    expect(done.content).toEqual([{ type: "text", text: "Hi" }]);
  });

  it("finish_reason mapping: length -> max_tokens (partial tool calls dropped), content_filter -> refusal", async () => {
    next = ds({
      model: "m",
      text: "Partial",
      toolCalls: [{ id: "call_x", name: "t", args: '{"a":' }],
      finish: "length",
      usage: usageFor("deepseek", { total: 5, output: 1 }),
    });
    const d1 = complete(await drain(provider(), req()));
    expect(d1.stopReason).toBe("max_tokens");
    expect(d1.content).toEqual([{ type: "text", text: "Partial" }]);
    next = ds({
      model: "m",
      text: "",
      finish: "content_filter",
      usage: usageFor("deepseek", { total: 5, output: 0 }),
    });
    expect(complete(await drain(provider(), req())).stopReason).toBe("refusal");
  });

  it("usage in the finish chunk is accepted", async () => {
    next = ds({
      model: "m",
      text: "Hi",
      finish: "stop",
      usage: usageFor("deepseek", { total: 10, cached: 4, output: 2 }),
      usageInFinishChunk: true,
    });
    expect(complete(await drain(provider(), req())).usage).toEqual({
      inputTokens: 6,
      outputTokens: 2,
      cacheReadTokens: 4,
      cacheWriteTokens: 0,
    });
  });

  it("malformed tool_calls arguments -> invalid_request", async () => {
    next = ds({
      model: "m",
      toolCalls: [{ id: "call_bad", name: "get_weather", args: '{"city": Paris' }],
      finish: "tool_calls",
      usage: usageFor("deepseek", { total: 5, output: 1 }),
    });
    expect(kindOf(await streamError(provider()))).toBe("invalid_request");
    next = ds({
      model: "m",
      toolCalls: [{ id: "call_arr", name: "get_weather", args: "[1,2]" }],
      finish: "tool_calls",
      usage: usageFor("deepseek", { total: 5, output: 1 }),
    });
    expect(kindOf(await streamError(provider()))).toBe("invalid_request");
  });

  it("stops reading after finish_reason + usage even if the connection stays open", async () => {
    next = ds({
      model: "m",
      text: "Done",
      finish: "stop",
      usage: usageFor("deepseek", { total: 5, output: 1 }),
      keepOpen: true,
      omitDone: true,
    });
    const started = Date.now();
    const done = complete(await drain(provider(), req()));
    expect(done.content).toEqual([{ type: "text", text: "Done" }]);
    expect(Date.now() - started).toBeLessThan(3000);
  }, 5000);

  it("server that never sends usage and keeps the connection open: finish + one more chunk ends the read", async () => {
    next = ds({
      model: "m",
      text: "No usage",
      finish: "stop",
      trailingChunk: true,
      keepOpen: true,
      omitDone: true,
    });
    const started = Date.now();
    const done = complete(await drain(provider(), req()));
    expect(done.content).toEqual([{ type: "text", text: "No usage" }]);
    expect(done.usage).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    expect(Date.now() - started).toBeLessThan(3000);
    // 收到 [DONE] 也结束（连接保持打开）
    next = ds({ model: "m", text: "Done", finish: "stop", keepOpen: true });
    expect(complete(await drain(provider(), req())).stopReason).toBe("end_turn");
  }, 8000);

  it("tool call name is assigned, not concatenated; a call without a name -> invalid_request", async () => {
    next = ds({
      model: "m",
      toolCalls: [
        { id: "call_r", name: "get_weather", args: '{"city":"Paris"}', repeatName: true },
      ],
      finish: "tool_calls",
      usage: usageFor("deepseek", { total: 5, output: 1 }),
    });
    expect(complete(await drain(provider(), req())).content).toEqual([
      { type: "tool_call", id: "call_r", name: "get_weather", input: { city: "Paris" } },
    ]);
    next = ds({
      model: "m",
      toolCalls: [{ id: "call_n", name: "", args: "{}" }],
      finish: "tool_calls",
      usage: usageFor("deepseek", { total: 5, output: 1 }),
    });
    expect(kindOf(await streamError(provider()))).toBe("invalid_request");
  });

  it("DeepSeek finish_reason insufficient_system_resource -> retryable server error", async () => {
    next = ds({
      model: "m",
      text: "Cut",
      finish: "insufficient_system_resource",
      usage: usageFor("deepseek", { total: 5, output: 1 }),
    });
    const e = await streamError(provider());
    expect(kindOf(e)).toBe("server");
    expect(isModelError(e) && e.retryable).toBe(true);
  });

  it("stream ending without finish_reason -> network", async () => {
    next = ds({ model: "m", text: "Half", finish: null, omitDone: true });
    expect(kindOf(await streamError(provider()))).toBe("network");
    next = ds({ model: "m", text: "Half", finish: null });
    expect(kindOf(await streamError(provider()))).toBe("network");
  });

  it("mid-stream error event -> server", async () => {
    next = ds({
      model: "m",
      text: "Hi",
      finish: "stop",
      midStreamError: { message: "boom", type: "server_error" },
    });
    expect(kindOf(await streamError(provider()))).toBe("server");
  });

  it("429 -> rate_limited with retryAfterMs", async () => {
    next = () => errorJson(429, { message: "Rate limit reached" }, { "retry-after": "2" });
    const e = await streamError(provider());
    expect(kindOf(e)).toBe("rate_limited");
    expect(isModelError(e) && e.retryAfterMs).toBe(2000);
  });

  it("HTTP status mapping", async () => {
    const cases: [number, string][] = [
      [400, "invalid_request"],
      [401, "auth"],
      [402, "auth"],
      [403, "auth"],
      [404, "invalid_request"],
      [408, "timeout"],
      [413, "context_overflow"],
      [422, "invalid_request"],
      [500, "server"],
      [503, "overloaded"],
    ];
    for (const [status, kind] of cases) {
      next = () => errorJson(status, { message: `status ${status}` });
      expect([status, kindOf(await streamError(provider()))]).toEqual([status, kind]);
    }
  });

  it("400 with code context_length_exceeded -> context_overflow", async () => {
    next = () => errorJson(400, { message: "too long", code: "context_length_exceeded" });
    expect(kindOf(await streamError(provider()))).toBe("context_overflow");
  });

  it("connection failure -> network", async () => {
    const p = createOpenAICompatibleProvider({
      endpoints: [
        {
          name: "dead",
          baseUrl: "http://127.0.0.1:1/v1",
          dialect: "generic",
          models: [model("m")],
        },
      ],
    });
    expect(kindOf(await streamError(p, req({ model: "dead/m" })))).toBe("network");
  });

  it("abort on a stalled stream -> aborted", async () => {
    next = () => ({ stall: true });
    const ac = new AbortController();
    const pending = drain(provider(), req(), ac.signal).catch((e: unknown) => e);
    setTimeout(() => ac.abort(), 100);
    expect(kindOf(await pending)).toBe("aborted");
  });

  it("plugin manifest provides model-provider@2 and validates config", async () => {
    expect(plugin.name).toBe(PLUGIN);
    expect(plugin.provides).toEqual(["model-provider@2"]);
    const schema = plugin.config?.deployment;
    expect(
      schema?.safeParse({
        endpoints: [
          { name: "a", baseUrl: "http://x/v1", dialect: "generic", models: [model("m")] },
          { name: "a", baseUrl: "http://y/v1", dialect: "qwen", models: [model("n")] },
        ],
      }).success,
    ).toBe(false);
    expect(
      schema?.safeParse({
        endpoints: [
          { name: "a/b", baseUrl: "http://x/v1", dialect: "generic", models: [model("m")] },
        ],
      }).success,
    ).toBe(false);
    const ok = {
      endpoints: [
        {
          name: "ds",
          baseUrl: "https://api.deepseek.com",
          dialect: "deepseek",
          models: [model("deepseek-flash")],
        },
        { name: "local", baseUrl: "http://vllm/v1", dialect: "generic", models: [model("m")] },
      ],
      apiKeys: { ds: "sk-deepseek-secret-123" },
    };
    expect(schema?.safeParse(ok).success).toBe(true);
    // 密钥不在 endpoints[] 里
    expect(schema?.safeParse({ endpoints: [{ ...ok.endpoints[0], apiKey: "sk" }] }).success).toBe(
      false,
    );
    // apiKeys 的键必须是已配置的端点名
    const bad = schema?.safeParse({ ...ok, apiKeys: { nope: "sk-x" } });
    expect(bad?.success).toBe(false);
    expect(JSON.stringify(bad?.error?.issues)).toContain("nope");
  });

  it("passes the kernel's secret reachability check and apiKeys values are redacted", () => {
    // 内核 PluginHost 加载插件时执行同一检查；secret() 放在数组元素里会被拒绝加载
    expect(() => assertPluginSecretsReachable(plugin)).not.toThrow();
    expect(
      pluginDeploymentSecretValues(plugin, {
        endpoints: [
          {
            name: "ds",
            baseUrl: "https://api.deepseek.com",
            dialect: "deepseek",
            models: [model("m")],
          },
        ],
        apiKeys: { ds: "sk-deepseek-secret-123" },
      }),
    ).toEqual(["sk-deepseek-secret-123"]);
  });
});
