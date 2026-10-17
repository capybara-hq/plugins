import type { ModelMessage, ModelRequest } from "@capybara-hq/plugin-sdk";
import { isModelError } from "@capybara-hq/plugin-sdk";
import { describe, expect, it } from "vitest";
import { buildRequest, type ModelTraits } from "../src/map-request.js";
import { toComplete } from "../src/map-stream.js";

const base = (over: Partial<ModelRequest> = {}): ModelRequest => ({
  model: "gpt-5.5",
  system: [{ text: "You are a concise assistant.", cache: true }],
  messages: [{ role: "user", content: [{ type: "text", text: "Hi" }] }],
  tools: [],
  maxOutputTokens: 2048,
  ...over,
});

const REASONING: ModelTraits = { reasoning: true, reasoningSummary: "auto" };
const PLAIN: ModelTraits = { reasoning: false, reasoningSummary: "auto" };
const build = (req: ModelRequest, model: ModelTraits = REASONING) => buildRequest(req, model);

describe("buildRequest: fixed parameters", () => {
  it("store: false, include encrypted reasoning, max_output_tokens, system blocks -> instructions", () => {
    const params = build(
      base({
        system: [
          { text: "stable", cache: true },
          { text: "volatile", cache: false },
        ],
      }),
    );
    expect(params.store).toBe(false);
    expect(params.include).toEqual(["reasoning.encrypted_content"]);
    expect(params.max_output_tokens).toBe(2048);
    expect(params.model).toBe("gpt-5.5");
    expect(params.instructions).toBe("stable\n\nvolatile");
    expect(params.input).toEqual([{ role: "user", content: [{ type: "input_text", text: "Hi" }] }]);
    // 缓存是自动的：不发任何缓存标记
    expect(JSON.stringify(params)).not.toContain("cache_control");
  });

  it("no instructions when there is no system text", () => {
    expect("instructions" in build(base({ system: [] }))).toBe(false);
  });

  it("non-reasoning models: no reasoning params, no encrypted-content include", () => {
    const params = build(base({ effort: "high" }), PLAIN);
    expect(params.store).toBe(false);
    expect("reasoning" in params).toBe(false);
    expect("include" in params).toBe(false);
  });
});

describe("buildRequest: effort", () => {
  it("reasoning models carry reasoning.effort natively, including xhigh and max (R40)", () => {
    expect(build(base({ effort: "low" })).reasoning).toEqual({ effort: "low", summary: "auto" });
    for (const e of ["low", "medium", "high", "xhigh", "max"] as const) {
      expect(build(base({ effort: e })).reasoning?.effort, e).toBe(e);
    }
  });

  it("no effort given: summaries still requested, no effort field", () => {
    expect(build(base()).reasoning).toEqual({ summary: "auto" });
  });

  it('reasoningSummary: "off" omits reasoning.summary but keeps effort and the include', () => {
    const off = { reasoning: true, reasoningSummary: "off" as const };
    expect(build(base({ effort: "high" }), off).reasoning).toEqual({ effort: "high" });
    expect("reasoning" in build(base(), off)).toBe(false);
    expect(build(base(), off).include).toEqual(["reasoning.encrypted_content"]);
  });
});

describe("buildRequest: reasoning replay", () => {
  const raw = {
    id: "rs_1",
    type: "reasoning",
    summary: [{ type: "summary_text", text: "17*23=391" }],
    encrypted_content: "enc-abc",
  };
  const history = (provider: string, model: string, data: unknown = raw): ModelRequest =>
    base({
      messages: [
        { role: "user", content: [{ type: "text", text: "What is 17 * 23?" }] },
        {
          role: "assistant",
          content: [
            { type: "thinking", text: "17*23=391", opaque: { provider, model, data } },
            { type: "text", text: "391" },
          ],
        },
        { role: "user", content: [{ type: "text", text: "Now add 1." }] },
      ],
    });

  it("replays the raw reasoning item (with encrypted_content) unchanged for the same provider and model", () => {
    const { input } = build(history("openai", "gpt-5.5"));
    expect(input).toEqual([
      { role: "user", content: [{ type: "input_text", text: "What is 17 * 23?" }] },
      raw,
      { role: "assistant", content: [{ type: "output_text", text: "391" }] },
      { role: "user", content: [{ type: "input_text", text: "Now add 1." }] },
    ]);
    expect((input as unknown[])[1]).toBe(raw);
  });

  it("does not replay reasoning from another provider", () => {
    const { input } = build(history("anthropic", "gpt-5.5"));
    expect(JSON.stringify(input)).not.toContain("enc-abc");
    expect(input).toHaveLength(3);
  });

  it("does not replay reasoning from another model", () => {
    const { input } = build(history("openai", "gpt-5.4"));
    expect(JSON.stringify(input)).not.toContain("enc-abc");
  });

  it("drops thinking without opaque data", () => {
    const req = base({
      messages: [
        { role: "user", content: [{ type: "text", text: "q" }] },
        { role: "assistant", content: [{ type: "thinking", text: "hmm" }] },
      ],
    });
    expect(build(req).input).toHaveLength(1);
  });
});

describe("assistant message item ids (replayed after their reasoning item)", () => {
  const rs = {
    id: "rs_1",
    type: "reasoning",
    summary: [{ type: "summary_text", text: "17*23=391" }],
    encrypted_content: "enc-abc",
  };
  const msgOpaque = (model = "gpt-5.5", data: unknown = { id: "msg_1" }) => ({
    provider: "openai",
    model,
    data,
  });
  const turn = (content: ModelMessage["content"]): ModelRequest =>
    base({
      messages: [
        { role: "user", content: [{ type: "text", text: "q" }] },
        { role: "assistant", content } as ModelMessage,
      ],
    });

  it("toComplete keeps the message item id (and phase) in the text block's opaque", () => {
    const done = toComplete(
      {
        id: "resp_1",
        object: "response",
        created_at: 0,
        model: "gpt-5.5-2026-01-01",
        status: "completed",
        output: [
          rs,
          {
            id: "msg_1",
            type: "message",
            role: "assistant",
            status: "completed",
            phase: "final_answer",
            content: [{ type: "output_text", text: "391", annotations: [] }],
          },
        ],
        usage: null,
      } as never,
      "gpt-5.5",
    );
    expect(done.content[1]).toEqual({
      type: "text",
      text: "391",
      opaque: {
        provider: "openai",
        model: "gpt-5.5",
        data: { id: "msg_1", phase: "final_answer" },
      },
    });
  });

  it("after a replayed reasoning item (same model) the text is replayed as the original message item with its id", () => {
    const { input } = build(
      turn([
        { type: "thinking", text: "17*23=391", opaque: msgOpaque("gpt-5.5", rs) },
        {
          type: "text",
          text: "391",
          opaque: msgOpaque("gpt-5.5", { id: "msg_1", phase: "final_answer" }),
        },
      ]),
    );
    expect((input as unknown[]).slice(1)).toEqual([
      rs,
      {
        type: "message",
        id: "msg_1",
        role: "assistant",
        status: "completed",
        phase: "final_answer",
        content: [{ type: "output_text", text: "391", annotations: [] }],
      },
    ]);
  });

  it("without a replayed reasoning item before it (other model / no reasoning) the text carries no id", () => {
    const plain = { role: "assistant", content: [{ type: "output_text", text: "391" }] };
    const otherModel = build(
      turn([
        { type: "thinking", text: "x", opaque: msgOpaque("gpt-5.4", rs) },
        { type: "text", text: "391", opaque: msgOpaque("gpt-5.4") },
      ]),
    ).input as unknown[];
    expect(otherModel.slice(1)).toEqual([plain]);
    const noReasoning = build(turn([{ type: "text", text: "391", opaque: msgOpaque() }]))
      .input as unknown[];
    expect(noReasoning.slice(1)).toEqual([plain]);
  });

  it("append-only: the earlier input is an exact prefix of the later one", () => {
    const assistant: ModelMessage = {
      role: "assistant",
      content: [
        { type: "thinking", text: "t", opaque: msgOpaque("gpt-5.5", rs) },
        { type: "text", text: "391", opaque: msgOpaque() },
      ],
    };
    const u = (text: string): ModelMessage => ({ role: "user", content: [{ type: "text", text }] });
    const earlier = build(base({ messages: [u("q"), assistant] })).input as unknown[];
    const later = build(base({ messages: [u("q"), assistant, u("more")] })).input as unknown[];
    expect(later.slice(0, earlier.length)).toEqual(earlier);
  });
});

describe("buildRequest: tool calls and results", () => {
  const weather = {
    name: "get_weather",
    description: "Get the weather.",
    inputSchema: { type: "object", properties: { city: { type: "string" } } },
  };

  it("tool_call -> function_call, tool_result -> function_call_output", () => {
    const { input } = build(
      base({
        messages: [
          { role: "user", content: [{ type: "text", text: "weather?" }] },
          {
            role: "assistant",
            content: [{ type: "tool_call", id: "call_1", name: "w", input: { city: "Paris" } }],
          },
          {
            role: "user",
            content: [{ type: "tool_result", callId: "call_1", content: "Sunny", isError: false }],
          },
        ],
      }),
    );
    expect(input).toEqual([
      { role: "user", content: [{ type: "input_text", text: "weather?" }] },
      { type: "function_call", call_id: "call_1", name: "w", arguments: '{"city":"Paris"}' },
      { type: "function_call_output", call_id: "call_1", output: "Sunny" },
    ]);
  });

  it("function_call replays its item id only for the same provider and model", () => {
    const msg = (model: string): ModelRequest =>
      base({
        messages: [
          { role: "user", content: [{ type: "text", text: "q" }] },
          {
            role: "assistant",
            content: [
              {
                type: "tool_call",
                id: "call_1",
                name: "w",
                input: {},
                opaque: { provider: "openai", model, data: { id: "fc_1" } },
              },
            ],
          },
        ],
      });
    expect((build(msg("gpt-5.5")).input as unknown[])[1]).toEqual({
      type: "function_call",
      id: "fc_1",
      call_id: "call_1",
      name: "w",
      arguments: "{}",
    });
    expect((build(msg("gpt-5.4")).input as unknown[])[1]).toEqual({
      type: "function_call",
      call_id: "call_1",
      name: "w",
      arguments: "{}",
    });
  });

  it("text and tool results in one user message keep their order", () => {
    const { input } = build(
      base({
        messages: [
          {
            role: "user",
            content: [
              { type: "tool_result", callId: "c1", content: "r1", isError: false },
              { type: "text", text: "and then" },
              { type: "tool_result", callId: "c2", content: "r2", isError: true },
            ],
          },
        ],
      }),
    );
    expect(input).toEqual([
      { type: "function_call_output", call_id: "c1", output: "r1" },
      { role: "user", content: [{ type: "input_text", text: "and then" }] },
      { type: "function_call_output", call_id: "c2", output: "r2" },
    ]);
  });

  it("tools map to function tools (non-strict); omitted when there are none", () => {
    expect(build(base({ tools: [weather] })).tools).toEqual([
      {
        type: "function",
        name: "get_weather",
        description: "Get the weather.",
        parameters: { type: "object", properties: { city: { type: "string" } } },
        strict: false,
      },
    ]);
    expect("tools" in build(base())).toBe(false);
  });
});

describe("buildRequest: mid-conversation system -> developer item at its position (append-only)", () => {
  const u = (text: string): ModelMessage => ({ role: "user", content: [{ type: "text", text }] });
  const a = (text: string): ModelMessage => ({
    role: "assistant",
    content: [{ type: "text", text }],
  });
  const r: ModelMessage = { role: "system", content: "Reminder." };
  const dev = { role: "developer", content: [{ type: "input_text", text: "Reminder." }] };
  const input = (messages: ModelMessage[]) => build(base({ messages })).input as unknown[];

  it("system message becomes a developer item exactly where it was", () => {
    expect(input([u("U1"), a("A1"), r, u("U2")])).toEqual([
      { role: "user", content: [{ type: "input_text", text: "U1" }] },
      { role: "assistant", content: [{ type: "output_text", text: "A1" }] },
      dev,
      { role: "user", content: [{ type: "input_text", text: "U2" }] },
    ]);
    expect(JSON.stringify(input([u("U1"), r]))).not.toContain('"role":"system"');
  });

  for (const [label, earlierMsgs, laterMsgs] of [
    ["[U1, R] -> [U1, R, U2, A2]", [u("U1"), r], [u("U1"), r, u("U2"), a("A2")]],
    ["[U1, A1, R] -> [U1, A1, R, U2]", [u("U1"), a("A1"), r], [u("U1"), a("A1"), r, u("U2")]],
    ["[R, U1] -> [R, U1, A1, R, U2]", [r, u("U1")], [r, u("U1"), a("A1"), r, u("U2")]],
  ] as const) {
    it(`earlier input is an exact prefix of the later one: ${label}`, () => {
      const earlier = input([...earlierMsgs]);
      const later = input([...laterMsgs]);
      expect(later.slice(0, earlier.length)).toEqual(earlier);
      expect(JSON.stringify(later).startsWith(JSON.stringify(earlier).slice(0, -1))).toBe(true);
    });
  }
});

describe("buildRequest: tool_call input that cannot be serialized", () => {
  it("throws invalid_request", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    let err: unknown;
    try {
      build(
        base({
          messages: [
            { role: "user", content: [{ type: "text", text: "q" }] },
            {
              role: "assistant",
              content: [{ type: "tool_call", id: "c", name: "w", input: cyclic }],
            },
          ],
        }),
      );
    } catch (e) {
      err = e;
    }
    expect(isModelError(err) && err.kind).toBe("invalid_request");
  });
});
