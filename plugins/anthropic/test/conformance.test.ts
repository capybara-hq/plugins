import {
  isModelError,
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
import { createAnthropicProvider, type Kv } from "../src/index.js";
import { buildRequest } from "../src/map-request.js";
import { anthropicRoutes, errorJson, modelObject, sseMessage } from "./fixtures.js";

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
describe.skipIf(!LIVE_KEY)("live", () => {
  describeModelProviderConformance("anthropic (live, claude-haiku-5-5)", async () => ({
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

// ---- 错误映射与边界 ----
const req = (over: Partial<ModelRequest> = {}): ModelRequest => ({
  model: "claude-haiku-5-5",
  system: [{ text: "Be brief.", cache: false }],
  messages: [{ role: "user", content: [{ type: "text", text: "Hi" }] }],
  tools: [],
  maxOutputTokens: 256,
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

  it("listModels maps the Models API and caches in kv with TTL 3600", async () => {
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
        effort: true,
      },
      streamIdleTimeoutMs: 300_000,
    });
    expect(models.every((m) => !m.capabilities.midConversationSystem)).toBe(true);
    expect(kv.ttls).toEqual([3600, 3600]);
    const afterFirst = server.requests.length;
    expect(afterFirst - before).toBe(2);
    await p.listModels();
    expect(server.requests.length).toBe(afterFirst);
  });
});
