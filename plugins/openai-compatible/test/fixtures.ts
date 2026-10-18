import type { FakeRequest, FakeResponse } from "@capybara-hq/testing";

/** 手写的 Chat Completions 夹具：按原生 SSE 格式（`data: <chunk>` … `data: [DONE]`）回放。 */

export type Dialect = "generic" | "deepseek" | "qwen";

/** 原生用量对象（各方言字段不同，原样写进最后一个 chunk）。 */
export type RawUsage = Record<string, unknown> & {
  prompt_tokens: number;
  completion_tokens: number;
};

export interface ToolCallFixture {
  id: string;
  name: string;
  /** 原始参数字符串，按 `argChunk` 切成多段增量。 */
  args: string;
}

const pieces = (s: string, n: number): string[] => {
  const out: string[] = [];
  for (let i = 0; i < s.length; i += n) out.push(s.slice(i, i + n));
  return out;
};

/** 生成一次流式 Chat Completions 响应。 */
export function sseChat(opts: {
  model: string;
  reasoning?: string | undefined;
  text?: string;
  toolCalls?: ToolCallFixture[];
  /** null：不发 finish_reason（模拟流被截断）。 */
  finish: "stop" | "tool_calls" | "length" | "content_filter" | null;
  usage?: RawUsage;
  /** 用量放在带 finish_reason 的 chunk 里（部分服务这样做），而不是单独的末尾 chunk。 */
  usageInFinishChunk?: boolean;
  /** 不发 `data: [DONE]`。 */
  omitDone?: boolean;
  /** 发完后不关连接。 */
  keepOpen?: boolean;
  /** 在 finish 之前插入一个带 error 字段的事件（服务端流中途出错）。 */
  midStreamError?: { message: string; type?: string; code?: string };
}): FakeResponse {
  const data: string[] = [];
  const chunk = (choices: unknown[], extra: Record<string, unknown> = {}) =>
    data.push(
      JSON.stringify({
        id: "chatcmpl-fixture",
        object: "chat.completion.chunk",
        created: 1_760_000_000,
        model: opts.model,
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
    for (const a of pieces(c.args, 4))
      delta({ tool_calls: [{ index, function: { arguments: a } }] });
  });
  if (opts.midStreamError !== undefined) {
    data.push(JSON.stringify({ error: opts.midStreamError }));
  }
  if (opts.finish !== null) {
    chunk(
      [{ index: 0, delta: {}, finish_reason: opts.finish, logprobs: null }],
      opts.usageInFinishChunk && opts.usage ? { usage: opts.usage } : {},
    );
    if (!opts.usageInFinishChunk && opts.usage) chunk([], { usage: opts.usage });
  }
  if (!opts.omitDone && !opts.keepOpen) data.push("[DONE]");
  return {
    status: 200,
    sse: data.map((d) => ({ data: d })),
    ...(opts.keepOpen ? { keepOpen: true } : {}),
  };
}

export const errorJson = (
  status: number,
  error: { message: string; type?: string; code?: string | null; param?: string | null },
  headers?: Record<string, string>,
): FakeResponse => ({
  status,
  json: { error: { code: null, param: null, type: "invalid_request_error", ...error } },
  ...(headers !== undefined ? { headers } : {}),
});

/** 各方言的原生用量：`total` 为输入总量（含缓存命中），`cached` 为命中部分。 */
export function usageFor(
  dialect: Dialect,
  u: { total: number; cached?: number; output: number },
): RawUsage {
  const cached = u.cached ?? 0;
  switch (dialect) {
    case "deepseek":
      return {
        prompt_tokens: u.total,
        completion_tokens: u.output,
        total_tokens: u.total + u.output,
        prompt_cache_hit_tokens: cached,
        prompt_cache_miss_tokens: u.total - cached,
        prompt_tokens_details: { cached_tokens: cached },
      };
    case "qwen":
      return {
        prompt_tokens: u.total,
        completion_tokens: u.output,
        total_tokens: u.total + u.output,
        prompt_tokens_details: { cached_tokens: cached, cache_creation_input_tokens: 0 },
      };
    default:
      return {
        prompt_tokens: u.total,
        completion_tokens: u.output,
        total_tokens: u.total + u.output,
        prompt_tokens_details: { cached_tokens: cached },
      };
  }
}

interface Msg {
  role: string;
  content?: unknown;
  reasoning_content?: string;
  tool_calls?: { id: string; function: { name: string; arguments: string } }[];
}

interface Body {
  model: string;
  messages: Msg[];
  stream?: boolean;
  stream_options?: { include_usage?: boolean };
  max_tokens?: number;
  tools?: { type: string; function: { name: string } }[];
  thinking?: { type: string };
  enable_thinking?: boolean;
}

/** 违反协议约束时返回的原因（夹具也替真实接口把关）。 */
function protocolViolation(dialect: Dialect, b: Body, thinks: boolean): string | null {
  if (b.stream !== true) return "stream must be true";
  if (b.stream_options?.include_usage !== true) return "stream_options.include_usage must be true";
  if (typeof b.max_tokens !== "number") return "max_tokens is required";
  // generic（多数开源模型的 chat template）与 qwen：system 只能在开头
  if (dialect !== "deepseek" && b.messages.some((m, i) => m.role === "system" && i > 0))
    return "System message must be at the beginning.";
  // DeepSeek 思考模式 + tools：历史 assistant 消息必须带回 reasoning_content，否则 400
  if (dialect === "deepseek" && thinks && (b.tools?.length ?? 0) > 0) {
    if (b.messages.some((m) => m.role === "assistant" && typeof m.reasoning_content !== "string"))
      return "The reasoning_content in the thinking mode must be passed back to the API.";
  }
  if (dialect !== "deepseek" && b.messages.some((m) => m.reasoning_content !== undefined))
    return "reasoning_content is not expected for this dialect";
  return null;
}

/** 一致性测试用的路由：按请求内容挑场景。 */
export function chatRoutes(dialect: Dialect): (req: FakeRequest) => FakeResponse {
  // 夹具服务自身的「缓存」：同一稳定前缀第二次起命中
  const cachedPrefixes = new Set<string>();
  return (req) => {
    if (req.path !== "/v1/chat/completions") {
      return errorJson(404, { message: "not found" });
    }
    const b = req.body as Body;
    // deepseek 思考默认开启（thinking.type 默认 enabled）；qwen 3.5+ 默认开启
    const thinks =
      dialect === "deepseek"
        ? b.thinking?.type !== "disabled"
        : dialect === "qwen"
          ? b.enable_thinking !== false
          : false;
    const violation = protocolViolation(dialect, b, thinks);
    if (violation !== null) return errorJson(400, { message: violation });
    const model = b.model;
    const reasoning = thinks ? "17 * 23 = 391." : undefined;
    const usage = (total: number, output: number, cached = 0) =>
      usageFor(dialect, { total, output, cached });

    const system = b.messages[0]?.role === "system" ? String(b.messages[0].content) : "";
    if (system.length > 4000) {
      const seen = cachedPrefixes.has(system);
      cachedPrefixes.add(system);
      return sseChat({
        model,
        reasoning,
        text: "Hello.",
        finish: "stop",
        usage: usage(5010, 3, seen ? 5000 : 0),
      });
    }
    if (b.messages.at(-1)?.role === "tool") {
      return sseChat({
        model,
        reasoning,
        text: "It is sunny and 22C in Paris.",
        finish: "stop",
        usage: usage(150, 12),
      });
    }
    if ((b.tools?.length ?? 0) > 0) {
      return sseChat({
        model,
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
      model,
      reasoning,
      text: thinks ? "391" : "Hello there, friend!",
      finish: "stop",
      usage: usage(25, 8),
    });
  };
}
