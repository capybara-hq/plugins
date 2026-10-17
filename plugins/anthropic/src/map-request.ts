import type Anthropic from "@anthropic-ai/sdk";
import type { ContentBlock, ModelMessage, ModelRequest } from "@capybara-hq/plugin-sdk";

export const PROVIDER = "anthropic";
export const SERVER_FALLBACK_BETA = "server-side-fallback-2026-07-01";

export type ServerFallbacks = "default" | "off";

/** 请求体（不含 stream 字段；发送时补 `stream: true`）。 */
export type AnthropicParams = Omit<Anthropic.MessageCreateParamsNonStreaming, "stream">;

export interface BuiltRequest {
  params: AnthropicParams;
  /** 非 null 时走 beta 接口并附带这些参数（服务端拒答兜底）。 */
  beta: { betas: string[]; fallbacks: "default" } | null;
}

/** 支持服务端拒答兜底（`fallbacks: "default"`）的模型。 */
export function supportsServerFallback(model: string): boolean {
  switch (model) {
    case "claude-opus-5-5":
    case "claude-opus-5":
    case "claude-fable-5-1":
    case "claude-sonnet-5-5":
      return true;
    default:
      return false;
  }
}

function mapUserBlock(b: ContentBlock): Anthropic.ContentBlockParam | null {
  switch (b.type) {
    case "text":
      return { type: "text", text: b.text };
    case "tool_result":
      return {
        type: "tool_result",
        tool_use_id: b.callId,
        content: b.content,
        is_error: b.isError,
      };
    default:
      return null;
  }
}

function mapAssistantBlock(b: ContentBlock, model: string): Anthropic.ContentBlockParam | null {
  switch (b.type) {
    case "text":
      return { type: "text", text: b.text };
    case "thinking":
      // 思考块（含签名）只原样回放给产生它的同一模型
      if (b.opaque?.provider === PROVIDER && b.opaque.model === model && b.opaque.data != null) {
        return b.opaque.data as Anthropic.ContentBlockParam;
      }
      return null;
    case "tool_call":
      return {
        type: "tool_use",
        id: b.id,
        name: b.name,
        input: (b.input ?? {}) as Record<string, unknown>,
      };
    default:
      return null;
  }
}

const systemAsUserText = (text: string): Anthropic.MessageParam => ({
  role: "user",
  content: [{ type: "text", text: `[system] ${text}` }],
});

/**
 * 映射消息。对话中途的 system 消息一律在原位置转成 user 文本块（以 "[system] " 开头），不用原生
 * `role: "system"`、不调整顺序（R38）：原生 system 的位置规则需要看后续消息，历史追加后会改写
 * 已发送的前缀，违反「发给模型的历史只追加」。连续的 user 消息由 API 合并为一个回合。
 * 每条消息的映射只取决于它自己与请求模型，所以较早请求的消息序列总是较晚请求的前缀。
 */
function mapMessages(messages: ModelMessage[], model: string): Anthropic.MessageParam[] {
  const out: Anthropic.MessageParam[] = [];
  for (const m of messages) {
    if (m.role === "system") {
      out.push(systemAsUserText(m.content));
      continue;
    }
    const content =
      m.role === "user"
        ? m.content.map(mapUserBlock).filter((b) => b !== null)
        : m.content.map((b) => mapAssistantBlock(b, model)).filter((b) => b !== null);
    if (content.length > 0) out.push({ role: m.role, content });
  }
  return out;
}

/** model-provider@1 请求 → Anthropic Messages API 请求。纯函数。 */
export function buildRequest(
  req: ModelRequest,
  opts: { serverFallbacks: ServerFallbacks },
): BuiltRequest {
  const params: AnthropicParams = {
    model: req.model,
    max_tokens: req.maxOutputTokens,
    messages: mapMessages(req.messages, req.model),
    // 当前模型默认 display: "omitted"（思考文本为空）；summarized 返回推理摘要供界面流式展示，计费不变（R37）
    thinking: { type: "adaptive", display: "summarized" },
  };
  if (req.system.length > 0) {
    params.system = req.system.map((s) =>
      s.cache
        ? { type: "text", text: s.text, cache_control: { type: "ephemeral" } }
        : { type: "text", text: s.text },
    );
  }
  if (req.effort !== undefined) params.output_config = { effort: req.effort };
  if (req.tools.length > 0) {
    // tool_choice 不设置（默认 auto）：any / tool 在当前模型上会 400
    params.tools = req.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
      eager_input_streaming: true,
    }));
  }
  const beta =
    opts.serverFallbacks === "default" && supportsServerFallback(req.model)
      ? { betas: [SERVER_FALLBACK_BETA], fallbacks: "default" as const }
      : null;
  return { params, beta };
}
