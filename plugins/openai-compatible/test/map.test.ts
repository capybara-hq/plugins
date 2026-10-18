import {
  assertValidDeclarations,
  type ContentBlock,
  type ModelMessage,
  type ModelRequest,
  sanitizeParams,
} from "@capybara-hq/plugin-sdk";
import { describe, expect, it } from "vitest";
import { DIALECTS, type DialectName, PROVIDER } from "../src/dialects.js";
import { buildRequest, type ChatTarget } from "../src/map-request.js";

const MODEL = "ep/upstream-model";

const target = (dialect: DialectName, over: Partial<ChatTarget> = {}): ChatTarget => ({
  upstreamModel: "upstream-model",
  dialect: DIALECTS[dialect],
  midConversationSystem: DIALECTS[dialect].midConversationSystem,
  ...over,
});

const req = (messages: ModelMessage[], over: Partial<ModelRequest> = {}): ModelRequest => ({
  model: MODEL,
  system: [
    { text: "Stable system.", cache: true },
    { text: "Volatile part.", cache: false },
  ],
  messages,
  tools: [],
  maxOutputTokens: 1024,
  params: {},
  ...over,
});

const thinking = (text: string, model = MODEL, provider = PROVIDER): ContentBlock => ({
  type: "thinking",
  text,
  opaque: { provider, model, data: { field: "reasoning_content" } },
});

const weather = {
  name: "get_weather",
  description: "Get the weather.",
  inputSchema: { type: "object", properties: { city: { type: "string" } } },
};

/** 含思考、工具往返、中途 system 的多轮历史，逐轮增长。 */
const turns: ModelMessage[][] = [
  [{ role: "user", content: [{ type: "text", text: "Weather in Paris?" }] }],
  [
    {
      role: "assistant",
      content: [
        thinking("Need the tool."),
        { type: "text", text: "Let me check." },
        { type: "tool_call", id: "call_1", name: "get_weather", input: { city: "Paris" } },
      ],
    },
    {
      role: "user",
      content: [{ type: "tool_result", callId: "call_1", content: "Sunny", isError: false }],
    },
  ],
  [
    { role: "assistant", content: [thinking("Report it."), { type: "text", text: "Sunny." }] },
    { role: "system", content: "Reminder: be brief." },
    { role: "user", content: [{ type: "text", text: "And tomorrow?" }] },
  ],
  [
    {
      role: "assistant",
      content: [
        thinking("Other model thought.", "other/model"),
        thinking("Other provider thought.", MODEL, "anthropic"),
        { type: "text", text: "Probably rain." },
      ],
    },
    { role: "user", content: [{ type: "text", text: "Thanks." }] },
  ],
];

describe.each(["generic", "deepseek", "qwen"] as const)("buildRequest (%s)", (dialect) => {
  it("is append-only: each request's messages are a prefix of the next (thinking + tools)", () => {
    let history: ModelMessage[] = [];
    let prev: unknown[] | null = null;
    for (const t of turns) {
      history = [...history, ...t];
      const body = buildRequest(req(history, { tools: [weather] }), target(dialect));
      const msgs = JSON.parse(JSON.stringify(body.messages)) as unknown[];
      if (prev !== null) expect(msgs.slice(0, prev.length)).toEqual(prev);
      expect(msgs.length).toBeGreaterThan(prev?.length ?? 0);
      prev = msgs;
    }
  });

  it("maps system, upstream model, max_tokens, tools, and stream options", () => {
    const body = buildRequest(req(turns[0] ?? [], { tools: [weather] }), target(dialect));
    expect(body.model).toBe("upstream-model");
    expect(body.stream).toBe(true);
    expect(body.stream_options).toEqual({ include_usage: true });
    expect(body.max_tokens).toBe(1024);
    expect(body.messages[0]).toEqual({
      role: "system",
      content: "Stable system.\n\nVolatile part.",
    });
    expect(body.tools).toEqual([
      {
        type: "function",
        function: {
          name: "get_weather",
          description: "Get the weather.",
          parameters: weather.inputSchema,
        },
      },
    ]);
  });

  it("maps a tool round trip to assistant tool_calls + role tool", () => {
    const body = buildRequest(req([...(turns[0] ?? []), ...(turns[1] ?? [])]), target(dialect));
    const assistant = body.messages[2] as unknown as Record<string, unknown>;
    expect(assistant.role).toBe("assistant");
    expect(assistant.content).toBe("Let me check.");
    expect(assistant.tool_calls).toEqual([
      {
        id: "call_1",
        type: "function",
        function: { name: "get_weather", arguments: '{"city":"Paris"}' },
      },
    ]);
    expect(body.messages[3]).toEqual({ role: "tool", tool_call_id: "call_1", content: "Sunny" });
  });

  it("parameter declarations are valid for reasoning and non-reasoning models", () => {
    for (const reasoning of [true, false]) {
      expect(() =>
        assertValidDeclarations(
          PROVIDER,
          DIALECTS[dialect].parameters({ reasoning, maxOutputTokens: 8192 }),
        ),
      ).not.toThrow();
    }
  });
});

describe("mid-conversation system", () => {
  const msgs: ModelMessage[] = [
    { role: "user", content: [{ type: "text", text: "Hi" }] },
    { role: "assistant", content: [{ type: "text", text: "Hello." }] },
    { role: "system", content: "Be brief." },
  ];

  it("deepseek keeps role system in place", () => {
    const body = buildRequest(req(msgs), target("deepseek"));
    expect(body.messages.at(-1)).toEqual({ role: "system", content: "Be brief." });
  });

  it.each(["generic", "qwen"] as const)("%s uses a [system] user message by default", (d) => {
    const body = buildRequest(req(msgs), target(d));
    expect(body.messages.at(-1)).toEqual({ role: "user", content: "[system] Be brief." });
  });

  it("the endpoint can opt in to native mid-conversation system", () => {
    const body = buildRequest(req(msgs), target("generic", { midConversationSystem: true }));
    expect(body.messages.at(-1)).toEqual({ role: "system", content: "Be brief." });
  });
});

describe("thinking replay", () => {
  const history = [
    ...(turns[0] ?? []),
    ...(turns[1] ?? []),
    ...(turns[2] ?? []),
    ...(turns[3] ?? []),
  ];
  const assistants = (d: DialectName, over: Partial<ModelRequest> = {}) =>
    buildRequest(req(history, over), target(d)).messages.filter(
      (m) => m.role === "assistant",
    ) as unknown as Record<string, unknown>[];

  it("deepseek replays reasoning_content only for its own endpoint/model", () => {
    const a = assistants("deepseek");
    expect(a[0]?.reasoning_content).toBe("Need the tool.");
    expect(a[1]?.reasoning_content).toBe("Report it.");
    // 别的模型 / 别的供应商的思考块不回放
    expect(a[2]).not.toHaveProperty("reasoning_content");
    expect(a[2]?.content).toBe("Probably rain.");
  });

  it('deepseek with tools (thinking not off): turns without own reasoning send reasoning_content ""', () => {
    // DeepSeek 带 tools 的思考模式请求要求每个历史 assistant 回合都有 reasoning_content，否则 400
    for (const params of [{}, { thinking: "on" }]) {
      const a = assistants("deepseek", { tools: [weather], params });
      expect(a[0]?.reasoning_content).toBe("Need the tool.");
      expect(a[1]?.reasoning_content).toBe("Report it.");
      expect(a[2]?.reasoning_content).toBe("");
    }
  });

  it("deepseek with tools but thinking off: no placeholder reasoning_content", () => {
    const a = assistants("deepseek", { tools: [weather], params: { thinking: "off" } });
    expect(a[2]).not.toHaveProperty("reasoning_content");
  });

  it.each(["generic", "qwen"] as const)("%s never sends reasoning_content back", (d) => {
    for (const m of assistants(d)) expect(m).not.toHaveProperty("reasoning_content");
    for (const m of assistants(d, { tools: [weather] }))
      expect(m).not.toHaveProperty("reasoning_content");
  });
});

describe("dialect params", () => {
  const decl = (d: DialectName, reasoning = true) =>
    DIALECTS[d].parameters({ reasoning, maxOutputTokens: 8192 });
  const bodyWith = (d: DialectName, params: Record<string, unknown>, reasoning = true) =>
    buildRequest(
      req(turns[0] ?? [], { params: sanitizeParams(decl(d, reasoning), params).value }),
      target(d),
    ) as unknown as Record<string, unknown>;

  it("generic: only temperature and maxOutputTokens", () => {
    expect(decl("generic").map((p) => p.key)).toEqual(["temperature", "maxOutputTokens"]);
    const b = bodyWith("generic", { temperature: 0.3 });
    expect(b.temperature).toBe(0.3);
    expect(bodyWith("generic", {})).not.toHaveProperty("temperature");
  });

  it("qwen: thinking off -> enable_thinking false, on -> true, unset -> absent", () => {
    expect(decl("qwen").find((p) => p.key === "thinking")?.default).toBeUndefined();
    expect(bodyWith("qwen", { thinking: "off" }).enable_thinking).toBe(false);
    expect(bodyWith("qwen", { thinking: "on" }).enable_thinking).toBe(true);
    expect(bodyWith("qwen", {})).not.toHaveProperty("enable_thinking");
    // 非推理模型不声明 thinking
    expect(decl("qwen", false).some((p) => p.key === "thinking")).toBe(false);
  });

  it("deepseek: thinking -> thinking.type, effort -> reasoning_effort (defaults equal the API's)", () => {
    const d = decl("deepseek");
    expect(d.find((p) => p.key === "thinking")?.default).toBe("on");
    expect(d.find((p) => p.key === "effort")?.default).toBe("high");
    const on = bodyWith("deepseek", { effort: "max" });
    expect(on.thinking).toEqual({ type: "enabled" });
    expect(on.reasoning_effort).toBe("max");
    const off = bodyWith("deepseek", { thinking: "off", effort: "low" });
    expect(off.thinking).toEqual({ type: "disabled" });
    expect(off).not.toHaveProperty("reasoning_effort");
    expect(decl("deepseek", false).some((p) => p.key === "thinking" || p.key === "effort")).toBe(
      false,
    );
  });

  it("maxOutputTokens knob is bounded by the model limit (the kernel folds it into max_tokens)", () => {
    const p = decl("generic").find((x) => x.key === "maxOutputTokens");
    expect(p?.schema).toEqual({ type: "integer", minimum: 1, maximum: 8192 });
    expect(bodyWith("generic", { maxOutputTokens: 100 })).not.toHaveProperty("maxOutputTokens");
  });
});

describe("usage", () => {
  it("generic: prompt_tokens minus prompt_tokens_details.cached_tokens", () => {
    expect(
      DIALECTS.generic.usage({
        prompt_tokens: 100,
        completion_tokens: 7,
        total_tokens: 107,
        prompt_tokens_details: { cached_tokens: 60 },
      }),
    ).toEqual({ inputTokens: 40, outputTokens: 7, cacheReadTokens: 60, cacheWriteTokens: 0 });
  });

  it("deepseek: prompt_cache_hit_tokens is cacheRead, inputTokens = prompt_tokens - hit", () => {
    expect(
      DIALECTS.deepseek.usage({
        prompt_tokens: 100,
        completion_tokens: 7,
        total_tokens: 107,
        prompt_cache_hit_tokens: 64,
        prompt_cache_miss_tokens: 36,
      } as never),
    ).toEqual({ inputTokens: 36, outputTokens: 7, cacheReadTokens: 64, cacheWriteTokens: 0 });
  });

  it("qwen: cached_tokens is cacheRead, cache_creation_input_tokens is cacheWrite", () => {
    expect(
      DIALECTS.qwen.usage({
        prompt_tokens: 100,
        completion_tokens: 7,
        total_tokens: 107,
        prompt_tokens_details: { cached_tokens: 20, cache_creation_input_tokens: 30 } as never,
      }),
    ).toEqual({ inputTokens: 50, outputTokens: 7, cacheReadTokens: 20, cacheWriteTokens: 30 });
  });

  it("missing usage counts as zero", () => {
    expect(DIALECTS.generic.usage(undefined)).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
  });
});
