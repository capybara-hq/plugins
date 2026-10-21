import type Anthropic from "@anthropic-ai/sdk";
import {
  type ContentBlock,
  type Effort,
  ModelError,
  type ModelMessage,
  type ModelRequest,
} from "@capybara-hq/plugin-sdk";

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

type MediaBlock = Extract<ContentBlock, { type: "image" | "document" }>;

/** 媒体块的 base64 数据。内核只发 `base64`；收到 `ref` 是内核的缺陷，按不可重试的请求错误报出。 */
function base64Of(b: MediaBlock): string {
  if (b.source.kind !== "base64") {
    throw new ModelError(
      "invalid_request",
      `The ${b.type} block has an unresolved attachment reference; the kernel must send base64 data`,
    );
  }
  return b.source.data;
}

/**
 * 媒体块 → Messages API 原生块（https://platform.claude.com/docs/en/build-with-claude/vision ，
 * https://platform.claude.com/docs/en/build-with-claude/pdf-support ，
 * https://platform.claude.com/docs/en/build-with-claude/citations ，2026-10-21 核实）：
 * - 图片：`{type: "image", source: {type: "base64", media_type, data}}`，jpeg / png / gif / webp；
 *   直连 API 单张 base64 不超过 10 MB、8000×8000 px，单次请求不超过 32 MB；
 * - PDF：`{type: "document", source: {type: "base64", media_type: "application/pdf", data}}`，所有在售模型
 *   都支持（是否支持以 Models API 的 `pdf_input` 为准）；单次请求 32 MB、最多 600 页（上下文窗口不足 1M 的
 *   模型 100 页）；
 * - `text/*`：纯文本文档 `{type: "document", source: {type: "text", media_type: "text/plain", data}}`，
 *   markdown / csv 也按 text/plain 发（API 的纯文本源只认 text/plain），字节按 UTF-8 解码；
 * - 有文件名时带 `title`（模型可见，便于在回答里指代）。
 */
function mapMedia(b: MediaBlock): Anthropic.ContentBlockParam {
  const data = base64Of(b);
  if (b.type === "image") {
    return { type: "image", source: { type: "base64", media_type: b.mediaType, data } };
  }
  const title = b.name !== undefined ? { title: b.name } : {};
  if (b.mediaType === "application/pdf") {
    return {
      type: "document",
      source: { type: "base64", media_type: "application/pdf", data },
      ...title,
    };
  }
  const text = Buffer.from(data, "base64").toString("utf8");
  return {
    type: "document",
    source: { type: "text", media_type: "text/plain", data: text },
    ...title,
  };
}

function mapUserBlock(b: ContentBlock): Anthropic.ContentBlockParam | null {
  switch (b.type) {
    case "text":
      return { type: "text", text: b.text };
    case "image":
    case "document":
      return mapMedia(b);
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

/** assistant 消息只回放文本、思考与工具调用；媒体块只出现在 user 消息里，出现在这里也不发。 */
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

/** 一次请求最多的缓存断点数（API 限制）。 */
const MAX_CACHE_BREAKPOINTS = 4;

/**
 * model-provider@2 请求 → Anthropic Messages API 请求。纯函数。
 * `thinking`：模型支持 adaptive 思考时为 true（默认）；false 时不发 thinking 参数（不发 disabled），
 * 也忽略 `params.thinking`。参数映射：`params.thinking` 为 `on` 时 `display: "omitted"`，其余（含未设置）
 * 为 `display: "summarized"`；`params.effort` → `output_config.effort`。
 */
export function buildRequest(
  req: ModelRequest,
  opts: { serverFallbacks: ServerFallbacks; thinking?: boolean },
): BuiltRequest {
  const params: AnthropicParams = {
    model: req.model,
    max_tokens: req.maxOutputTokens,
    messages: mapMessages(req.messages, req.model),
  };
  if (opts.thinking !== false) {
    // 当前模型默认 display: "omitted"（思考文本为空）；summarized 返回推理摘要供界面流式展示，计费不变（R37）。
    // 旋钮取 on 时按 API 默认的 omitted 发送（显式写出，不依赖默认值）
    const display = req.params.thinking === "on" ? "omitted" : "summarized";
    params.thinking = { type: "adaptive", display };
  }
  let breakpoints = 0;
  if (req.system.length > 0) {
    params.system = req.system.map((s) => {
      if (!s.cache) return { type: "text", text: s.text };
      breakpoints++;
      return { type: "text", text: s.text, cache_control: { type: "ephemeral" } };
    });
  }
  // 历史缓存：用顶层自动 cache_control（API 把断点放在最后一个可缓存的块上），而不是给最后一条消息的
  // 最后一个块加 cache_control——后者在下一轮会移到新的末尾块，已发送的消息字节随之改变，
  // 违反「发给模型的历史只追加」（较早请求的 messages 必须是较晚请求的逐字节前缀）。
  // 顶层断点也占用一个名额：system 已用满 4 个时不加。
  if (params.messages.length > 0 && breakpoints < MAX_CACHE_BREAKPOINTS) {
    params.cache_control = { type: "ephemeral" };
  }
  const effort = req.params.effort;
  // 取值已由内核按声明（Models API 给出的档位）处理过
  if (typeof effort === "string") params.output_config = { effort: effort as Effort };
  if (req.tools.length > 0) {
    params.tools = req.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
      eager_input_streaming: true,
    }));
    // 只映射 none（收尾调用：照常声明工具，历史里有 tool_use 时 API 要求声明，但不得调用）；
    // auto 即默认值，不设置。any / tool 在当前模型上会 400，内核不使用。
    if (req.toolChoice === "none") params.tool_choice = { type: "none" };
  }
  const beta =
    opts.serverFallbacks === "default" && supportsServerFallback(req.model)
      ? { betas: [SERVER_FALLBACK_BETA], fallbacks: "default" as const }
      : null;
  return { params, beta };
}
