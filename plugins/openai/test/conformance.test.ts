import {
  isModelError,
  MODEL_PROVIDER_CAPABILITY_V2,
  type ModelProvider,
  type ModelRequest,
  type ModelStreamEvent,
} from "@capybara-hq/plugin-sdk";
import {
  describeModelProviderConformance,
  type FakeModelServer,
  type FakeResponse,
  startFakeModelServer,
} from "@capybara-hq/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import plugin, { createOpenAIProvider, type ModelConfig } from "../src/index.js";
import { buildRequest } from "../src/map-request.js";
import { errorJson, openaiRoutes, sseResponse } from "./fixtures.js";

const gpt = (id: string, over: Partial<ModelConfig> = {}): ModelConfig => ({
  id,
  contextWindow: 400_000,
  maxOutputTokens: 128_000,
  reasoning: true,
  vision: true,
  ...over,
});

// ---- 夹具模式 ----
describeModelProviderConformance("openai (fixtures)", async () => {
  const server = await startFakeModelServer(openaiRoutes());
  return {
    contract: 2,
    plugin: "openai",
    provider: createOpenAIProvider({
      apiKey: "sk-fixture",
      baseUrl: `${server.url}/v1`,
      models: [gpt("gpt-5.5")],
    }),
    model: "gpt-5.5",
    expect: { thinking: true, caching: true },
    teardown: () => server.stop(),
  };
});

// ---- 真实接口模式 ----
const LIVE_KEY = process.env.CAPYBARA_TEST_OPENAI_API_KEY;
const LIVE_MODEL = process.env.CAPYBARA_TEST_OPENAI_MODEL;
if (!LIVE_KEY || !LIVE_MODEL) {
  console.info(
    "[plugin-openai] CAPYBARA_TEST_OPENAI_API_KEY / CAPYBARA_TEST_OPENAI_MODEL not set: live conformance skipped",
  );
}
// 真实接口的思考与缓存用例常超过默认 5 秒
describe.skipIf(!LIVE_KEY || !LIVE_MODEL)("live", { timeout: 120_000 }, () => {
  describeModelProviderConformance(`openai (live, ${LIVE_MODEL})`, async () => ({
    contract: 2,
    plugin: "openai",
    provider: createOpenAIProvider({
      apiKey: LIVE_KEY ?? "",
      models: [gpt(LIVE_MODEL ?? "")],
    }),
    model: LIVE_MODEL ?? "",
    expect: { thinking: true, caching: true },
    teardown: async () => {},
  }));
});

// ---- 错误映射与边界 ----
const req = (over: Partial<ModelRequest> = {}): ModelRequest => ({
  model: "gpt-5.5",
  system: [{ text: "Be brief.", cache: false }],
  messages: [{ role: "user", content: [{ type: "text", text: "Hi" }] }],
  tools: [],
  maxOutputTokens: 256,
  params: {},
  ...over,
});

async function drain(p: ModelProvider, r: ModelRequest): Promise<ModelStreamEvent[]> {
  const out: ModelStreamEvent[] = [];
  for await (const e of p.stream(r, { signal: new AbortController().signal })) out.push(e);
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

describe("openai: errors and edge cases", () => {
  let server: FakeModelServer;
  let next: () => FakeResponse;
  const provider = () =>
    createOpenAIProvider({
      apiKey: "sk-fixture",
      baseUrl: `${server.url}/v1`,
      models: [gpt("gpt-5.5"), gpt("gpt-4.1", { reasoning: false, streamIdleTimeoutMs: 60_000 })],
    });

  beforeAll(async () => {
    server = await startFakeModelServer(() => next());
  });
  afterAll(async () => {
    await server?.stop();
  });

  it("429 -> rate_limited with retryAfterMs", async () => {
    next = () =>
      errorJson(
        429,
        { message: "Rate limit reached", type: "requests", code: "rate_limit_exceeded" },
        { "retry-after-ms": "1500" },
      );
    const e = await streamError(provider());
    expect(isModelError(e)).toBe(true);
    if (!isModelError(e)) return;
    expect(e.kind).toBe("rate_limited");
    expect(e.retryAfterMs).toBe(1500);
  });

  it("401 -> auth, 403 -> auth", async () => {
    next = () =>
      errorJson(401, {
        message: "Incorrect API key provided",
        type: "invalid_request_error",
        code: "invalid_api_key",
      });
    const e1 = await streamError(provider());
    expect(isModelError(e1) && e1.kind).toBe("auth");
    next = () => errorJson(403, { message: "Forbidden", type: "invalid_request_error" });
    const e2 = await streamError(provider());
    expect(isModelError(e2) && e2.kind).toBe("auth");
  });

  it("400 code context_length_exceeded -> context_overflow; other 400 -> invalid_request", async () => {
    next = () =>
      errorJson(400, {
        message: "Your input exceeds the context window of this model.",
        type: "invalid_request_error",
        code: "context_length_exceeded",
        param: "input",
      });
    const e1 = await streamError(provider());
    expect(isModelError(e1) && e1.kind).toBe("context_overflow");
    next = () =>
      errorJson(400, {
        message: "context_length_exceeded mentioned only in the message",
        type: "invalid_request_error",
      });
    const e2 = await streamError(provider());
    expect(isModelError(e2) && e2.kind).toBe("invalid_request");
  });

  it.each(["completed", "incomplete"] as const)(
    "response.%s then the connection stays open -> stops reading and completes promptly",
    async (kind) => {
      next = () => {
        const full = sseResponse({
          model: "gpt-5.5",
          items: [{ type: "message", text: "done" }],
          usage: { input_tokens: 10, output_tokens: 5 },
          ...(kind === "incomplete" ? { incomplete: "max_output_tokens" as const } : {}),
        });
        if (!("sse" in full)) throw new Error("unexpected fixture");
        return { ...full, keepOpen: true };
      };
      const t0 = Date.now();
      const events = await Promise.race([
        drain(provider(), req()),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error("stream kept reading after the terminal event")),
            2_000,
          ),
        ),
      ]);
      expect(Date.now() - t0).toBeLessThan(2_000);
      const done = complete(events);
      expect(done.content).toMatchObject([{ type: "text", text: "done" }]);
      expect(done.stopReason).toBe(kind === "incomplete" ? "max_tokens" : "end_turn");
    },
  );

  it("500 -> server", async () => {
    next = () => errorJson(500, { message: "Internal", type: "server_error" });
    const e = await streamError(provider());
    expect(isModelError(e) && e.kind).toBe("server");
  });

  it("mid-stream error event -> classified by code; deltas already yielded", async () => {
    next = () => {
      const full = sseResponse({
        model: "gpt-5.5",
        items: [{ type: "message", text: "partial answer here" }],
        usage: { input_tokens: 10, output_tokens: 5 },
      });
      if (!("sse" in full)) throw new Error("unexpected fixture");
      return {
        status: 200,
        sse: [
          ...full.sse.slice(0, 6),
          {
            event: "error",
            data: JSON.stringify({
              type: "error",
              code: "rate_limit_exceeded",
              message: "Slow down",
              param: null,
              sequence_number: 6,
            }),
          },
        ],
      };
    };
    const seen: ModelStreamEvent[] = [];
    let err: unknown;
    try {
      for await (const e of provider().stream(req(), { signal: new AbortController().signal })) {
        seen.push(e);
      }
    } catch (e) {
      err = e;
    }
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((e) => e.type === "text_delta")).toBe(true);
    expect(isModelError(err) && err.kind).toBe("rate_limited");
  });

  it("response.failed -> classified by response.error.code", async () => {
    for (const [code, kind] of [
      ["server_error", "server"],
      ["rate_limit_exceeded", "rate_limited"],
      ["invalid_prompt", "invalid_request"],
    ] as const) {
      next = () => ({
        status: 200,
        sse: [
          {
            event: "response.failed",
            data: JSON.stringify({
              type: "response.failed",
              sequence_number: 0,
              response: {
                id: "resp_x",
                object: "response",
                status: "failed",
                output: [],
                error: { code, message: "failed" },
                incomplete_details: null,
                usage: null,
              },
            }),
          },
        ],
      });
      const e = await streamError(provider());
      expect(isModelError(e) && e.kind, code).toBe(kind);
    }
  });

  it("stream cut before response.completed -> network (retryable), not a partial message_complete", async () => {
    next = () => {
      const full = sseResponse({
        model: "gpt-5.5",
        items: [{ type: "message", text: "partial answer" }],
        usage: { input_tokens: 10, output_tokens: 5 },
      });
      if (!("sse" in full)) throw new Error("unexpected fixture");
      return { status: 200, sse: full.sse.slice(0, -1) };
    };
    const e = await streamError(provider());
    expect(isModelError(e) && e.kind).toBe("network");
  });

  it("network failure -> network", async () => {
    const p = createOpenAIProvider({
      apiKey: "sk-fixture",
      baseUrl: "http://127.0.0.1:1/v1",
      models: [gpt("gpt-5.5")],
    });
    const e = await streamError(p);
    expect(isModelError(e) && e.kind).toBe("network");
  });

  for (const [label, args] of [
    ["truncated", '{"city": "Par'],
    ["missing colon", '{"a" 1}'],
    ["trailing comma", '{"a":1,}'],
    ["extra closing brace", '{"a":1}}'],
    ["not JSON", "hello"],
    ["JSON array", "[1,2]"],
    ["JSON string", '"x"'],
    ["JSON null", "null"],
  ] as const) {
    it(`malformed function_call arguments -> invalid_request: ${label}`, async () => {
      next = () =>
        sseResponse({
          model: "gpt-5.5",
          items: [{ type: "function_call", callId: "call_x", name: "w", args }],
          usage: { input_tokens: 10, output_tokens: 5 },
        });
      const e = await streamError(provider());
      expect(isModelError(e) && e.kind, args).toBe("invalid_request");
    });
  }

  it("usage: inputTokens excludes cached and cache-write tokens (R23/R40)", async () => {
    next = () =>
      sseResponse({
        model: "gpt-5.5",
        items: [{ type: "message", text: "ok" }],
        usage: { input_tokens: 5010, output_tokens: 7, cached_tokens: 5000 },
      });
    const done = complete(await drain(provider(), req()));
    expect(done.usage).toEqual({
      inputTokens: 10,
      outputTokens: 7,
      cacheReadTokens: 5000,
      cacheWriteTokens: 0,
    });

    next = () =>
      sseResponse({
        model: "gpt-5.5",
        items: [{ type: "message", text: "ok" }],
        usage: {
          input_tokens: 9000,
          output_tokens: 7,
          cached_tokens: 3000,
          cache_write_tokens: 5990,
        },
      });
    const d2 = complete(await drain(provider(), req()));
    expect(d2.usage).toEqual({
      inputTokens: 10,
      outputTokens: 7,
      cacheReadTokens: 3000,
      cacheWriteTokens: 5990,
    });

    // 计数不一致时下限为 0
    next = () =>
      sseResponse({
        model: "gpt-5.5",
        items: [{ type: "message", text: "ok" }],
        usage: { input_tokens: 100, output_tokens: 7, cached_tokens: 80, cache_write_tokens: 50 },
      });
    const d3 = complete(await drain(provider(), req()));
    expect(d3.usage.inputTokens).toBe(0);
    expect(d3.usage.cacheWriteTokens).toBe(50);
  });

  it('reasoningSummary: "off" omits reasoning.summary in the request body', async () => {
    next = () =>
      sseResponse({
        model: "gpt-5.5",
        items: [{ type: "message", text: "hi" }],
        usage: { input_tokens: 10, output_tokens: 5 },
      });
    const p = createOpenAIProvider({
      apiKey: "sk-fixture",
      baseUrl: `${server.url}/v1`,
      models: [gpt("gpt-5.5")],
      reasoningSummary: "off",
    });
    await drain(p, req({ params: { effort: "max" } }));
    const body = server.requests.at(-1)?.body as Record<string, unknown>;
    expect(body.reasoning).toEqual({ effort: "max" });
    expect(body.include).toEqual(["reasoning.encrypted_content"]);
    // 默认 auto
    await drain(provider(), req({ params: { effort: "max" } }));
    const body2 = server.requests.at(-1)?.body as Record<string, unknown>;
    expect(body2.reasoning).toEqual({ effort: "max", summary: "auto" });
    // auto 部署上 thinking 旋钮覆盖部署默认值：on 不请求摘要
    const lastBody = () => server.requests.at(-1)?.body as Record<string, unknown>;
    await drain(provider(), req({ params: { effort: "low", thinking: "on" } }));
    expect(lastBody().reasoning).toEqual({
      effort: "low",
    });
  });

  it("reasoning -> thinking deltas and thinking block with raw item in opaque, tagged with the requested model", async () => {
    next = () =>
      sseResponse({
        model: "gpt-5.5",
        items: [
          { type: "reasoning", summary: ["First part.", "Second part."], encrypted: "enc-1" },
          { type: "function_call", callId: "call_1", name: "w", args: '{"city":"Paris"}' },
        ],
        usage: { input_tokens: 10, output_tokens: 5 },
      });
    const events = await drain(provider(), req({ params: { effort: "low" } }));
    const thinking = events
      .filter((e) => e.type === "thinking_delta")
      .map((e) => (e as { text: string }).text)
      .join("");
    expect(thinking).toBe("First part.\n\nSecond part.");
    const done = complete(events);
    expect(done.stopReason).toBe("tool_use");
    expect(done.content).toEqual([
      {
        type: "thinking",
        text: "First part.\n\nSecond part.",
        opaque: {
          provider: "openai",
          // 响应里的 model 是带日期的快照名；按请求的模型 id 打标签，下一轮才能回放
          model: "gpt-5.5",
          data: {
            id: "rs_0",
            type: "reasoning",
            summary: [
              { type: "summary_text", text: "First part." },
              { type: "summary_text", text: "Second part." },
            ],
            encrypted_content: "enc-1",
          },
        },
      },
      {
        type: "tool_call",
        id: "call_1",
        name: "w",
        input: { city: "Paris" },
        opaque: { provider: "openai", model: "gpt-5.5", data: { id: "fc_1" } },
      },
    ]);

    // 下一轮：同一模型原样回放 reasoning 项与 function_call 的 id
    const replay = buildRequest(
      req({
        messages: [
          { role: "user", content: [{ type: "text", text: "q" }] },
          { role: "assistant", content: done.content },
          {
            role: "user",
            content: [{ type: "tool_result", callId: "call_1", content: "Sunny", isError: false }],
          },
        ],
      }),
      { reasoning: true, reasoningSummary: "auto" },
    );
    const thinkingBlock = done.content[0];
    expect((replay.input as unknown[])[1]).toEqual(
      thinkingBlock?.type === "thinking" ? thinkingBlock.opaque?.data : undefined,
    );
    expect((replay.input as unknown[])[2]).toEqual({
      type: "function_call",
      id: "fc_1",
      call_id: "call_1",
      name: "w",
      arguments: '{"city":"Paris"}',
    });
  });

  it("incomplete max_output_tokens -> max_tokens; content_filter -> refusal", async () => {
    next = () =>
      sseResponse({
        model: "gpt-5.5",
        items: [{ type: "message", text: "cut off" }],
        usage: { input_tokens: 10, output_tokens: 256 },
        incomplete: "max_output_tokens",
      });
    const d1 = complete(await drain(provider(), req()));
    expect(d1.stopReason).toBe("max_tokens");
    expect(d1.content).toEqual([
      {
        type: "text",
        text: "cut off",
        opaque: { provider: "openai", model: "gpt-5.5", data: { id: "msg_0" } },
      },
    ]);

    next = () =>
      sseResponse({
        model: "gpt-5.5",
        items: [{ type: "message", text: "" }],
        usage: { input_tokens: 10, output_tokens: 1 },
        incomplete: "content_filter",
      });
    const d2 = complete(await drain(provider(), req()));
    expect(d2.stopReason).toBe("refusal");
  });

  it("refusal content part -> refusal stop reason, refusal text streamed as text", async () => {
    next = () =>
      sseResponse({
        model: "gpt-5.5",
        items: [{ type: "message", text: "", refusal: "I can't help with that." }],
        usage: { input_tokens: 10, output_tokens: 5 },
      });
    const events = await drain(provider(), req());
    const done = complete(events);
    expect(done.stopReason).toBe("refusal");
    expect(done.content).toEqual([{ type: "text", text: "I can't help with that." }]);
    expect(
      events.filter((e) => e.type === "text_delta").map((e) => (e as { text: string }).text),
    ).toEqual(["I can't help with that."]);
  });

  it("non-reasoning model: request carries no reasoning params", async () => {
    next = () =>
      sseResponse({
        model: "gpt-4.1",
        items: [{ type: "message", text: "hi" }],
        usage: { input_tokens: 10, output_tokens: 5 },
      });
    await drain(
      provider(),
      req({ model: "gpt-4.1", params: { effort: "high", thinking: "summarized" } }),
    );
    const body = server.requests.at(-1)?.body as Record<string, unknown>;
    expect(body.store).toBe(false);
    expect(body.stream).toBe(true);
    expect("reasoning" in body).toBe(false);
    expect("include" in body).toBe(false);
  });

  it("unknown model -> invalid_request without calling the API", async () => {
    const before = server.requests.length;
    const e = await streamError(provider(), req({ model: "gpt-unknown" }));
    expect(isModelError(e) && e.kind).toBe("invalid_request");
    expect(server.requests.length).toBe(before);
  });

  it("abort mid-stream -> aborted, no message_complete", async () => {
    next = () =>
      sseResponse({
        model: "gpt-5.5",
        items: [{ type: "message", text: "a fairly long answer split into many deltas" }],
        usage: { input_tokens: 10, output_tokens: 5 },
      });
    const ac = new AbortController();
    const it = provider().stream(req(), { signal: ac.signal })[Symbol.asyncIterator]();
    const first = await it.next();
    expect(first.value?.type).toBe("text_delta");
    ac.abort();
    let err: unknown;
    try {
      for (;;) {
        const r = await it.next();
        if (r.done) break;
        expect(r.value.type).not.toBe("message_complete");
      }
    } catch (e) {
      err = e;
    }
    expect(isModelError(err) && err.kind).toBe("aborted");
  });

  it("abort while waiting on a stalled stream -> aborted", async () => {
    next = () => ({ stall: true });
    const ac = new AbortController();
    const it = provider().stream(req(), { signal: ac.signal })[Symbol.asyncIterator]();
    const pending = it.next();
    ac.abort();
    const err = await pending.then(
      () => null,
      (e: unknown) => e,
    );
    expect(isModelError(err) && err.kind).toBe("aborted");
  });

  it('reasoningSummary: "off" deployment declares only effort (summaries cannot be requested)', async () => {
    const p = createOpenAIProvider({
      apiKey: "sk-fixture",
      baseUrl: `${server.url}/v1`,
      models: [gpt("gpt-5.5")],
      reasoningSummary: "off",
    });
    const [m] = await p.listModels();
    expect(m?.parameters.map((d) => d.key)).toEqual(["effort"]);
  });

  it("listModels comes straight from config", async () => {
    const before = server.requests.length;
    expect(await provider().listModels()).toEqual([
      {
        id: "gpt-5.5",
        displayName: "gpt-5.5",
        contextWindow: 400_000,
        maxOutputTokens: 128_000,
        capabilities: {
          tools: true,
          vision: true,
          reasoning: true,
          caching: true,
          midConversationSystem: true,
        },
        parameters: [
          {
            key: "effort",
            standard: "effort",
            schema: { type: "string", enum: ["low", "medium", "high", "xhigh", "max"] },
            label: { zh: "思考深度", en: "Effort" },
            description: expect.any(Object),
          },
          {
            key: "thinking",
            standard: "thinking",
            schema: { type: "string", enum: ["on", "summarized"] },
            label: { zh: "思考模式", en: "Thinking" },
            description: expect.any(Object),
          },
        ],
      },
      {
        id: "gpt-4.1",
        displayName: "gpt-4.1",
        contextWindow: 400_000,
        maxOutputTokens: 128_000,
        capabilities: {
          tools: true,
          vision: true,
          reasoning: false,
          caching: true,
          midConversationSystem: true,
        },
        streamIdleTimeoutMs: 60_000,
        parameters: [],
      },
    ]);
    expect(server.requests.length).toBe(before);
  });
});

describe("openai: plugin manifest", () => {
  it("name, capability, deployment config requires at least one model and a secret apiKey", () => {
    expect(plugin.name).toBe("openai");
    expect(plugin.provides).toEqual([MODEL_PROVIDER_CAPABILITY_V2]);
    const schema = plugin.config?.deployment;
    expect(schema).toBeDefined();
    if (schema === undefined) return;
    expect(schema.safeParse({ apiKey: "k", models: [] }).success).toBe(false);
    expect(schema.safeParse({ apiKey: "k" }).success).toBe(false);
    expect(
      schema.safeParse({
        apiKey: "k",
        organization: "org-1",
        models: [
          { id: "gpt-5.5", contextWindow: 1, maxOutputTokens: 1, reasoning: true, vision: true },
        ],
      }).success,
    ).toBe(true);
    const models = [
      { id: "gpt-5.5", contextWindow: 1, maxOutputTokens: 1, reasoning: true, vision: true },
    ];
    const parsed = schema.parse({ apiKey: "k", models }) as { reasoningSummary?: unknown };
    expect(parsed.reasoningSummary).toBe("auto");
    expect(schema.safeParse({ apiKey: "k", models, reasoningSummary: "off" }).success).toBe(true);
    expect(schema.safeParse({ apiKey: "k", models, reasoningSummary: "detailed" }).success).toBe(
      false,
    );
  });
});
