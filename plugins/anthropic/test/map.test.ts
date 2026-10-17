import type { ModelRequest } from "@capybara-hq/plugin-sdk";
import { describe, expect, it } from "vitest";
import { buildRequest, supportsMidConversationSystem } from "../src/map-request.js";

const base = (over: Partial<ModelRequest> = {}): ModelRequest => ({
  model: "claude-opus-5-5",
  system: [{ text: "You are a concise assistant.", cache: false }],
  messages: [{ role: "user", content: [{ type: "text", text: "Hi" }] }],
  tools: [],
  maxOutputTokens: 2048,
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

  it("client tools carry eager_input_streaming: true and tool_choice is never set", () => {
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

describe("buildRequest: mid-conversation system", () => {
  const withSystem = (model: string): ModelRequest =>
    base({
      model,
      messages: [
        { role: "user", content: [{ type: "text", text: "Say hello." }] },
        { role: "system", content: "Keep it short." },
      ],
    });

  it("model whitelist", () => {
    for (const m of [
      "claude-opus-5-5",
      "claude-opus-5",
      "claude-opus-4-8",
      "claude-sonnet-5-5",
      "claude-haiku-5-5",
      "claude-fable-5",
      "claude-fable-5-1",
    ]) {
      expect(supportsMidConversationSystem(m), m).toBe(true);
    }
    for (const m of [
      "claude-sonnet-5",
      "claude-opus-4-7",
      "claude-haiku-4-5",
      "claude-sonnet-4-6",
    ]) {
      expect(supportsMidConversationSystem(m), m).toBe(false);
    }
  });

  it("supported model: native system message after a user message", () => {
    const { params } = build(withSystem("claude-opus-5-5"));
    expect(params.messages[1]).toEqual({ role: "system", content: "Keep it short." });
  });

  it("unsupported model: converted to a user text block prefixed with [system]", () => {
    const { params } = build(withSystem("claude-sonnet-5"));
    expect(params.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "Say hello." }] },
      { role: "user", content: [{ type: "text", text: "[system] Keep it short." }] },
    ]);
  });

  it("supported model: a system message followed by a user message moves after that user message", () => {
    const { params } = build(
      base({
        messages: [
          { role: "user", content: [{ type: "text", text: "Say hello." }] },
          { role: "assistant", content: [{ type: "text", text: "Hello." }] },
          { role: "system", content: "Reminder." },
          { role: "user", content: [{ type: "text", text: "Say goodbye." }] },
        ],
      }),
    );
    expect(params.messages.map((m) => m.role)).toEqual(["user", "assistant", "user", "system"]);
    expect(params.messages[3]).toEqual({ role: "system", content: "Reminder." });
  });

  it("supported model: a system message that cannot follow a user message falls back to [system] text", () => {
    const { params } = build(
      base({
        messages: [
          { role: "user", content: [{ type: "text", text: "Say hello." }] },
          { role: "assistant", content: [{ type: "text", text: "Hello." }] },
          { role: "system", content: "Reminder." },
        ],
      }),
    );
    expect(params.messages[2]).toEqual({
      role: "user",
      content: [{ type: "text", text: "[system] Reminder." }],
    });
  });
});

describe("buildRequest: thinking / effort / max_tokens", () => {
  it("adaptive thinking, never budget_tokens or disabled, effort in output_config", () => {
    const { params } = build(base({ effort: "low" }));
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
