import type { FakeRequest, FakeResponse } from "@capybara-hq/testing";

/** Hand-written DeepSeek fixtures: `/models` bodies and native Chat Completions SSE. */

/** A recorded `GET /models` body (2026-11-08) plus one entry that has only the required fields. */
export const MODELS_BODY = {
  object: "list",
  data: [
    {
      id: "deepseek-flash",
      object: "model",
      owned_by: "deepseek",
      name: "DeepSeek-V4.1-Flash",
      context_window: 1048576,
      max_output_tokens: 393216,
      input_modalities: ["text", "image"],
      output_modalities: ["text"],
      effort: { supported_levels: ["low", "high", "max"], default_level: "high" },
      api_capabilities: {
        anthropic_messages: { system_prompt_update: "in-history", tool_update: "addition-only" },
      },
    },
    {
      id: "deepseek-v4-pro",
      object: "model",
      owned_by: "deepseek",
      name: "DeepSeek-V4-Pro",
      context_window: 1048576,
      max_output_tokens: 393216,
      input_modalities: ["text"],
      output_modalities: ["text"],
      effort: { supported_levels: ["low", "high", "max"], default_level: "high" },
      api_capabilities: {
        anthropic_messages: { system_prompt_update: "leading-only", tool_update: "leading-only" },
      },
    },
    { id: "deepseek-plain", object: "model", owned_by: "deepseek" },
  ],
};

export type RawUsage = Record<string, unknown> & {
  prompt_tokens: number;
  completion_tokens: number;
};

export function usageFor(u: { total: number; cached?: number; output: number }): RawUsage {
  const cached = u.cached ?? 0;
  return {
    prompt_tokens: u.total,
    completion_tokens: u.output,
    total_tokens: u.total + u.output,
    prompt_cache_hit_tokens: cached,
    prompt_cache_miss_tokens: u.total - cached,
    prompt_tokens_details: { cached_tokens: cached },
  };
}

const pieces = (s: string, n: number): string[] => {
  const out: string[] = [];
  for (let i = 0; i < s.length; i += n) out.push(s.slice(i, i + n));
  return out;
};

export interface ToolCallFixture {
  id: string;
  name: string;
  args: string;
}

/** One streamed Chat Completions response (`data: <chunk>` ... `data: [DONE]`). */
export function sseChat(opts: {
  model?: string;
  reasoning?: string | undefined;
  text?: string;
  toolCalls?: ToolCallFixture[];
  finish: string | null;
  usage?: RawUsage;
  keepOpen?: boolean;
  omitDone?: boolean;
}): FakeResponse {
  const data: string[] = [];
  const chunk = (choices: unknown[], extra: Record<string, unknown> = {}) =>
    data.push(
      JSON.stringify({
        id: "chatcmpl-fixture",
        object: "chat.completion.chunk",
        created: 1_760_000_000,
        model: opts.model ?? "deepseek-flash",
        choices,
        ...extra,
      }),
    );
  const delta = (d: Record<string, unknown>) =>
    chunk([{ index: 0, delta: d, finish_reason: null, logprobs: null }]);
  delta({ role: "assistant", content: "" });
  for (const r of pieces(opts.reasoning ?? "", 5)) delta({ content: null, reasoning_content: r });
  for (const t of pieces(opts.text ?? "", 6)) delta({ content: t });
  (opts.toolCalls ?? []).forEach((c, index) => {
    delta({
      tool_calls: [
        { index, id: c.id, type: "function", function: { name: c.name, arguments: "" } },
      ],
    });
    for (const a of pieces(c.args, 4)) {
      delta({ tool_calls: [{ index, function: { arguments: a } }] });
    }
  });
  if (opts.finish !== null) {
    chunk([{ index: 0, delta: {}, finish_reason: opts.finish, logprobs: null }]);
    if (opts.usage) chunk([], { usage: opts.usage });
  }
  if (!opts.omitDone) data.push("[DONE]");
  return {
    status: 200,
    sse: data.map((d) => ({ data: d })),
    ...(opts.keepOpen ? { keepOpen: true } : {}),
  };
}

export const errorJson = (
  status: number,
  error: { message: string; type?: string; code?: string | null },
  headers?: Record<string, string>,
): FakeResponse => ({
  status,
  json: { error: { code: null, param: null, type: "invalid_request_error", ...error } },
  ...(headers !== undefined ? { headers } : {}),
});

interface Msg {
  role: string;
  content?: unknown;
  reasoning_content?: string;
}
interface Body {
  model: string;
  messages: Msg[];
  stream?: boolean;
  stream_options?: { include_usage?: boolean };
  max_tokens?: number;
  tools?: { function: { name: string } }[];
  thinking?: { type: string };
}

/** Routes for the conformance suite: scenario picked from the request; also guards the protocol. */
export function deepseekRoutes(): (req: FakeRequest) => FakeResponse {
  const cachedPrefixes = new Set<string>();
  return (req) => {
    if (req.path === "/models") return { status: 200, json: MODELS_BODY };
    if (req.path !== "/chat/completions") return errorJson(404, { message: "not found" });
    const b = req.body as Body;
    const thinks = b.thinking?.type !== "disabled";
    if (b.stream !== true) return errorJson(400, { message: "stream must be true" });
    if (b.stream_options?.include_usage !== true)
      return errorJson(400, { message: "stream_options.include_usage must be true" });
    if (typeof b.max_tokens !== "number")
      return errorJson(400, { message: "max_tokens is required" });
    if (
      thinks &&
      (b.tools?.length ?? 0) > 0 &&
      b.messages.some((m) => m.role === "assistant" && typeof m.reasoning_content !== "string")
    ) {
      return errorJson(400, {
        message: "The reasoning_content in the thinking mode must be passed back to the API.",
      });
    }
    const reasoning = thinks ? "17 * 23 = 391." : undefined;
    const usage = (total: number, output: number, cached = 0) =>
      usageFor({ total, output, cached });
    const system = b.messages[0]?.role === "system" ? String(b.messages[0].content) : "";
    if (system.length > 4000) {
      const seen = cachedPrefixes.has(system);
      cachedPrefixes.add(system);
      return sseChat({
        reasoning,
        text: "Hello.",
        finish: "stop",
        usage: usage(5010, 3, seen ? 5000 : 0),
      });
    }
    if (JSON.stringify(b.messages).includes("data:image/png;base64,")) {
      return sseChat({ reasoning, text: "Red.", finish: "stop", usage: usage(1600, 2) });
    }
    if (b.messages.at(-1)?.role === "tool") {
      return sseChat({
        reasoning,
        text: "It is sunny and 22C in Paris.",
        finish: "stop",
        usage: usage(150, 12),
      });
    }
    if ((b.tools?.length ?? 0) > 0) {
      return sseChat({
        reasoning,
        text: "Let me check.",
        toolCalls: [
          {
            id: "call_fixture_1",
            name: b.tools?.[0]?.function.name ?? "tool",
            args: '{"city": "Paris"}',
          },
        ],
        finish: "tool_calls",
        usage: usage(120, 30),
      });
    }
    return sseChat({
      reasoning,
      text: thinks ? "391" : "Hello there, friend!",
      finish: "stop",
      usage: usage(25, 8),
    });
  };
}
