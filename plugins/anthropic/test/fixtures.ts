import type { FakeRequest, FakeResponse } from "@capybara-hq/testing";

/** 手写的 Anthropic Messages API 夹具：按原生 SSE 格式回放。 */

type Block =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string; signature: string }
  | { type: "tool_use"; id: string; name: string; inputJson: string };

interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

const chunks = (s: string, n: number): string[] => {
  const out: string[] = [];
  for (let i = 0; i < s.length; i += n) out.push(s.slice(i, i + n));
  return out.length > 0 ? out : [""];
};

const ev = (event: string, data: unknown) => ({ event, data: JSON.stringify(data) });

/** 生成一条完整消息的 SSE 事件序列。 */
export function sseMessage(opts: {
  model: string;
  blocks: Block[];
  stopReason: string;
  usage: Usage;
  delayMs?: number;
}): FakeResponse {
  const events: { event?: string; data: string }[] = [];
  events.push(
    ev("message_start", {
      type: "message_start",
      message: {
        id: "msg_fixture",
        type: "message",
        role: "assistant",
        model: opts.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: opts.usage.input_tokens,
          output_tokens: 1,
          cache_read_input_tokens: opts.usage.cache_read_input_tokens ?? 0,
          cache_creation_input_tokens: opts.usage.cache_creation_input_tokens ?? 0,
        },
      },
    }),
  );
  opts.blocks.forEach((b, index) => {
    if (b.type === "text") {
      events.push(
        ev("content_block_start", {
          type: "content_block_start",
          index,
          content_block: { type: "text", text: "" },
        }),
      );
      for (const c of chunks(b.text, 4)) {
        events.push(
          ev("content_block_delta", {
            type: "content_block_delta",
            index,
            delta: { type: "text_delta", text: c },
          }),
        );
      }
    } else if (b.type === "thinking") {
      events.push(
        ev("content_block_start", {
          type: "content_block_start",
          index,
          content_block: { type: "thinking", thinking: "", signature: "" },
        }),
      );
      for (const c of chunks(b.thinking, 6)) {
        events.push(
          ev("content_block_delta", {
            type: "content_block_delta",
            index,
            delta: { type: "thinking_delta", thinking: c },
          }),
        );
      }
      events.push(
        ev("content_block_delta", {
          type: "content_block_delta",
          index,
          delta: { type: "signature_delta", signature: b.signature },
        }),
      );
    } else {
      events.push(
        ev("content_block_start", {
          type: "content_block_start",
          index,
          content_block: { type: "tool_use", id: b.id, name: b.name, input: {} },
        }),
      );
      for (const c of chunks(b.inputJson, 5)) {
        events.push(
          ev("content_block_delta", {
            type: "content_block_delta",
            index,
            delta: { type: "input_json_delta", partial_json: c },
          }),
        );
      }
    }
    events.push(ev("content_block_stop", { type: "content_block_stop", index }));
  });
  events.push(
    ev("message_delta", {
      type: "message_delta",
      delta: { stop_reason: opts.stopReason, stop_sequence: null },
      usage: {
        input_tokens: opts.usage.input_tokens,
        output_tokens: opts.usage.output_tokens,
        cache_read_input_tokens: opts.usage.cache_read_input_tokens ?? 0,
        cache_creation_input_tokens: opts.usage.cache_creation_input_tokens ?? 0,
      },
    }),
  );
  events.push(ev("message_stop", { type: "message_stop" }));
  return opts.delayMs !== undefined
    ? { status: 200, sse: events, delayMs: opts.delayMs }
    : { status: 200, sse: events };
}

export const errorJson = (
  status: number,
  type: string,
  message: string,
  headers?: Record<string, string>,
): FakeResponse => ({
  status,
  json: { type: "error", error: { type, message }, request_id: "req_fixture" },
  ...(headers !== undefined ? { headers } : {}),
});

/** Models API 的模型对象。 */
export function modelObject(id: string): unknown {
  return {
    type: "model",
    id,
    display_name: id,
    created_at: "2026-01-01T00:00:00Z",
    max_input_tokens: 1_000_000,
    max_tokens: 128_000,
    capabilities: {
      image_input: { supported: true },
      thinking: { supported: true, types: { adaptive: { supported: true } } },
      effort: { supported: true },
    },
  };
}

interface Body {
  model: string;
  system?: { type: string; text: string; cache_control?: unknown }[];
  messages: { role: string; content: string | { type: string; [k: string]: unknown }[] }[];
  tools?: { name: string; eager_input_streaming?: boolean }[];
  output_config?: { effort?: string };
  thinking?: { type: string };
  tool_choice?: unknown;
  fallbacks?: unknown;
}

const lastUserBlocks = (b: Body) => {
  for (let i = b.messages.length - 1; i >= 0; i--) {
    const m = b.messages[i];
    if (m?.role === "user") return typeof m.content === "string" ? [] : m.content;
  }
  return [];
};

/** 违反 Anthropic 当前协议约束时返回 400（夹具也替真实接口把关）。 */
function protocolViolation(b: Body, headers: Record<string, string>, path: string): string | null {
  const json = JSON.stringify(b);
  if (json.includes("budget_tokens")) return "budget_tokens is not supported";
  if (b.thinking?.type !== "adaptive") return "thinking.type must be adaptive";
  if (b.tool_choice !== undefined) return "tool_choice must not be set";
  if (b.tools?.some((t) => t.eager_input_streaming !== true))
    return "eager_input_streaming expected";
  const beta = headers["anthropic-beta"] ?? "";
  const fallbackModel = [
    "claude-opus-5-5",
    "claude-opus-5",
    "claude-fable-5-1",
    "claude-sonnet-5-5",
  ].includes(b.model);
  if (fallbackModel) {
    if (
      b.fallbacks !== "default" ||
      !beta.includes("server-side-fallback-2026-07-01") ||
      !path.includes("beta=true")
    ) {
      return "expected server-side fallbacks";
    }
  } else if (b.fallbacks !== undefined || beta.includes("server-side-fallback")) {
    return "fallbacks not supported for this model";
  }
  for (let i = 0; i < b.messages.length; i++) {
    const m = b.messages[i];
    if (m?.role !== "system") continue;
    const prev = b.messages[i - 1]?.role;
    const next = b.messages[i + 1]?.role;
    if (prev !== "user" && prev !== "system") return "system message must follow a user message";
    if (next !== undefined && next !== "assistant" && next !== "system") {
      return "system message must be last or followed by an assistant turn";
    }
  }
  for (const m of b.messages) {
    if (m.role !== "assistant" || typeof m.content === "string") continue;
    for (const c of m.content) {
      if (c.type === "thinking" && c.signature !== "sig-fixture-1")
        return "Invalid signature in thinking block";
    }
  }
  return null;
}

/** 一致性测试用的路由：按请求内容挑场景。 */
export function anthropicRoutes(): (req: FakeRequest) => FakeResponse {
  const cachedPrefixes = new Set<string>();
  return (req) => {
    const modelPath = /^\/v1\/models\/([^/?]+)/.exec(req.path);
    if (modelPath?.[1] !== undefined)
      return { status: 200, json: modelObject(decodeURIComponent(modelPath[1])) };
    if (!req.path.startsWith("/v1/messages")) return errorJson(404, "not_found_error", "not found");
    const b = req.body as Body;
    const violation = protocolViolation(b, req.headers, req.path);
    if (violation !== null) return errorJson(400, "invalid_request_error", violation);
    const model = b.model;
    const last = lastUserBlocks(b);
    const text = (t: string, usage: Usage = { input_tokens: 25, output_tokens: 8 }) =>
      sseMessage({ model, blocks: [{ type: "text", text: t }], stopReason: "end_turn", usage });

    const systemText = (b.system ?? []).map((s) => s.text).join("");
    if (systemText.length > 4000) {
      const cached = b.system?.some((s) => s.cache_control !== undefined) === true;
      const seen = cachedPrefixes.has(systemText);
      if (cached) cachedPrefixes.add(systemText);
      return text("Hello.", {
        input_tokens: 10,
        output_tokens: 3,
        cache_read_input_tokens: cached && seen ? 5000 : 0,
        cache_creation_input_tokens: cached && !seen ? 5000 : 0,
      });
    }
    if (last.some((c) => c.type === "tool_result")) return text("It is sunny and 22C in Paris.");
    if ((b.tools?.length ?? 0) > 0) {
      return sseMessage({
        model,
        blocks: [
          { type: "text", text: "Let me check." },
          {
            type: "tool_use",
            id: "toolu_fixture_1",
            name: b.tools?.[0]?.name ?? "tool",
            inputJson: '{"city": "Paris"}',
          },
        ],
        stopReason: "tool_use",
        usage: { input_tokens: 120, output_tokens: 30 },
      });
    }
    if (b.output_config?.effort !== undefined) {
      return sseMessage({
        model,
        blocks: [
          { type: "thinking", thinking: "17 * 23 = 391.", signature: "sig-fixture-1" },
          { type: "text", text: "391" },
        ],
        stopReason: "end_turn",
        usage: { input_tokens: 30, output_tokens: 40 },
      });
    }
    return text("Hello there, friend!");
  };
}
