import {
  type ContentBlock,
  isModelError,
  type ModelMessage,
  type ModelRequest,
} from "@capybara-hq/plugin-sdk";
import { describe, expect, it } from "vitest";
import { buildRequest } from "../src/map-request.js";

const MODEL = "deepseek-flash";

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

const thinking = (text: string, model = MODEL, provider = "deepseek"): ContentBlock => ({
  type: "thinking",
  text,
  opaque: { provider, model, data: { field: "reasoning_content" } },
});

const weather = {
  name: "get_weather",
  description: "Get the weather.",
  inputSchema: { type: "object", properties: { city: { type: "string" } } },
};

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
        thinking("Other model thought.", "other-model"),
        thinking("Other provider thought.", MODEL, "anthropic"),
        { type: "text", text: "Probably rain." },
      ],
    },
    { role: "user", content: [{ type: "text", text: "Thanks." }] },
  ],
];

describe("deepseek buildRequest", () => {
  it("is append-only: each request's messages are a prefix of the next", () => {
    let history: ModelMessage[] = [];
    let prev: unknown[] | null = null;
    for (const t of turns) {
      history = [...history, ...t];
      const body = buildRequest(req(history, { tools: [weather] }));
      const msgs = JSON.parse(JSON.stringify(body.messages)) as unknown[];
      if (prev !== null) expect(msgs.slice(0, prev.length)).toEqual(prev);
      expect(msgs.length).toBeGreaterThan(prev?.length ?? 0);
      prev = msgs;
    }
  });

  it("maps system, model, max_tokens, tools and stream options", () => {
    const body = buildRequest(req(turns[0] ?? [], { tools: [weather] }));
    expect(body.model).toBe(MODEL);
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

  it("mid-conversation system turns are [system] user turns", () => {
    const body = buildRequest(req(turns.flat().slice(0, 7)));
    expect(body.messages).toContainEqual({ role: "user", content: "[system] Reminder: be brief." });
    expect(body.messages.some((m, i) => m.role === "system" && i > 0)).toBe(false);
  });

  it("maps thinking and effort; effort is omitted when thinking is off", () => {
    const h = turns[0] ?? [];
    const on = buildRequest(req(h, { params: { thinking: "on", effort: "max" } }));
    expect(on.thinking).toEqual({ type: "enabled" });
    expect(on.reasoning_effort).toBe("max");
    const off = buildRequest(
      req(h, { params: { thinking: "off", effort: "max", temperature: 0.3 } }),
    );
    expect(off.thinking).toEqual({ type: "disabled" });
    expect("reasoning_effort" in off).toBe(false);
    expect(off.temperature).toBe(0.3);
    const none = buildRequest(req(h));
    expect("thinking" in none).toBe(false);
    expect("reasoning_effort" in none).toBe(false);
  });

  it('toolChoice none -> "none"; auto / unset / no tools -> omitted', () => {
    const h = turns[0] ?? [];
    expect(buildRequest(req(h, { tools: [weather], toolChoice: "none" })).tool_choice).toBe("none");
    expect("tool_choice" in buildRequest(req(h, { tools: [weather], toolChoice: "auto" }))).toBe(
      false,
    );
    expect("tool_choice" in buildRequest(req(h, { toolChoice: "none" }))).toBe(false);
  });

  it("a forced tool choice in thinking mode -> invalid_request; allowed with thinking off", () => {
    const h = turns[0] ?? [];
    const forced = { tools: [weather], toolChoice: "required" } as unknown as Partial<ModelRequest>;
    for (const params of [{}, { thinking: "on" }]) {
      try {
        buildRequest(req(h, { ...forced, params }));
        expect.unreachable();
      } catch (e) {
        expect(isModelError(e) && e.kind).toBe("invalid_request");
        expect((e as Error).message).toBe(
          "DeepSeek does not allow a forced tool choice in thinking mode",
        );
      }
    }
    expect(buildRequest(req(h, { ...forced, params: { thinking: "off" } })).tool_choice).toBe(
      "required",
    );
  });

  describe("replay", () => {
    it("own thinking becomes reasoning_content; other models' and providers' is dropped", () => {
      const body = buildRequest(req(turns.flat(), { params: { thinking: "off" } }));
      const assistants = body.messages.filter((m) => m.role === "assistant");
      expect(assistants[0]).toMatchObject({ reasoning_content: "Need the tool." });
      expect(assistants[1]).toMatchObject({ reasoning_content: "Report it." });
      // thinking off: no placeholder for the turn that has no own thinking
      expect("reasoning_content" in (assistants[2] ?? {})).toBe(false);
    });

    it("with tools and thinking not off every assistant turn carries reasoning_content", () => {
      const body = buildRequest(req(turns.flat(), { tools: [weather] }));
      const assistants = body.messages.filter((m) => m.role === "assistant");
      expect(
        assistants.map((m) => (m as { reasoning_content?: string }).reasoning_content),
      ).toEqual(["Need the tool.", "Report it.", ""]);
    });

    it("without tools no placeholder is added", () => {
      const body = buildRequest(req(turns.flat()));
      const last = body.messages.filter((m) => m.role === "assistant").at(-1);
      expect("reasoning_content" in (last ?? {})).toBe(false);
    });
  });

  it("maps a tool round trip to assistant tool_calls + role tool", () => {
    const body = buildRequest(req(turns.slice(0, 2).flat(), { tools: [weather] }));
    expect(body.messages[2]).toMatchObject({
      role: "assistant",
      content: "Let me check.",
      tool_calls: [
        {
          id: "call_1",
          type: "function",
          function: { name: "get_weather", arguments: '{"city":"Paris"}' },
        },
      ],
    });
    expect(body.messages[3]).toEqual({ role: "tool", tool_call_id: "call_1", content: "Sunny" });
  });

  it("maps images to data-URL image_url parts and refuses documents", () => {
    const image: ContentBlock = {
      type: "image",
      mediaType: "image/png",
      source: { kind: "base64", data: "AAAA" },
    };
    const body = buildRequest(
      req([{ role: "user", content: [{ type: "text", text: "What colour?" }, image] }]),
    );
    expect(body.messages[1]).toEqual({
      role: "user",
      content: [
        { type: "text", text: "What colour?" },
        { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
      ],
    });
    const doc: ContentBlock = {
      type: "document",
      mediaType: "application/pdf",
      source: { kind: "base64", data: "AAAA" },
    };
    expect(() => buildRequest(req([{ role: "user", content: [doc] }]))).toThrow(/documents/);
  });
});
