import type { ModelMessage, ModelRequest } from "@capybara-hq/plugin-sdk";
import { describe, expect, it } from "vitest";
import { buildRequest } from "../src/map-request.js";

const base = (over: Partial<ModelRequest> = {}): ModelRequest => ({
  model: "claude-opus-5-5",
  system: [{ text: "You are a concise assistant.", cache: false }],
  messages: [{ role: "user", content: [{ type: "text", text: "Hi" }] }],
  tools: [],
  maxOutputTokens: 2048,
  params: {},
  ...over,
});

const build = (req: ModelRequest, serverFallbacks: "default" | "off" = "default") =>
  buildRequest(req, { serverFallbacks });

describe("buildRequest: system", () => {
  it("system block with cache: true carries cache_control; cache: false does not", () => {
    const { params } = build(
      base({
        system: [
          { text: "stable", cache: true },
          { text: "volatile", cache: false },
        ],
      }),
    );
    expect(params.system).toEqual([
      { type: "text", text: "stable", cache_control: { type: "ephemeral" } },
      { type: "text", text: "volatile" },
    ]);
  });
});

describe("buildRequest: history caching (top-level automatic cache_control)", () => {
  const u = (text: string): ModelMessage => ({ role: "user", content: [{ type: "text", text }] });
  const a = (text: string): ModelMessage => ({
    role: "assistant",
    content: [{ type: "text", text }],
  });

  it("sets top-level cache_control so the last cacheable block is a breakpoint; message blocks stay unmarked", () => {
    const { params } = build(base({ messages: [u("U1"), a("A1"), u("U2")] }));
    expect(params.cache_control).toEqual({ type: "ephemeral" });
    expect(JSON.stringify(params.messages)).not.toContain("cache_control");
  });

  it("the earlier request's messages are still an exact prefix of the later request's", () => {
    const earlier = build(base({ messages: [u("U1"), a("A1"), u("U2")] })).params;
    const later = build(base({ messages: [u("U1"), a("A1"), u("U2"), a("A2"), u("U3")] })).params;
    expect(later.messages.slice(0, earlier.messages.length)).toEqual(earlier.messages);
    expect(later.cache_control).toEqual(earlier.cache_control);
  });

  it("respects the 4-breakpoint limit: omitted when the system blocks already use 4", () => {
    const four = Array.from({ length: 4 }, (_, i) => ({ text: `s${i}`, cache: true }));
    expect("cache_control" in build(base({ system: four })).params).toBe(false);
    const three = four.slice(0, 3);
    expect(build(base({ system: three })).params.cache_control).toEqual({ type: "ephemeral" });
  });
});

describe("buildRequest: thinking only when the model supports it", () => {
  it("thinking: false omits the thinking parameter (and never sends disabled)", () => {
    const { params } = buildRequest(base(), { serverFallbacks: "default", thinking: false });
    expect("thinking" in params).toBe(false);
    expect(JSON.stringify(params)).not.toContain('"disabled"');
  });

  it("thinking defaults to adaptive / summarized", () => {
    expect(build(base()).params.thinking).toEqual({ type: "adaptive", display: "summarized" });
  });

  it("params.thinking: on -> display omitted; summarized -> display summarized", () => {
    expect(build(base({ params: { thinking: "on" } })).params.thinking).toEqual({
      type: "adaptive",
      display: "omitted",
    });
    expect(build(base({ params: { thinking: "summarized" } })).params.thinking).toEqual({
      type: "adaptive",
      display: "summarized",
    });
  });

  it("thinking: false ignores params.thinking", () => {
    const { params } = buildRequest(base({ params: { thinking: "on" } }), {
      serverFallbacks: "default",
      thinking: false,
    });
    expect("thinking" in params).toBe(false);
  });
});

describe("buildRequest: thinking replay", () => {
  const raw = { type: "thinking", thinking: "17*23=391", signature: "sig-abc" };
  const history = (provider: string, model: string): ModelRequest =>
    base({
      messages: [
        { role: "user", content: [{ type: "text", text: "What is 17 * 23?" }] },
        {
          role: "assistant",
          content: [
            { type: "thinking", text: "17*23=391", opaque: { provider, model, data: raw } },
            { type: "text", text: "391" },
          ],
        },
        { role: "user", content: [{ type: "text", text: "Now add 1." }] },
      ],
    });

  it("replays the raw block (with signature) unchanged for the same provider and model", () => {
    const { params } = build(history("anthropic", "claude-opus-5-5"));
    expect(params.messages[1]).toEqual({
      role: "assistant",
      content: [raw, { type: "text", text: "391" }],
    });
  });

  it("drops thinking produced by another model", () => {
    const { params } = build(history("anthropic", "claude-sonnet-5-5"));
    expect(params.messages[1]).toEqual({
      role: "assistant",
      content: [{ type: "text", text: "391" }],
    });
  });

  it("drops thinking produced by another provider", () => {
    const { params } = build(history("openai", "claude-opus-5-5"));
    expect(params.messages[1]?.content).toEqual([{ type: "text", text: "391" }]);
  });

  it("drops thinking without opaque data", () => {
    const req = base({
      messages: [
        { role: "user", content: [{ type: "text", text: "q" }] },
        {
          role: "assistant",
          content: [
            { type: "thinking", text: "hmm" },
            { type: "text", text: "a" },
          ],
        },
        { role: "user", content: [{ type: "text", text: "q2" }] },
      ],
    });
    expect(build(req).params.messages[1]?.content).toEqual([{ type: "text", text: "a" }]);
  });
});

describe("buildRequest: tool calls and results", () => {
  it("maps tool_call to tool_use and tool_result to tool_result", () => {
    const { params } = build(
      base({
        messages: [
          { role: "user", content: [{ type: "text", text: "weather?" }] },
          {
            role: "assistant",
            content: [{ type: "tool_call", id: "toolu_1", name: "w", input: { city: "Paris" } }],
          },
          {
            role: "user",
            content: [{ type: "tool_result", callId: "toolu_1", content: "Sunny", isError: false }],
          },
        ],
      }),
    );
    expect(params.messages[1]).toEqual({
      role: "assistant",
      content: [{ type: "tool_use", id: "toolu_1", name: "w", input: { city: "Paris" } }],
    });
    expect(params.messages[2]).toEqual({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "Sunny", is_error: false }],
    });
  });

  it("toolChoice none -> tool_choice {type: none} (tools still sent); auto / unset -> no tool_choice", () => {
    const tools = [{ name: "get_weather", description: "d", inputSchema: { type: "object" } }];
    const none = build(base({ tools, toolChoice: "none" })).params;
    expect(none.tool_choice).toEqual({ type: "none" });
    expect(none.tools).toHaveLength(1);
    expect("tool_choice" in build(base({ tools, toolChoice: "auto" })).params).toBe(false);
    // 没有工具时不发 tool_choice
    expect("tool_choice" in build(base({ toolChoice: "none" })).params).toBe(false);
  });

  it("client tools carry eager_input_streaming: true and tool_choice is unset by default", () => {
    const { params } = build(
      base({
        tools: [
          {
            name: "get_weather",
            description: "Get the weather.",
            inputSchema: { type: "object", properties: { city: { type: "string" } } },
          },
        ],
      }),
    );
    expect(params.tools).toEqual([
      {
        name: "get_weather",
        description: "Get the weather.",
        input_schema: { type: "object", properties: { city: { type: "string" } } },
        eager_input_streaming: true,
      },
    ]);
    expect("tool_choice" in params).toBe(false);
  });

  it("omits tools when there are none", () => {
    expect("tools" in build(base()).params).toBe(false);
  });
});

describe("buildRequest: mid-conversation system (R38: always [system] user text, no reordering)", () => {
  const u = (text: string): ModelMessage => ({ role: "user", content: [{ type: "text", text }] });
  const a = (text: string): ModelMessage => ({
    role: "assistant",
    content: [{ type: "text", text }],
  });
  const r: ModelMessage = { role: "system", content: "Reminder." };
  const rText = { role: "user", content: [{ type: "text", text: "[system] Reminder." }] };
  const msgs = (messages: ModelMessage[], model = "claude-opus-5-5") =>
    build(base({ model, messages })).params.messages;

  it("every system message becomes a user text block at its own position, for every model", () => {
    for (const model of ["claude-opus-5-5", "claude-sonnet-5", "claude-haiku-5-5"]) {
      expect(msgs([u("U1"), a("A1"), r, u("U2")], model), model).toEqual([
        { role: "user", content: [{ type: "text", text: "U1" }] },
        { role: "assistant", content: [{ type: "text", text: "A1" }] },
        rText,
        { role: "user", content: [{ type: "text", text: "U2" }] },
      ]);
    }
    expect(JSON.stringify(msgs([u("U1"), r]))).not.toContain('"role":"system"');
  });

  it("[U1, R] -> later [U1, R, U2, ...]: the earlier request is an exact prefix of the later one", () => {
    const earlier = msgs([u("U1"), r]);
    const later = msgs([u("U1"), r, u("U2"), a("A2")]);
    expect(later.slice(0, earlier.length)).toEqual(earlier);
  });

  it("[U1, A1, R] -> later [U1, A1, R, U2]: the earlier request is an exact prefix of the later one", () => {
    const earlier = msgs([u("U1"), a("A1"), r]);
    const later = msgs([u("U1"), a("A1"), r, u("U2")]);
    expect(earlier.at(-1)).toEqual(rText);
    expect(later.slice(0, earlier.length)).toEqual(earlier);
  });

  it("repeated reminders keep their positions", () => {
    const earlier = msgs([u("U1"), r]);
    const later = msgs([u("U1"), r, u("U2"), r]);
    expect(later.slice(0, earlier.length)).toEqual(earlier);
    expect(later.map((m) => m.role)).toEqual(["user", "user", "user", "user"]);
  });
});

describe("buildRequest: thinking / effort / max_tokens", () => {
  it("adaptive thinking, never budget_tokens or disabled, effort in output_config", () => {
    const { params } = build(base({ params: { effort: "low" } }));
    expect(params.thinking).toEqual({ type: "adaptive", display: "summarized" });
    expect(params.output_config).toEqual({ effort: "low" });
    expect(params.max_tokens).toBe(2048);
    const json = JSON.stringify(params);
    expect(json).not.toContain("budget_tokens");
    expect(json).not.toContain('"disabled"');
    expect(json).not.toContain("tool_choice");
  });

  it("no output_config when effort is not given", () => {
    expect("output_config" in build(base()).params).toBe(false);
  });
});

describe("buildRequest: server-side fallbacks", () => {
  it("whitelisted models use the beta endpoint with fallbacks: default", () => {
    for (const m of ["claude-opus-5-5", "claude-opus-5", "claude-fable-5-1", "claude-sonnet-5-5"]) {
      const { beta } = build(base({ model: m }));
      expect(beta, m).toEqual({ betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" });
    }
  });

  it("other models never send fallbacks or the beta", () => {
    for (const m of ["claude-haiku-5-5", "claude-sonnet-5", "claude-fable-5", "claude-opus-4-8"]) {
      const out = build(base({ model: m }));
      expect(out.beta, m).toBeNull();
      expect(JSON.stringify(out)).not.toContain("fallback");
    }
  });

  it("serverFallbacks: off disables it for whitelisted models", () => {
    expect(build(base({ model: "claude-opus-5-5" }), "off").beta).toBeNull();
  });
});
