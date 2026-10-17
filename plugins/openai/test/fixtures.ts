import type { FakeRequest, FakeResponse } from "@capybara-hq/testing";

/** 手写的 OpenAI Responses API 夹具：按原生 SSE 事件格式回放。 */

export type Item =
  | { type: "message"; text: string; refusal?: string }
  | { type: "reasoning"; summary: string[]; encrypted: string }
  | { type: "function_call"; callId: string; name: string; args: string };

export interface Usage {
  /** OpenAI 语义：含缓存命中部分。 */
  input_tokens: number;
  output_tokens: number;
  cached_tokens?: number;
  cache_write_tokens?: number;
}

const chunks = (s: string, n: number): string[] => {
  const out: string[] = [];
  for (let i = 0; i < s.length; i += n) out.push(s.slice(i, i + n));
  return out.length > 0 ? out : [""];
};

/** 生成一次完整响应的 SSE 事件序列。 */
export function sseResponse(opts: {
  model: string;
  items: Item[];
  usage: Usage;
  /** 默认 completed；incomplete 时以 response.incomplete 结束。 */
  incomplete?: "max_output_tokens" | "content_filter";
}): FakeResponse {
  let seq = 0;
  const events: { event?: string; data: string }[] = [];
  const ev = (type: string, data: Record<string, unknown>) =>
    events.push({ event: type, data: JSON.stringify({ type, sequence_number: seq++, ...data }) });
  const response = (status: string, output: unknown[], extra: Record<string, unknown> = {}) => ({
    id: "resp_fixture",
    object: "response",
    created_at: 1_760_000_000,
    model: `${opts.model}-2026-01-01`,
    status,
    output,
    error: null,
    incomplete_details: null,
    usage: null,
    ...extra,
  });

  ev("response.created", { response: response("in_progress", []) });
  ev("response.in_progress", { response: response("in_progress", []) });
  const done: unknown[] = [];
  opts.items.forEach((it, output_index) => {
    if (it.type === "message") {
      const item_id = `msg_${output_index}`;
      ev("response.output_item.added", {
        output_index,
        item: {
          id: item_id,
          type: "message",
          role: "assistant",
          status: "in_progress",
          content: [],
        },
      });
      const content: unknown[] = [];
      if (it.text !== "") {
        ev("response.content_part.added", {
          item_id,
          output_index,
          content_index: 0,
          part: { type: "output_text", text: "", annotations: [] },
        });
        for (const c of chunks(it.text, 4)) {
          ev("response.output_text.delta", {
            item_id,
            output_index,
            content_index: 0,
            delta: c,
            logprobs: [],
          });
        }
        ev("response.output_text.done", {
          item_id,
          output_index,
          content_index: 0,
          text: it.text,
          logprobs: [],
        });
        const part = { type: "output_text", text: it.text, annotations: [] };
        ev("response.content_part.done", { item_id, output_index, content_index: 0, part });
        content.push(part);
      }
      if (it.refusal !== undefined) {
        const content_index = content.length;
        ev("response.refusal.delta", { item_id, output_index, content_index, delta: it.refusal });
        ev("response.refusal.done", { item_id, output_index, content_index, refusal: it.refusal });
        content.push({ type: "refusal", refusal: it.refusal });
      }
      const item = {
        id: item_id,
        type: "message",
        role: "assistant",
        status: "completed",
        content,
      };
      ev("response.output_item.done", { output_index, item });
      done.push(item);
    } else if (it.type === "reasoning") {
      const item_id = `rs_${output_index}`;
      ev("response.output_item.added", {
        output_index,
        item: { id: item_id, type: "reasoning", summary: [] },
      });
      it.summary.forEach((s, summary_index) => {
        ev("response.reasoning_summary_part.added", {
          item_id,
          output_index,
          summary_index,
          part: { type: "summary_text", text: "" },
        });
        for (const c of chunks(s, 6)) {
          ev("response.reasoning_summary_text.delta", {
            item_id,
            output_index,
            summary_index,
            delta: c,
          });
        }
        ev("response.reasoning_summary_text.done", {
          item_id,
          output_index,
          summary_index,
          text: s,
        });
        ev("response.reasoning_summary_part.done", {
          item_id,
          output_index,
          summary_index,
          part: { type: "summary_text", text: s },
        });
      });
      const item = {
        id: item_id,
        type: "reasoning",
        summary: it.summary.map((text) => ({ type: "summary_text", text })),
        encrypted_content: it.encrypted,
      };
      ev("response.output_item.done", { output_index, item });
      done.push(item);
    } else {
      const item_id = `fc_${output_index}`;
      const base = { id: item_id, type: "function_call", call_id: it.callId, name: it.name };
      ev("response.output_item.added", {
        output_index,
        item: { ...base, arguments: "", status: "in_progress" },
      });
      for (const c of chunks(it.args, 5)) {
        ev("response.function_call_arguments.delta", { item_id, output_index, delta: c });
      }
      ev("response.function_call_arguments.done", {
        item_id,
        output_index,
        name: it.name,
        arguments: it.args,
      });
      const item = { ...base, arguments: it.args, status: "completed" };
      ev("response.output_item.done", { output_index, item });
      done.push(item);
    }
  });
  const usage = {
    input_tokens: opts.usage.input_tokens,
    input_tokens_details: {
      cached_tokens: opts.usage.cached_tokens ?? 0,
      cache_write_tokens: opts.usage.cache_write_tokens ?? 0,
    },
    output_tokens: opts.usage.output_tokens,
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: opts.usage.input_tokens + opts.usage.output_tokens,
  };
  if (opts.incomplete !== undefined) {
    ev("response.incomplete", {
      response: response("incomplete", done, {
        usage,
        incomplete_details: { reason: opts.incomplete },
      }),
    });
  } else {
    ev("response.completed", { response: response("completed", done, { usage }) });
  }
  return { status: 200, sse: events };
}

export const errorJson = (
  status: number,
  error: { message: string; type: string; code?: string | null; param?: string | null },
  headers?: Record<string, string>,
): FakeResponse => ({
  status,
  json: { error: { code: null, param: null, ...error } },
  ...(headers !== undefined ? { headers } : {}),
});

interface InputItem {
  type?: string;
  role?: string;
  encrypted_content?: string;
  [k: string]: unknown;
}

interface Body {
  model: string;
  instructions?: string;
  input: InputItem[];
  tools?: { type: string; name: string }[];
  reasoning?: { effort?: string; summary?: string };
  include?: string[];
  store?: boolean;
  stream?: boolean;
  max_output_tokens?: number;
}

/** 违反协议约束时返回 400（夹具也替真实接口把关）。 */
function protocolViolation(b: Body): string | null {
  if (b.stream !== true) return "stream must be true";
  if (b.store !== false) return "store must be false";
  if (!b.include?.includes("reasoning.encrypted_content"))
    return "include must contain reasoning.encrypted_content";
  if (typeof b.max_output_tokens !== "number") return "max_output_tokens is required";
  if (b.input.some((i) => i.role === "system")) return "system role items are not expected";
  for (const i of b.input) {
    if (i.type === "reasoning" && i.encrypted_content !== "enc-fixture-1")
      return "Invalid encrypted_content in reasoning item";
  }
  return null;
}

/** 一致性测试用的路由：按请求内容挑场景。 */
export function openaiRoutes(): (req: FakeRequest) => FakeResponse {
  const cachedPrefixes = new Set<string>();
  return (req) => {
    if (req.path !== "/v1/responses") {
      return errorJson(404, { message: "not found", type: "invalid_request_error" });
    }
    const b = req.body as Body;
    const violation = protocolViolation(b);
    if (violation !== null) {
      return errorJson(400, { message: violation, type: "invalid_request_error" });
    }
    const model = b.model;
    const text = (t: string, usage: Usage = { input_tokens: 25, output_tokens: 8 }) =>
      sseResponse({ model, items: [{ type: "message", text: t }], usage });

    const instructions = b.instructions ?? "";
    if (instructions.length > 4000) {
      // 缓存是自动的：相同前缀第二次起命中；input_tokens 含缓存命中部分
      const seen = cachedPrefixes.has(instructions);
      cachedPrefixes.add(instructions);
      return text("Hello.", {
        input_tokens: 5010,
        output_tokens: 3,
        cached_tokens: seen ? 5000 : 0,
      });
    }
    if (b.input.at(-1)?.type === "function_call_output") {
      return text("It is sunny and 22C in Paris.");
    }
    if ((b.tools?.length ?? 0) > 0) {
      return sseResponse({
        model,
        items: [
          { type: "message", text: "Let me check." },
          {
            type: "function_call",
            callId: "call_fixture_1",
            name: b.tools?.[0]?.name ?? "tool",
            args: '{"city": "Paris"}',
          },
        ],
        usage: { input_tokens: 120, output_tokens: 30 },
      });
    }
    if (b.reasoning?.effort !== undefined) {
      return sseResponse({
        model,
        items: [
          { type: "reasoning", summary: ["17 * 23 = 391."], encrypted: "enc-fixture-1" },
          { type: "message", text: "391" },
        ],
        usage: { input_tokens: 30, output_tokens: 40 },
      });
    }
    return text("Hello there, friend!");
  };
}
