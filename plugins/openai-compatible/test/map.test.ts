import {
  assertValidDeclarations,
  type ContentBlock,
  isModelError,
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
  model: { reasoning: true, maxOutputTokens: 8192 },
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

describe.each(["generic", "deepseek", "qwen", "ark"] as const)("buildRequest (%s)", (dialect) => {
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

  it('toolChoice none -> tool_choice "none" (tools still sent); auto / unset / no tools -> omitted', () => {
    const history = turns[0] ?? [];
    const none = buildRequest(
      req(history, { tools: [weather], toolChoice: "none" }),
      target(dialect),
    );
    expect(none.tool_choice).toBe("none");
    expect(none.tools).toHaveLength(1);
    const auto = buildRequest(
      req(history, { tools: [weather], toolChoice: "auto" }),
      target(dialect),
    );
    expect("tool_choice" in auto).toBe(false);
    expect("tool_choice" in buildRequest(req(history, { tools: [weather] }), target(dialect))).toBe(
      false,
    );
    expect(
      "tool_choice" in buildRequest(req(history, { toolChoice: "none" }), target(dialect)),
    ).toBe(false);
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

  it.each(["generic", "qwen", "ark"] as const)(
    "%s uses a [system] user message by default",
    (d) => {
      const body = buildRequest(req(msgs), target(d));
      expect(body.messages.at(-1)).toEqual({ role: "user", content: "[system] Be brief." });
    },
  );

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
  const assistants = (d: DialectName, over: Partial<ModelRequest> = {}, reasoning = true) =>
    buildRequest(
      req(history, over),
      target(d, { model: { reasoning, maxOutputTokens: 8192 } }),
    ).messages.filter((m) => m.role === "assistant") as unknown as Record<string, unknown>[];

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

  it("deepseek non-reasoning model (reasoning: false) with tools: no placeholder reasoning_content (thinking is disabled)", () => {
    const a = assistants("deepseek", { tools: [weather] }, false);
    expect(a[2]).not.toHaveProperty("reasoning_content");
  });

  it.each(["generic", "qwen", "ark"] as const)("%s never sends reasoning_content back", (d) => {
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
      target(d, { model: { reasoning, maxOutputTokens: 8192 } }),
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

  it("ark: thinking -> thinking.type (no default: the docs state none), no effort knob", () => {
    const d = decl("ark");
    expect(d.map((p) => p.key)).toEqual(["thinking", "temperature", "maxOutputTokens"]);
    expect(d.find((p) => p.key === "thinking")?.default).toBeUndefined();
    expect(bodyWith("ark", { thinking: "on" }).thinking).toEqual({ type: "enabled" });
    expect(bodyWith("ark", { thinking: "off" }).thinking).toEqual({ type: "disabled" });
    expect(bodyWith("ark", {})).not.toHaveProperty("thinking");
    expect(decl("ark", false).some((p) => p.key === "thinking")).toBe(false);
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

  it('deepseek non-reasoning model: sends thinking { type: "disabled" } (the API defaults to enabled)', () => {
    const b = bodyWith("deepseek", {}, false);
    expect(b.thinking).toEqual({ type: "disabled" });
    expect(b).not.toHaveProperty("reasoning_effort");
    // 未声明的旧键被 sanitizeParams 丢弃，仍是 disabled
    const stale = bodyWith("deepseek", { thinking: "on", effort: "max", temperature: 0.5 }, false);
    expect(stale.thinking).toEqual({ type: "disabled" });
    expect(stale).not.toHaveProperty("reasoning_effort");
    expect(stale.temperature).toBe(0.5);
  });

  it.each(["generic", "qwen", "ark"] as const)("%s non-reasoning model: no thinking field", (d) => {
    const b = bodyWith(d, {}, false);
    expect(b).not.toHaveProperty("thinking");
    expect(b).not.toHaveProperty("enable_thinking");
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

  it("ark: prompt_tokens minus prompt_tokens_details.cached_tokens, no cache write", () => {
    expect(
      DIALECTS.ark.usage({
        prompt_tokens: 100,
        completion_tokens: 7,
        total_tokens: 107,
        prompt_tokens_details: { cached_tokens: 60 },
      }),
    ).toEqual({ inputTokens: 40, outputTokens: 7, cacheReadTokens: 60, cacheWriteTokens: 0 });
  });

  it("ark: reads delta.reasoning_content", () => {
    expect(DIALECTS.ark.readDelta({ content: "a", reasoning_content: "b" })).toEqual({
      text: "a",
      reasoning: "b",
    });
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

describe("media blocks", () => {
  const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");
  const PNG = "iVBORw0KGgo=";
  const PDF = b64("%PDF-1.4 fake");
  const user = (...content: ContentBlock[]): ModelMessage => ({ role: "user", content });
  const image: ContentBlock = {
    type: "image",
    mediaType: "image/jpeg",
    name: "cat.jpg",
    source: { kind: "base64", data: PNG },
  };
  const pdf = (name?: string): ContentBlock => ({
    type: "document",
    mediaType: "application/pdf",
    ...(name !== undefined ? { name } : {}),
    source: { kind: "base64", data: PDF },
  });
  const errorOf = (f: () => unknown): unknown => {
    try {
      f();
    } catch (e) {
      return e;
    }
    return undefined;
  };

  it.each(["generic", "deepseek", "qwen", "ark"] as const)(
    "%s: image -> image_url content part with a data URL, in block order with the text",
    (dialect) => {
      const body = buildRequest(
        req([user({ type: "text", text: "Look:" }, image, { type: "text", text: "What is it?" })]),
        target(dialect),
      );
      expect(body.messages.at(-1)).toEqual({
        role: "user",
        content: [
          { type: "text", text: "Look:" },
          { type: "image_url", image_url: { url: `data:image/jpeg;base64,${PNG}` } },
          { type: "text", text: "What is it?" },
        ],
      });
    },
  );

  it("text-only user messages keep the plain string content", () => {
    const body = buildRequest(
      req([user({ type: "text", text: "a" }, { type: "text", text: "b" })]),
      target("generic"),
    );
    expect(body.messages.at(-1)).toEqual({ role: "user", content: "a\n\nb" });
  });

  it.each(["generic", "qwen"] as const)(
    "%s: PDF -> file content part (file_data data URL + .pdf filename)",
    (dialect) => {
      const body = buildRequest(
        req([user(pdf("report.pdf"), pdf("scan"), pdf())]),
        target(dialect),
      );
      const part = (filename: string) => ({
        type: "file",
        file: { filename, file_data: `data:application/pdf;base64,${PDF}` },
      });
      expect(body.messages.at(-1)).toEqual({
        role: "user",
        content: [part("report.pdf"), part("scan.pdf"), part("document.pdf")],
      });
    },
  );

  it.each(["deepseek", "ark"] as const)(
    "%s: a PDF reaching a dialect that cannot take PDFs is a non-retryable ModelError",
    (dialect) => {
      const err = errorOf(() => buildRequest(req([user(pdf("a.pdf"))]), target(dialect)));
      expect(isModelError(err) && err.kind).toBe("invalid_request");
      expect(isModelError(err) && err.retryable).toBe(false);
    },
  );

  it.each(["generic", "deepseek", "qwen", "ark"] as const)(
    "%s: text/* document -> text part labelled with the file name (decoded UTF-8)",
    (dialect) => {
      const body = buildRequest(
        req([
          user({
            type: "document",
            mediaType: "text/markdown",
            name: "notes.md",
            source: { kind: "base64", data: b64("# Héllo\n") },
          }),
        ]),
        target(dialect),
      );
      // 只有文本片段时仍是字符串内容（不收内容数组的服务也能用）
      expect(body.messages.at(-1)).toEqual({
        role: "user",
        content: '[Attached file "notes.md" (text/markdown)]\n# Héllo\n',
      });
    },
  );

  it("tool results still come first as role tool messages, media follow in the user message", () => {
    const body = buildRequest(
      req([user({ type: "tool_result", callId: "c1", content: "ok", isError: false }, image)]),
      target("generic"),
    );
    expect(body.messages.slice(-2)).toEqual([
      { role: "tool", tool_call_id: "c1", content: "ok" },
      {
        role: "user",
        content: [{ type: "image_url", image_url: { url: `data:image/jpeg;base64,${PNG}` } }],
      },
    ]);
  });

  it("a ref source reaching the plugin is a non-retryable ModelError", () => {
    const err = errorOf(() =>
      buildRequest(
        req([
          user({
            type: "image",
            mediaType: "image/png",
            source: { kind: "ref", attachmentId: "3f2b9a52-1c1e-4b7e-9d0a-2f7c1e0b6a11" },
          }),
        ]),
        target("generic"),
      ),
    );
    expect(isModelError(err) && err.kind).toBe("invalid_request");
    expect(isModelError(err) && err.retryable).toBe(false);
  });

  it("media blocks in assistant messages are never sent", () => {
    const body = buildRequest(
      req([
        user({ type: "text", text: "Hi" }),
        { role: "assistant", content: [{ type: "text", text: "Hello" }, image] },
      ]),
      target("generic"),
    );
    expect(JSON.stringify(body.messages.at(-1))).not.toContain("image");
  });

  it("an earlier request with media is an exact prefix of a later one", () => {
    const first = [user(image, { type: "text", text: "What is it?" })];
    const earlier = buildRequest(req(first), target("qwen")).messages;
    const later = buildRequest(
      req([
        ...first,
        { role: "assistant", content: [{ type: "text", text: "A cat." }] },
        user({ type: "text", text: "Thanks" }),
      ]),
      target("qwen"),
    ).messages;
    expect(later.slice(0, earlier.length)).toEqual(earlier);
  });
});
