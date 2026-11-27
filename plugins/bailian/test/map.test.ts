import { isModelError, type ModelMessage, type ModelRequest } from "@capybara-hq/plugin-sdk";
import { describe, expect, it } from "vitest";
import { buildRequest, type NativeMessage } from "../src/map-request.js";

const req = (over: Partial<ModelRequest> = {}): ModelRequest => ({
  model: "qwen-flash",
  system: [{ text: "You are concise.", cache: true }],
  messages: [{ role: "user", content: [{ type: "text", text: "Hi" }] }],
  tools: [],
  maxOutputTokens: 1024,
  params: {},
  ...over,
});

const MARK = { cache_control: { type: "ephemeral" } };

/**
 * The history without its moving cache marker: the last message's marker leaves it on the next
 * turn, and a string content that carried it as one text part goes back to a string.
 */
function unmarked(messages: NativeMessage[]): unknown[] {
  return messages.map((m, i) => {
    if (i === 0 && m.role === "system") return m;
    if (typeof m.content === "string") return m;
    const marked = m.content.some((p) => "cache_control" in p);
    const parts = m.content.map((p) => {
      const { cache_control: _, ...rest } = p as { cache_control?: unknown };
      return rest;
    });
    const only = parts[0] as { type?: string; text?: string } | undefined;
    // a string content (text-generation, or a tool result) took the marker as one text part
    const wasString = only?.type === "text" || m.role === "tool";
    if (marked && parts.length === 1 && wasString && typeof only?.text === "string") {
      return { ...m, content: only.text };
    }
    return { ...m, content: parts };
  });
}

const weather = {
  name: "get_weather",
  description: "Get the weather",
  inputSchema: { type: "object", properties: { city: { type: "string" } } },
};

const history: ModelMessage[] = [
  { role: "user", content: [{ type: "text", text: "Weather in Paris?" }] },
  {
    role: "assistant",
    content: [
      {
        type: "thinking",
        text: "I should call the tool.",
        opaque: { provider: "bailian", model: "qwen-flash", data: { field: "reasoning_content" } },
      },
      { type: "text", text: "Checking." },
      { type: "tool_call", id: "call_1", name: "get_weather", input: { city: "Paris" } },
    ],
  },
  {
    role: "user",
    content: [{ type: "tool_result", callId: "call_1", content: "Sunny", isError: false }],
  },
  { role: "system", content: "Keep it short." },
  {
    role: "assistant",
    content: [
      {
        type: "thinking",
        text: "Other model's thoughts.",
        opaque: { provider: "bailian", model: "qwen-plus", data: { field: "reasoning_content" } },
      },
      { type: "text", text: "It is sunny." },
    ],
  },
  {
    role: "user",
    content: [
      { type: "text", text: "Thanks" },
      { type: "text", text: "Bye" },
    ],
  },
];

describe("buildRequest (text-generation)", () => {
  it("maps the native body", () => {
    const body = buildRequest(
      req({ messages: history, tools: [weather], params: { thinking: "on", temperature: 0.5 } }),
      "text",
    );
    expect(body.model).toBe("qwen-flash");
    expect(body.parameters).toEqual({
      result_format: "message",
      incremental_output: true,
      max_tokens: 1024,
      tools: [
        {
          type: "function",
          function: {
            name: "get_weather",
            description: "Get the weather",
            parameters: weather.inputSchema,
          },
        },
      ],
      enable_thinking: true,
      preserve_thinking: true,
      temperature: 0.5,
    });
    expect(body.input.messages).toEqual([
      {
        role: "system",
        content: [{ type: "text", text: "You are concise.", cache_control: { type: "ephemeral" } }],
      },
      { role: "user", content: "Weather in Paris?" },
      {
        role: "assistant",
        content: "Checking.",
        reasoning_content: "I should call the tool.",
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "get_weather", arguments: '{"city":"Paris"}' },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_1", content: "Sunny" },
      { role: "user", content: "[system] Keep it short." },
      // another model's thinking is dropped whole
      { role: "assistant", content: "It is sunny." },
      // the history cache marker on the last block
      { role: "user", content: [{ type: "text", text: "Thanks\n\nBye", ...MARK }] },
    ]);
  });

  it("marks the last block of a tool result turn", () => {
    const body = buildRequest(req({ messages: history.slice(0, 3), tools: [weather] }), "text");
    expect(body.input.messages.at(-1)).toEqual({
      role: "tool",
      tool_call_id: "call_1",
      content: [{ type: "text", text: "Sunny", ...MARK }],
    });
    // the earlier messages carry no marker
    expect(JSON.stringify(body.input.messages.slice(1, -1))).not.toContain("cache_control");
  });

  it("uses at most two markers: the system prompt and the history tail", () => {
    const body = buildRequest(req({ messages: history, tools: [weather] }), "text");
    expect(JSON.stringify(body).split("cache_control").length - 1).toBe(2);
  });

  it("marks the history tail without a system prompt", () => {
    const body = buildRequest(req({ system: [] }), "text");
    expect(body.input.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "Hi", ...MARK }] },
    ]);
  });

  it("puts the cache marker on the last cached system block only", () => {
    const body = buildRequest(
      req({
        system: [
          { text: "A", cache: true },
          { text: "B", cache: true },
          { text: "C", cache: false },
        ],
      }),
      "text",
    );
    expect(body.input.messages[0]).toEqual({
      role: "system",
      content: [
        { type: "text", text: "A" },
        { type: "text", text: "B", cache_control: { type: "ephemeral" } },
        { type: "text", text: "C" },
      ],
    });
  });

  it("sends no system message when there is none", () => {
    const body = buildRequest(req({ system: [] }), "text");
    expect(body.input.messages[0]?.role).toBe("user");
  });

  it("thinking off is sent; unset is not; preserve_thinking only with thinking on", () => {
    expect(buildRequest(req({ params: { thinking: "off" } }), "text").parameters).toMatchObject({
      enable_thinking: false,
    });
    expect(
      buildRequest(req({ params: { thinking: "off" } }), "text").parameters.preserve_thinking,
    ).toBeUndefined();
    const unset = buildRequest(req(), "text").parameters;
    expect(unset.enable_thinking).toBeUndefined();
    expect(unset.preserve_thinking).toBeUndefined();
  });

  it("tool_choice none only with tools", () => {
    expect(
      buildRequest(req({ tools: [weather], toolChoice: "none" }), "text").parameters.tool_choice,
    ).toBe("none");
    expect(
      buildRequest(req({ toolChoice: "none" }), "text").parameters.tool_choice,
    ).toBeUndefined();
    expect(
      buildRequest(req({ tools: [weather], toolChoice: "auto" }), "text").parameters.tool_choice,
    ).toBeUndefined();
  });

  it("refuses an image on the text endpoint and an unresolved ref", () => {
    const image = (
      source: { kind: "base64"; data: string } | { kind: "ref"; attachmentId: string },
    ) =>
      req({
        messages: [{ role: "user", content: [{ type: "image", mediaType: "image/png", source }] }],
      });
    const e1 = (() => {
      try {
        buildRequest(image({ kind: "base64", data: "AAAA" }), "text");
      } catch (e) {
        return e;
      }
    })();
    expect(isModelError(e1) && e1.kind).toBe("invalid_request");
    const e2 = (() => {
      try {
        buildRequest(
          image({ kind: "ref", attachmentId: "00000000-0000-4000-8000-000000000000" }),
          "multimodal",
        );
      } catch (e) {
        return e;
      }
    })();
    expect(isModelError(e2) && e2.kind).toBe("invalid_request");
  });
});

describe("buildRequest (multimodal-generation)", () => {
  it("writes content as parts, images as data URLs", () => {
    const body = buildRequest(
      req({
        model: "qwen3.8-flash",
        messages: [
          {
            role: "user",
            content: [
              { type: "image", mediaType: "image/png", source: { kind: "base64", data: "AAAA" } },
              { type: "text", text: "Color?" },
            ],
          },
          { role: "assistant", content: [{ type: "text", text: "Red." }] },
          { role: "system", content: "Be brief." },
        ],
      }),
      "multimodal",
    );
    expect(body.input.messages).toEqual([
      {
        role: "system",
        content: [{ text: "You are concise.", cache_control: { type: "ephemeral" } }],
      },
      { role: "user", content: [{ image: "data:image/png;base64,AAAA" }, { text: "Color?" }] },
      { role: "assistant", content: [{ text: "Red." }] },
      { role: "user", content: [{ text: "[system] Be brief.", ...MARK }] },
    ]);
  });

  it("leaves a trailing image part unmarked", () => {
    const body = buildRequest(
      req({
        model: "qwen3.8-flash",
        messages: [
          {
            role: "user",
            content: [
              { type: "image", mediaType: "image/png", source: { kind: "base64", data: "AAAA" } },
            ],
          },
        ],
      }),
      "multimodal",
    );
    expect(body.input.messages.at(-1)).toEqual({
      role: "user",
      content: [{ image: "data:image/png;base64,AAAA" }],
    });
  });
});

describe("an assistant turn left empty", () => {
  const onlyOtherThinking: ModelMessage[] = [
    { role: "user", content: [{ type: "text", text: "Hi" }] },
    {
      role: "assistant",
      content: [
        {
          type: "thinking",
          text: "Another model's thoughts.",
          opaque: { provider: "bailian", model: "qwen-plus", data: { field: "reasoning_content" } },
        },
      ],
    },
    { role: "user", content: [{ type: "text", text: "Again" }] },
  ];

  it("is left out when only another model's thinking was in it", () => {
    for (const endpoint of ["text", "multimodal"] as const) {
      const body = buildRequest(req({ system: [], messages: onlyOtherThinking }), endpoint);
      expect(body.input.messages.map((m) => m.role)).toEqual(["user", "user"]);
    }
  });

  it("is kept when its thinking is this model's own", () => {
    const body = buildRequest(
      req({ system: [], model: "qwen-plus", messages: onlyOtherThinking }),
      "text",
    );
    expect(body.input.messages[1]).toEqual({
      role: "assistant",
      content: "",
      reasoning_content: "Another model's thoughts.",
    });
  });

  it("keeps the mapping a prefix of the longer history", () => {
    for (let n = 1; n < onlyOtherThinking.length; n++) {
      const a = buildRequest(req({ messages: onlyOtherThinking.slice(0, n) }), "text");
      const b = buildRequest(req({ messages: onlyOtherThinking }), "text");
      expect(unmarked(b.input.messages).slice(0, a.input.messages.length)).toEqual(
        unmarked(a.input.messages),
      );
    }
  });
});

describe("append-only", () => {
  it("the mapping of a request is a prefix of the mapping of the same request plus new messages, except the moving cache marker", () => {
    for (const endpoint of ["text", "multimodal"] as const) {
      const params = { thinking: "on" as const };
      for (let n = 1; n < history.length; n++) {
        const a = buildRequest(
          req({ messages: history.slice(0, n), tools: [weather], params }),
          endpoint,
        );
        const b = buildRequest(req({ messages: history, tools: [weather], params }), endpoint);
        expect(unmarked(b.input.messages).slice(0, a.input.messages.length)).toEqual(
          unmarked(a.input.messages),
        );
      }
    }
  });
});
