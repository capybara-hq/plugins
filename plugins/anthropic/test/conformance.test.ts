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
import plugin, { createAnthropicProvider, type Kv } from "../src/index.js";
import { buildRequest } from "../src/map-request.js";
import {
  anthropicRoutes,
  errorJson,
  FEW_EFFORT_LEVELS,
  modelObject,
  NO_THINKING,
  NULL_EFFORT_LEVELS,
  sseMessage,
} from "./fixtures.js";

const memoryKv = (): Kv & { store: Map<string, string>; ttls: number[] } => {
  const store = new Map<string, string>();
  const ttls: number[] = [];
  return {
    store,
    ttls,
    get: async (k) => store.get(k) ?? null,
    set: async (k, v, opts) => {
      ttls.push(opts.ttlSeconds);
      store.set(k, v);
    },
  };
};

// ---- 夹具模式 ----
describeModelProviderConformance("anthropic (fixtures)", async () => {
  const server = await startFakeModelServer(anthropicRoutes());
  return {
    contract: 2,
    plugin: "anthropic",
    provider: createAnthropicProvider({
      kv: memoryKv(),
      apiKey: "sk-ant-fixture",
      baseUrl: server.url,
      models: ["claude-opus-5-5"],
      serverFallbacks: "default",
    }),
    model: "claude-opus-5-5",
    expect: { thinking: true, caching: true },
    teardown: () => server.stop(),
  };
});

// ---- 真实接口模式 ----
const LIVE_KEY = process.env.CAPYBARA_TEST_ANTHROPIC_API_KEY;
if (!LIVE_KEY) {
  console.info(
    "[plugin-anthropic] CAPYBARA_TEST_ANTHROPIC_API_KEY not set: live conformance (claude-haiku-5-5) skipped",
  );
}
// 真实接口的思考与缓存用例常超过默认 5 秒
describe.skipIf(!LIVE_KEY)("live", { timeout: 120_000 }, () => {
  describeModelProviderConformance("anthropic (live, claude-haiku-5-5)", async () => ({
    contract: 2,
    plugin: "anthropic",
    provider: createAnthropicProvider({
      kv: memoryKv(),
      apiKey: LIVE_KEY ?? "",
      models: ["claude-haiku-5-5"],
      serverFallbacks: "default",
    }),
    model: "claude-haiku-5-5",
    expect: { thinking: true, caching: true },
    cachePrefixTokens: 6000,
    teardown: async () => {},
  }));
});

// 收尾调用的形状：历史里有 tool_use / tool_result，照常声明工具，toolChoice none → API 接受且模型只回文本
describe.skipIf(!LIVE_KEY)("live toolChoice", { timeout: 60_000 }, () => {
  it("history with tool_use + tool_result, tools declared, toolChoice none -> text only", async () => {
    const provider = createAnthropicProvider({
      kv: memoryKv(),
      apiKey: LIVE_KEY ?? "",
      models: ["claude-haiku-5-5"],
      serverFallbacks: "default",
    });
    const events: ModelStreamEvent[] = [];
    const r: ModelRequest = {
      model: "claude-haiku-5-5",
      system: [{ text: "Be brief.", cache: false }],
      messages: [
        { role: "user", content: [{ type: "text", text: "What is the weather in Paris?" }] },
        {
          role: "assistant",
          content: [
            {
              type: "tool_call",
              id: "toolu_live_1",
              name: "get_weather",
              input: { city: "Paris" },
            },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", callId: "toolu_live_1", content: "Sunny, 21C", isError: false },
          ],
        },
        {
          role: "system",
          content: "Step limit reached. Do not call tools. Summarize what you found.",
        },
      ],
      tools: [
        {
          name: "get_weather",
          description: "Get the current weather for a city.",
          inputSchema: { type: "object", properties: { city: { type: "string" } } },
        },
      ],
      toolChoice: "none",
      maxOutputTokens: 200,
      params: {},
    };
    for await (const e of provider.stream(r, { signal: new AbortController().signal })) {
      events.push(e);
    }
    const done = events.at(-1);
    expect(done?.type).toBe("message_complete");
    if (done?.type !== "message_complete") return;
    expect(done.content.some((b) => b.type === "tool_call")).toBe(false);
    expect(done.stopReason).toBe("end_turn");
    expect(done.content.some((b) => b.type === "text" && b.text.length > 0)).toBe(true);
  });
});

// ---- 错误映射与边界 ----
const req = (over: Partial<ModelRequest> = {}): ModelRequest => ({
  model: "claude-haiku-5-5",
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

describe("anthropic: errors and edge cases", () => {
  let server: FakeModelServer;
  let next: () => FakeResponse;
  const modelFail = new Map<string, () => FakeResponse>();
  const provider = (kv: Kv = memoryKv()) =>
    createAnthropicProvider({
      kv,
      apiKey: "sk-ant-fixture",
      baseUrl: server.url,
      models: ["claude-haiku-5-5", "claude-sonnet-5"],
      serverFallbacks: "default",
    });

  beforeAll(async () => {
    server = await startFakeModelServer((r) => {
      const m = /^\/v1\/models\/([^/?]+)/.exec(r.path);
      const fail = m?.[1] !== undefined ? modelFail.get(m[1]) : undefined;
      if (fail !== undefined) return fail();
      if (m?.[1] === "claude-missing") return errorJson(404, "not_found_error", "model not found");
      if (m?.[1] !== undefined) return { status: 200, json: modelObject(m[1]) };
      return next();
    });
  });
  afterAll(async () => {
    await server?.stop();
  });

  it("429 -> rate_limited with retryAfterMs from retry-after", async () => {
    next = () => errorJson(429, "rate_limit_error", "Rate limited", { "retry-after": "7" });
    const e = await streamError(provider());
    expect(isModelError(e)).toBe(true);
    if (!isModelError(e)) return;
    expect(e.kind).toBe("rate_limited");
    expect(e.retryAfterMs).toBe(7000);
  });

  it("529 -> overloaded", async () => {
    next = () => errorJson(529, "overloaded_error", "Overloaded");
    const e = await streamError(provider());
    expect(isModelError(e) && e.kind).toBe("overloaded");
  });

  it("500 -> server", async () => {
    next = () => errorJson(500, "api_error", "Internal");
    const e = await streamError(provider());
    expect(isModelError(e) && e.kind).toBe("server");
  });

  it("401 -> auth, 403 -> auth", async () => {
    next = () => errorJson(401, "authentication_error", "invalid x-api-key");
    const e1 = await streamError(provider());
    expect(isModelError(e1) && e1.kind).toBe("auth");
    next = () => errorJson(403, "permission_error", "nope");
    const e2 = await streamError(provider());
    expect(isModelError(e2) && e2.kind).toBe("auth");
  });

  it("400 -> invalid_request", async () => {
    next = () => errorJson(400, "invalid_request_error", "bad");
    const e = await streamError(provider());
    expect(isModelError(e) && e.kind).toBe("invalid_request");
  });

  it("413 request_too_large -> context_overflow", async () => {
    next = () => errorJson(413, "request_too_large", "Request exceeds the maximum allowed size");
    const e = await streamError(provider());
    expect(isModelError(e) && e.kind).toBe("context_overflow");
  });

  it("mid-stream error event (overloaded_error) -> overloaded", async () => {
    next = () => ({
      status: 200,
      sse: [
        {
          event: "error",
          data: JSON.stringify({
            type: "error",
            error: { type: "overloaded_error", message: "Overloaded" },
          }),
        },
      ],
    });
    const e = await streamError(provider());
    expect(isModelError(e) && e.kind).toBe("overloaded");
  });

  it("server-side fallback: every thinking block is tagged with the model that answered (R39)", async () => {
    const A = "claude-opus-5-5";
    const B = "claude-opus-4-8";
    next = () =>
      sseMessage({
        model: A,
        blocks: [
          { type: "thinking", thinking: "A thinks", signature: "sig-A" },
          { type: "fallback", from: A, to: B },
          { type: "thinking", thinking: "B thinks", signature: "sig-B" },
          { type: "text", text: "B answers" },
        ],
        stopReason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 5 },
      });
    const events = await drain(provider(), req({ model: A }));
    const last = server.requests.at(-1);
    expect(last?.path).toContain("beta=true");
    const done = events.at(-1);
    expect(done?.type).toBe("message_complete");
    if (done?.type !== "message_complete") return;
    const thinking = done.content.filter((b) => b.type === "thinking");
    expect(thinking).toHaveLength(2);
    for (const b of thinking) {
      expect(b.type === "thinking" && b.opaque?.model).toBe(B);
    }
    expect(done.content.at(-1)).toEqual({ type: "text", text: "B answers" });

    // 下一轮发给原模型 A：两个思考块都不回放
    const replay = buildRequest(
      req({
        model: A,
        messages: [
          { role: "user", content: [{ type: "text", text: "q" }] },
          { role: "assistant", content: done.content },
          { role: "user", content: [{ type: "text", text: "q2" }] },
        ],
      }),
      { serverFallbacks: "default" },
    );
    expect(replay.params.messages[1]).toEqual({
      role: "assistant",
      content: [{ type: "text", text: "B answers" }],
    });
    // 发给 B 时原样回放（含签名）
    const toB = buildRequest(
      req({
        model: B,
        messages: [
          { role: "user", content: [{ type: "text", text: "q" }] },
          { role: "assistant", content: done.content },
          { role: "user", content: [{ type: "text", text: "q2" }] },
        ],
      }),
      { serverFallbacks: "default" },
    );
    expect(JSON.stringify(toB.params.messages[1])).toContain("sig-A");
    expect(JSON.stringify(toB.params.messages[1])).toContain("sig-B");
  });

  it("mid-stream error event after deltas -> overloaded (text deltas already yielded)", async () => {
    next = () => {
      const full = sseMessage({
        model: "claude-haiku-5-5",
        blocks: [{ type: "text", text: "partial answer here" }],
        stopReason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 5 },
      });
      if (!("sse" in full)) throw new Error("unexpected fixture");
      return {
        status: 200,
        sse: [
          ...full.sse.slice(0, 4),
          {
            event: "error",
            data: JSON.stringify({
              type: "error",
              error: { type: "overloaded_error", message: "Overloaded" },
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
    expect(isModelError(err) && err.kind).toBe("overloaded");
  });

  it("abort mid-stream through the raw iterator -> aborted, no message_complete", async () => {
    next = () =>
      sseMessage({
        model: "claude-haiku-5-5",
        blocks: [{ type: "text", text: "a fairly long answer split into many deltas" }],
        stopReason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 5 },
      });
    const ac = new AbortController();
    const it = provider().stream(req(), { signal: ac.signal })[Symbol.asyncIterator]();
    const first = await it.next();
    expect(first.done).toBe(false);
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

  it("network failure -> network", async () => {
    const p = createAnthropicProvider({
      kv: memoryKv(),
      apiKey: "sk-ant-fixture",
      baseUrl: "http://127.0.0.1:1",
      models: ["claude-haiku-5-5"],
      serverFallbacks: "default",
    });
    const e = await streamError(p);
    expect(isModelError(e) && e.kind).toBe("network");
  });

  for (const [label, inputJson] of [
    ["missing colon", '{"a" 1}'],
    ["unquoted key", "{a:1}"],
    ["trailing comma", '{"a":1,}'],
    ["trailing comma in array", '{"a":[1,}'],
    ["extra closing brace", '{"a":1}}'],
    ["not JSON", "hello"],
    ["JSON array", "[1,2]"],
  ] as const) {
    it(`malformed (non-truncated) tool input JSON -> invalid_request: ${label}`, async () => {
      for (const model of ["claude-haiku-5-5", "claude-opus-5-5"]) {
        // claude-opus-5-5 走 beta 接口（服务端兜底），两条路径都要覆盖
        next = () =>
          sseMessage({
            model,
            blocks: [{ type: "tool_use", id: "toolu_x", name: "w", inputJson }],
            stopReason: "tool_use",
            usage: { input_tokens: 10, output_tokens: 5 },
          });
        const e = await streamError(provider(), req({ model }));
        expect(isModelError(e) && e.kind, `${model}: ${inputJson}`).toBe("invalid_request");
      }
    });
  }

  it("stream cut before message_stop -> network (retryable), not a partial message_complete", async () => {
    next = () => {
      const full = sseMessage({
        model: "claude-haiku-5-5",
        blocks: [{ type: "text", text: "partial answer" }],
        stopReason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 5 },
      });
      if (!("sse" in full)) throw new Error("unexpected fixture");
      return { status: 200, sse: full.sse.slice(0, 4) };
    };
    const e = await streamError(provider());
    expect(isModelError(e) && e.kind).toBe("network");
  });

  it("invalid tool input JSON -> invalid_request", async () => {
    next = () =>
      sseMessage({
        model: "claude-haiku-5-5",
        blocks: [{ type: "tool_use", id: "toolu_x", name: "w", inputJson: '{"city": "Par' }],
        stopReason: "tool_use",
        usage: { input_tokens: 10, output_tokens: 5 },
      });
    const e = await streamError(provider());
    expect(isModelError(e) && e.kind).toBe("invalid_request");
  });

  it("refusal / other stop reasons; thinking opaque; usage mapping", async () => {
    next = () =>
      sseMessage({
        model: "claude-haiku-5-5",
        blocks: [{ type: "thinking", thinking: "hmm", signature: "sig-1" }],
        stopReason: "refusal",
        usage: {
          input_tokens: 11,
          output_tokens: 2,
          cache_read_input_tokens: 3,
          cache_creation_input_tokens: 4,
        },
      });
    const events = await drain(provider(), req());
    expect(
      events
        .filter((e) => e.type === "thinking_delta")
        .map((e) => (e as { text: string }).text)
        .join(""),
    ).toBe("hmm");
    const done = events.at(-1);
    expect(done?.type).toBe("message_complete");
    if (done?.type !== "message_complete") return;
    expect(done.stopReason).toBe("refusal");
    expect(done.usage).toEqual({
      inputTokens: 11,
      outputTokens: 2,
      cacheReadTokens: 3,
      cacheWriteTokens: 4,
    });
    expect(done.content).toEqual([
      {
        type: "thinking",
        text: "hmm",
        opaque: {
          provider: "anthropic",
          model: "claude-haiku-5-5",
          data: { type: "thinking", thinking: "hmm", signature: "sig-1" },
        },
      },
    ]);

    next = () =>
      sseMessage({
        model: "claude-haiku-5-5",
        blocks: [{ type: "text", text: "x" }],
        stopReason: "pause_turn",
        usage: { input_tokens: 1, output_tokens: 1 },
      });
    const ev2 = await drain(provider(), req());
    const d2 = ev2.at(-1);
    expect(d2?.type === "message_complete" && d2.stopReason).toBe("other");
  });

  it("message_stop then the connection stays open -> stops reading and completes promptly", async () => {
    next = () => {
      const full = sseMessage({
        model: "claude-haiku-5-5",
        blocks: [{ type: "text", text: "done" }],
        stopReason: "end_turn",
        usage: { input_tokens: 3, output_tokens: 2 },
      });
      if (!("sse" in full)) throw new Error("unexpected fixture");
      return { ...full, keepOpen: true };
    };
    const t0 = Date.now();
    const events = await Promise.race([
      drain(provider(), req()),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("stream kept reading after message_stop")), 2_000),
      ),
    ]);
    expect(Date.now() - t0).toBeLessThan(2_000);
    const done = events.at(-1);
    expect(done?.type === "message_complete" && done.content).toEqual([
      { type: "text", text: "done" },
    ]);
  });

  it("listModels skips ids the Models API cannot return (warns) and keeps the rest", async () => {
    const warnings: { msg: string; meta?: Record<string, unknown> }[] = [];
    const p = createAnthropicProvider({
      kv: memoryKv(),
      apiKey: "sk-ant-fixture",
      baseUrl: server.url,
      models: ["claude-haiku-5-5", "claude-missing", "claude-sonnet-5"],
      serverFallbacks: "default",
      log: { warn: (msg, meta) => warnings.push({ msg, ...(meta ? { meta } : {}) }) },
    });
    const models = await p.listModels();
    expect(models.map((m) => m.id)).toEqual(["claude-haiku-5-5", "claude-sonnet-5"]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.meta).toMatchObject({ model: "claude-missing" });
  });

  const listWith = (ids: string[], fails: Record<string, () => FakeResponse>) => {
    modelFail.clear();
    for (const [k, v] of Object.entries(fails)) modelFail.set(k, v);
    const kv = memoryKv();
    const warnings: unknown[] = [];
    const p = createAnthropicProvider({
      kv,
      apiKey: "sk-ant-fixture",
      baseUrl: server.url,
      models: ids,
      serverFallbacks: "default",
      log: { warn: (...a) => warnings.push(a) },
    });
    return { p, kv, warnings };
  };

  it("listModels skips a 403 id (warns) and returns the others", async () => {
    const { p, warnings } = listWith(["claude-haiku-5-5", "claude-sonnet-5"], {
      "claude-sonnet-5": () => errorJson(403, "permission_error", "nope"),
    });
    expect((await p.listModels()).map((m) => m.id)).toEqual(["claude-haiku-5-5"]);
    expect(warnings).toHaveLength(1);
    modelFail.clear();
  });

  it.each([
    ["500", () => errorJson(500, "api_error", "Internal")],
    ["429", () => errorJson(429, "rate_limit_error", "Rate limited")],
  ])("listModels rejects with a retryable ModelError when one id fails with %s", async (_n, f) => {
    const { p, kv } = listWith(["claude-haiku-5-5", "claude-sonnet-5"], { "claude-sonnet-5": f });
    const err = await p.listModels().then(
      () => null,
      (e: unknown) => e,
    );
    expect(isModelError(err)).toBe(true);
    expect(isModelError(err) && err.retryable).toBe(true);
    // 成功的 id 仍写入 kv 缓存
    expect(kv.store.has("models:v2:claude-haiku-5-5")).toBe(true);
    modelFail.clear();
  });

  it("listModels rejects when every id fails non-retryably", async () => {
    const { p } = listWith(["claude-missing", "claude-missing-2"], {
      "claude-missing-2": () => errorJson(404, "not_found_error", "model not found"),
    });
    const err = await p.listModels().then(
      () => null,
      (e: unknown) => e,
    );
    expect(isModelError(err)).toBe(true);
    expect(isModelError(err) && err.retryable).toBe(false);
    modelFail.clear();
  });

  it("models without thinking / effort support: no parameters declared and requests omit thinking / effort", async () => {
    const id = `claude-${NO_THINKING}-1`;
    const p = createAnthropicProvider({
      kv: memoryKv(),
      apiKey: "sk-ant-fixture",
      baseUrl: server.url,
      models: [id],
      serverFallbacks: "default",
    });
    const [info] = await p.listModels();
    expect(info?.capabilities).toMatchObject({ reasoning: false });
    expect(info?.parameters).toEqual([]);
    next = () =>
      sseMessage({
        model: id,
        blocks: [{ type: "text", text: "ok" }],
        stopReason: "end_turn",
        usage: { input_tokens: 3, output_tokens: 2 },
      });
    const events = await drain(p, req({ model: id, params: { effort: "low", thinking: "on" } }));
    expect(events.at(-1)?.type).toBe("message_complete");
    const body = server.requests.at(-1)?.body as Record<string, unknown>;
    expect("thinking" in body).toBe(false);
    expect("output_config" in body).toBe(false);
  });

  it("provides model-provider@2", () => {
    expect(plugin.provides).toEqual([MODEL_PROVIDER_CAPABILITY_V2]);
  });

  it("effort tiers come from the Models API level flags (default high only when supported)", async () => {
    const id = `claude-${FEW_EFFORT_LEVELS}-1`;
    const p = createAnthropicProvider({
      kv: memoryKv(),
      apiKey: "sk-ant-fixture",
      baseUrl: server.url,
      models: [id],
      serverFallbacks: "default",
    });
    const [info] = await p.listModels();
    expect(info?.parameters.find((d) => d.key === "effort")).toMatchObject({
      schema: { type: "string", enum: ["low", "medium", "max"] },
    });
    expect(info?.parameters.find((d) => d.key === "effort")).not.toHaveProperty("default");
  });

  it("an explicitly null tier counts as per-level info: no five-tier fallback", async () => {
    const id = `claude-${NULL_EFFORT_LEVELS}-1`;
    const p = createAnthropicProvider({
      kv: memoryKv(),
      apiKey: "sk-ant-fixture",
      baseUrl: server.url,
      models: [id],
      serverFallbacks: "default",
    });
    const [info] = await p.listModels();
    // 有逐档信息但一档都不支持 → 不声明 effort
    expect(info?.parameters.map((d) => d.key)).toEqual(["thinking"]);
  });

  it("thinking on (display omitted): empty thinking text with a signature replays verbatim next turn", async () => {
    const p = provider();
    next = () =>
      sseMessage({
        model: "claude-haiku-5-5",
        blocks: [
          { type: "thinking", thinking: "", signature: "sig-omitted" },
          { type: "text", text: "391" },
        ],
        stopReason: "end_turn",
        usage: { input_tokens: 3, output_tokens: 2 },
      });
    const first = req({ params: { thinking: "on" } });
    const done = (await drain(p, first)).at(-1);
    if (done?.type !== "message_complete") throw new Error("no message_complete");
    expect(done.content[0]).toMatchObject({
      type: "thinking",
      text: "",
      opaque: { data: { type: "thinking", thinking: "", signature: "sig-omitted" } },
    });
    next = () =>
      sseMessage({
        model: "claude-haiku-5-5",
        blocks: [{ type: "text", text: "392" }],
        stopReason: "end_turn",
        usage: { input_tokens: 3, output_tokens: 2 },
      });
    await drain(
      p,
      req({
        params: { thinking: "on" },
        messages: [
          ...first.messages,
          { role: "assistant", content: done.content },
          { role: "user", content: [{ type: "text", text: "Add 1." }] },
        ],
      }),
    );
    const body = server.requests.at(-1)?.body as { messages: { content: unknown }[] };
    expect(body.messages[1]?.content).toEqual([
      { type: "thinking", thinking: "", signature: "sig-omitted" },
      { type: "text", text: "391" },
    ]);
  });

  it("params map to the native request: effort -> output_config, thinking on -> display omitted", async () => {
    const p = provider();
    const ok = () =>
      sseMessage({
        model: "claude-haiku-5-5",
        blocks: [{ type: "text", text: "ok" }],
        stopReason: "end_turn",
        usage: { input_tokens: 3, output_tokens: 2 },
      });
    next = ok;
    await drain(p, req({ params: { effort: "max", thinking: "on" } }));
    const body = server.requests.at(-1)?.body as Record<string, unknown>;
    expect(body.output_config).toEqual({ effort: "max" });
    expect(body.thinking).toEqual({ type: "adaptive", display: "omitted" });
    next = ok;
    await drain(p, req({ params: { thinking: "summarized" } }));
    const body2 = server.requests.at(-1)?.body as Record<string, unknown>;
    expect(body2.thinking).toEqual({ type: "adaptive", display: "summarized" });
    expect("output_config" in body2).toBe(false);
  });

  it("listModels maps the Models API and caches in kv (versioned key) with TTL 3600", async () => {
    const kv = memoryKv();
    const p = provider(kv);
    const before = server.requests.length;
    const models = await p.listModels();
    expect(models.map((m) => m.id)).toEqual(["claude-haiku-5-5", "claude-sonnet-5"]);
    expect(models[0]).toEqual({
      id: "claude-haiku-5-5",
      displayName: "claude-haiku-5-5",
      contextWindow: 1_000_000,
      maxOutputTokens: 128_000,
      capabilities: {
        tools: true,
        vision: true,
        reasoning: true,
        caching: true,
        midConversationSystem: false,
      },
      streamIdleTimeoutMs: 300_000,
      parameters: [
        {
          key: "effort",
          standard: "effort",
          schema: { type: "string", enum: ["low", "medium", "high", "xhigh", "max"] },
          default: "high",
          label: { zh: "思考深度", en: "Effort" },
          description: expect.any(Object),
        },
        {
          key: "thinking",
          standard: "thinking",
          schema: { type: "string", enum: ["on", "summarized"] },
          default: "summarized",
          label: { zh: "思考模式", en: "Thinking" },
          description: expect.any(Object),
        },
      ],
    });
    expect([...kv.store.keys()].sort()).toEqual([
      "models:v2:claude-haiku-5-5",
      "models:v2:claude-sonnet-5",
    ]);
    expect(models.every((m) => !m.capabilities.midConversationSystem)).toBe(true);
    expect(kv.ttls).toEqual([3600, 3600]);
    const afterFirst = server.requests.length;
    expect(afterFirst - before).toBe(2);
    await p.listModels();
    expect(server.requests.length).toBe(afterFirst);
  });
});
