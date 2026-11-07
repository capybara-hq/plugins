import type { ContentBlock, ModelMessage, ModelRequest } from "@capybara-hq/plugin-sdk";
import { pdfBase64, redPngBase64 } from "@capybara-hq/testing";
import { describe, expect, it } from "vitest";
import { buildRequest } from "../src/map-request.js";
import { DEEPSEEK, SEED } from "./fixtures.js";

const req = (over: Partial<ModelRequest> = {}): ModelRequest => ({
  model: SEED,
  system: [
    { text: "Stable.", cache: true },
    { text: "Dynamic.", cache: false },
  ],
  messages: [{ role: "user", content: [{ type: "text", text: "Hi" }] }],
  tools: [],
  maxOutputTokens: 1000,
  params: {},
  ...over,
});

const own = (model: string, data: Record<string, unknown>) => ({
  provider: "ark",
  model,
  data: { field: "reasoning_content", ...data },
});

const assistant = (model: string, enc?: string): ModelMessage => ({
  role: "assistant",
  content: [
    {
      type: "thinking",
      text: "thought",
      opaque: own(model, enc !== undefined ? { encrypted_content: enc } : {}),
    },
    { type: "text", text: "Let me check." },
    { type: "tool_call", id: "call_1", name: "weather", input: { city: "Paris" } },
  ],
});

const toolResult: ModelMessage = {
  role: "user",
  content: [{ type: "tool_result", callId: "call_1", content: "Sunny", isError: false }],
};

const tools = [{ name: "weather", description: "Weather", inputSchema: { type: "object" } }];

describe("ark buildRequest", () => {
  it("maps the basic body: system first, max_completion_tokens, usage on", () => {
    const b = buildRequest(req());
    expect(b).toMatchObject({
      model: SEED,
      messages: [
        { role: "system", content: "Stable.\n\nDynamic." },
        { role: "user", content: "Hi" },
      ],
      // covers thinking + answer, so the output budget holds (live 2026-11-08)
      max_completion_tokens: 1000,
      stream: true,
      stream_options: { include_usage: true },
    });
    expect(b.max_tokens).toBeUndefined();
    expect(b.thinking).toBeUndefined();
    expect(b.reasoning_effort).toBeUndefined();
    expect(b.tools).toBeUndefined();
  });

  it("maps thinking, effort and temperature", () => {
    expect(buildRequest(req({ params: { thinking: "on", effort: "high" } }))).toMatchObject({
      thinking: { type: "enabled" },
      reasoning_effort: "high",
    });
    const off = buildRequest(
      req({ params: { thinking: "off", effort: "high", temperature: 0.3 } }),
    );
    expect(off.thinking).toEqual({ type: "disabled" });
    expect(off.reasoning_effort).toBeUndefined();
    expect(off.temperature).toBe(0.3);
  });

  it("sends tools, and tool_choice only for none", () => {
    const b = buildRequest(req({ tools, toolChoice: "none" }));
    expect(b.tools).toEqual([
      {
        type: "function",
        function: { name: "weather", description: "Weather", parameters: { type: "object" } },
      },
    ]);
    expect(b.tool_choice).toBe("none");
    expect(buildRequest(req({ tools, toolChoice: "auto" })).tool_choice).toBeUndefined();
    expect(buildRequest(req({ toolChoice: "none" })).tool_choice).toBeUndefined();
  });

  it("turns mid-conversation system messages into [system] user turns", () => {
    const b = buildRequest(
      req({
        messages: [
          { role: "user", content: [{ type: "text", text: "Hi" }] },
          { role: "system", content: "Be formal." },
        ],
      }),
    );
    expect(b.messages.at(-1)).toEqual({ role: "user", content: "[system] Be formal." });
  });

  it("replays encrypted_content to the same model, never with reasoning_content", () => {
    const b = buildRequest(
      req({ tools, messages: [...req().messages, assistant(SEED, "enc-1"), toolResult] }),
    );
    expect(b.messages[2]).toEqual({
      role: "assistant",
      content: "Let me check.",
      tool_calls: [
        {
          id: "call_1",
          type: "function",
          function: { name: "weather", arguments: '{"city":"Paris"}' },
        },
      ],
      encrypted_content: "enc-1",
    });
    expect(b.messages[3]).toEqual({ role: "tool", tool_call_id: "call_1", content: "Sunny" });
  });

  it("drops thinking from another model or provider", () => {
    const other = buildRequest(
      req({ messages: [...req().messages, assistant("doubao-seed-2-1-lite-260915", "enc-1")] }),
    );
    expect(other.messages[2]).not.toHaveProperty("encrypted_content");
    expect(other.messages[2]).not.toHaveProperty("reasoning_content");
    const foreign: ModelMessage = {
      role: "assistant",
      content: [
        {
          type: "thinking",
          text: "x",
          opaque: {
            provider: "openai-compatible",
            model: SEED,
            data: { field: "reasoning_content", encrypted_content: "e" },
          },
        },
        { type: "text", text: "Hi" },
      ],
    };
    const f = buildRequest(req({ messages: [...req().messages, foreign] }));
    expect(f.messages[2]).toEqual({ role: "assistant", content: "Hi" });
  });

  it("replays reasoning_content only to the deepseek models without encrypted_content", () => {
    const ds = buildRequest(
      req({ model: DEEPSEEK, messages: [...req().messages, assistant(DEEPSEEK)] }),
    );
    expect(ds.messages[2]).toMatchObject({ reasoning_content: "thought" });
    expect(ds.messages[2]).not.toHaveProperty("encrypted_content");
    // a seed turn without encrypted_content: the thinking is dropped
    const seed = buildRequest(req({ messages: [...req().messages, assistant(SEED)] }));
    expect(seed.messages[2]).not.toHaveProperty("reasoning_content");
  });

  it("is append-only: an earlier request's messages are a prefix of a later one's", () => {
    const turns: ModelMessage[] = [
      { role: "user", content: [{ type: "text", text: "Weather?" }] },
      assistant(SEED, "enc-1"),
      toolResult,
      { role: "assistant", content: [{ type: "text", text: "Sunny." }] },
      { role: "system", content: "Note." },
      { role: "user", content: [{ type: "text", text: "Thanks" }] },
      assistant(DEEPSEEK),
    ];
    for (const model of [SEED, DEEPSEEK]) {
      for (let i = 1; i < turns.length; i++) {
        const a = buildRequest(
          req({ model, tools, params: { thinking: "on" }, messages: turns.slice(0, i) }),
        );
        const b = buildRequest(req({ model, tools, params: { thinking: "on" }, messages: turns }));
        expect(b.messages.slice(0, a.messages.length)).toEqual(a.messages);
      }
    }
  });

  it("maps images, PDFs and text documents", () => {
    const content: ContentBlock[] = [
      { type: "text", text: "Look" },
      { type: "image", mediaType: "image/png", source: { kind: "base64", data: redPngBase64() } },
      {
        type: "document",
        mediaType: "application/pdf",
        name: "fruit",
        source: { kind: "base64", data: pdfBase64("KIWI") },
      },
      {
        type: "document",
        mediaType: "text/plain",
        name: "note.txt",
        source: { kind: "base64", data: Buffer.from("hello").toString("base64") },
      },
    ];
    const b = buildRequest(req({ messages: [{ role: "user", content }] }));
    const parts = b.messages[1]?.content as unknown as Record<string, unknown>[];
    expect(parts[0]).toEqual({ type: "text", text: "Look" });
    expect(parts[1]).toEqual({
      type: "image_url",
      image_url: { url: `data:image/png;base64,${redPngBase64()}` },
    });
    expect(parts[2]).toEqual({
      type: "file",
      file: {
        filename: "fruit.pdf",
        file_data: `data:application/pdf;base64,${pdfBase64("KIWI")}`,
      },
    });
    expect(parts[3]).toEqual({
      type: "text",
      text: '[Attached file "note.txt" (text/plain)]\nhello',
    });
  });

  it("refuses an unresolved attachment reference", () => {
    expect(() =>
      buildRequest(
        req({
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "image",
                  mediaType: "image/png",
                  source: { kind: "ref", attachmentId: "5f0c3a8e-0000-4000-8000-000000000000" },
                },
              ],
            },
          ],
        }),
      ),
    ).toThrow(/attachment reference/);
  });
});
