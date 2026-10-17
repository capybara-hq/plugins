import type Anthropic from "@anthropic-ai/sdk";
import type { ContentBlock, ModelMessage, ModelRequest } from "@capybara-hq/plugin-sdk";

export const PROVIDER = "anthropic";
export const SERVER_FALLBACK_BETA = "server-side-fallback-2026-07-01";

export type ServerFallbacks = "default" | "off";

/** 请求体（不含 stream 字段；由 client.messages.stream / beta 版补上）。 */
export type AnthropicParams = Anthropic.MessageStreamParams;

export interface BuiltRequest {
  params: AnthropicParams;
  /** 非 null 时走 beta 接口并附带这些参数（服务端拒答兜底）。 */
  beta: { betas: string[]; fallbacks: "default" } | null;
}

/**
 * 支持对话中途 `role: "system"` 的模型：Opus 4.8、Opus 5 及以后、Sonnet 5.5、Haiku 5.5、Fable / Mythos 系列。
 * Sonnet 5 不支持。
 */
export function supportsMidConversationSystem(model: string): boolean {
  return /^claude-(opus-(4-8|[5-9])|sonnet-5-5|haiku-5-5|fable-|mythos-)/.test(model);
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
 * 映射消息并安排中途 system 消息的位置。Anthropic 要求它紧跟 user 消息，且是最后一条或后面紧跟 assistant：
 * - 后面紧跟 user 消息的 system：顺延到那一串 user 消息之后（仍在下一个 assistant 之前，语义不变；
 *   只依赖历史本身，追加新消息不会改变已发送部分的排列）；
 * - 前面没有可依附的 user 消息时，转成 user 文本 `"[system] …"`；
 * - 模型不支持时一律转成 user 文本。
 */
function mapMessages(messages: ModelMessage[], model: string): Anthropic.MessageParam[] {
  const native = supportsMidConversationSystem(model);
  const out: Anthropic.MessageParam[] = [];
  let pending: string[] = [];
  const flush = () => {
    for (const text of pending) {
      const prev = out[out.length - 1]?.role;
      out.push(
        prev === "user" || prev === "system"
          ? { role: "system", content: text }
          : systemAsUserText(text),
      );
    }
    pending = [];
  };
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i] as ModelMessage;
    if (m.role === "system") {
      if (!native) {
        out.push(systemAsUserText(m.content));
        continue;
      }
      pending.push(m.content);
      const next = messages[i + 1]?.role;
      if (next !== "user" && next !== "system") flush();
      continue;
    }
    const content =
      m.role === "user"
        ? m.content.map(mapUserBlock).filter((b) => b !== null)
        : m.content.map((b) => mapAssistantBlock(b, model)).filter((b) => b !== null);
    if (content.length > 0) out.push({ role: m.role, content });
    // 顺延的 system 放在这一串 user 消息之后
    if (pending.length > 0 && messages[i + 1]?.role !== "user") flush();
  }
  flush();
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
