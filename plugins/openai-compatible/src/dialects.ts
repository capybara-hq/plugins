import {
  type ContentBlock,
  ModelError,
  type ModelParameter,
  type ModelRequest,
  type ModelUsage,
  type ParamValue,
  type ProviderOpaque,
} from "@capybara-hq/plugin-sdk";
import type OpenAI from "openai";

/**
 * 方言预设：各家 Chat Completions 兼容服务的差异只放在这里（纯数据 + 映射函数，无状态）。
 * 每个字段都按官方文档核实过，出处见各方言的注释；查不到的字段不实现。
 */

export const PROVIDER = "openai-compatible";

export type DialectName = "generic" | "deepseek" | "qwen" | "ark";

/** 请求体：SDK 的流式参数，加上方言的扩展字段（如 DeepSeek `thinking`、Qwen `enable_thinking`）。 */
export type ChatBody = OpenAI.Chat.ChatCompletionCreateParamsStreaming & Record<string, unknown>;

/** 回放的 assistant 消息；DeepSeek 额外带 `reasoning_content`。 */
export type AssistantMessage = OpenAI.Chat.ChatCompletionAssistantMessageParam & {
  reasoning_content?: string;
};

/** 流式 chunk 的 delta；思考字段不在 SDK 类型里。 */
export type ChunkDelta = OpenAI.Chat.ChatCompletionChunk.Choice.Delta & {
  reasoning_content?: string | null;
};

/** 原生用量：OpenAI 风格字段 + 方言字段（DeepSeek `prompt_cache_hit_tokens`、Qwen `cache_creation_input_tokens`）。 */
export type RawUsage = OpenAI.CompletionUsage & {
  prompt_cache_hit_tokens?: number;
  prompt_cache_miss_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number; cache_creation_input_tokens?: number };
};

/** 方言需要的模型属性（来自部署配置）。 */
export interface ModelTraits {
  reasoning: boolean;
  maxOutputTokens: number;
}

export interface Dialect {
  name: DialectName;
  /** 中途 system 是否以原位置的 `role: "system"` 发送；否则转成 `[system] ` 开头的 user 文本。端点可覆盖。 */
  midConversationSystem: boolean;
  /** 未配置 `caching` 时的默认值（服务是否有自动前缀缓存）。 */
  caching: boolean;
  /** 该模型声明的参数（须通过 `assertValidDeclarations`）。 */
  parameters(model: ModelTraits): ModelParameter[];
  /**
   * 把已处理过的参数写进请求体。`maxOutputTokens` 已由内核折算进 `req.maxOutputTokens`，这里不处理。
   * `model` 是本次请求模型的属性（如非推理模型需要显式关闭服务端默认开启的思考）。
   */
  applyParams(body: ChatBody, params: Record<string, ParamValue>, model: ModelTraits): void;
  /** 从一个 delta 读出文本 / 思考增量。 */
  readDelta(delta: ChunkDelta): { text?: string; reasoning?: string };
  /**
   * assistant 消息的回放；只看消息自身与请求级的设定（模型及其属性、是否带工具、参数），不看其他消息（只追加）。
   */
  replayAssistant(blocks: ContentBlock[], req: ModelRequest, model: ModelTraits): AssistantMessage;
  usage(raw: RawUsage | null | undefined): ModelUsage;
}

/** thinking 块的 opaque.data：标明思考取自 `reasoning_content`。 */
export interface ThinkingOpaque {
  field: "reasoning_content";
}

/** 只回放给产生它的同一供应商、同一模型（含端点名的对外 id）。 */
export function sameOrigin(
  opaque: ProviderOpaque | undefined,
  model: string,
): opaque is ProviderOpaque {
  return opaque?.provider === PROVIDER && opaque.model === model && opaque.data != null;
}

// ---- 参数声明 ----

const temperature = (max: number, def?: number): ModelParameter => ({
  key: "temperature",
  standard: "temperature",
  schema: { type: "number", minimum: 0, maximum: max },
  ...(def !== undefined ? { default: def } : {}),
  label: { zh: "温度", en: "Temperature" },
  description: {
    zh: "采样随机性，越高越发散",
    en: "Sampling randomness; higher is more diverse",
  },
});

const maxOutput = (m: ModelTraits): ModelParameter => ({
  key: "maxOutputTokens",
  standard: "maxOutputTokens",
  schema: { type: "integer", minimum: 1, maximum: m.maxOutputTokens },
  label: { zh: "最大输出 token", en: "Max output tokens" },
});

const thinkingKnob = (def?: string): ModelParameter => ({
  key: "thinking",
  standard: "thinking",
  schema: { type: "string", enum: ["off", "on"] },
  ...(def !== undefined ? { default: def } : {}),
  label: { zh: "思考模式", en: "Thinking" },
  description: { zh: "是否先思考再回答", en: "Whether the model thinks before answering" },
});

// ---- 共用映射 ----

function serializeArgs(input: unknown, name: string): string {
  try {
    return JSON.stringify(input ?? {});
  } catch (cause) {
    throw new ModelError("invalid_request", `Tool call "${name}" input is not serializable`, {
      cause,
    });
  }
}

/** 文本与工具调用 → assistant 消息（思考块由方言决定是否回放）。 */
function baseAssistant(blocks: ContentBlock[]): AssistantMessage {
  let text = "";
  const toolCalls: OpenAI.Chat.ChatCompletionMessageFunctionToolCall[] = [];
  for (const b of blocks) {
    if (b.type === "text") text += b.text;
    else if (b.type === "tool_call") {
      toolCalls.push({
        id: b.id,
        type: "function",
        function: { name: b.name, arguments: serializeArgs(b.input, b.name) },
      });
    }
  }
  return {
    role: "assistant",
    // 只有工具调用时 content 为 null（OpenAI 约定）；否则总带字符串，避免空 assistant 消息被拒
    content: text === "" && toolCalls.length > 0 ? null : text,
    ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
  };
}

const nonEmpty = (v: unknown): v is string => typeof v === "string" && v !== "";

/** 只读 `delta.content`。 */
function readText(d: ChunkDelta): { text?: string } {
  return nonEmpty(d.content) ? { text: d.content } : {};
}

/** `delta.content` 与 `delta.reasoning_content`（DeepSeek、Qwen 的思考增量）。 */
function readTextAndReasoning(d: ChunkDelta): { text?: string; reasoning?: string } {
  return {
    ...readText(d),
    ...(nonEmpty(d.reasoning_content) ? { reasoning: d.reasoning_content } : {}),
  };
}
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** OpenAI 风格用量：`prompt_tokens` 含缓存命中（`prompt_tokens_details.cached_tokens`），先减掉。 */
function openaiStyleUsage(raw: RawUsage | null | undefined): ModelUsage {
  const total = num(raw?.prompt_tokens);
  const cached = num(raw?.prompt_tokens_details?.cached_tokens);
  return {
    inputTokens: Math.max(0, total - cached),
    outputTokens: num(raw?.completion_tokens),
    cacheReadTokens: cached,
    cacheWriteTokens: 0,
  };
}

// ---- 方言 ----

/** 通用：标准旋钮只有 temperature、maxOutputTokens；不处理 `reasoning_content`。 */
const generic: Dialect = {
  name: "generic",
  // 许多开源模型的 chat template（如 Qwen3）在 system 不在开头时直接报错，默认转成 user 文本；端点可改
  midConversationSystem: false,
  caching: false,
  parameters: (m) => [temperature(2), maxOutput(m)],
  applyParams(body, params) {
    if (typeof params.temperature === "number") body.temperature = params.temperature;
  },
  readDelta: readText,
  replayAssistant: (blocks) => baseAssistant(blocks),
  usage: openaiStyleUsage,
};

/**
 * DeepSeek（https://api-docs.deepseek.com/api/create-chat-completion ，
 * https://api-docs.deepseek.com/guides/thinking_mode ，2026-10 核实）：
 * - `thinking: { type: "enabled" | "disabled" }`，默认 enabled；`reasoning_effort: low|high|max`，默认 high；
 *   部署配置为 `reasoning: false` 的模型不声明思考旋钮，请求总是发 `thinking: { type: "disabled" }`
 *   （否则服务端按默认开启思考，而界面按非推理模型隐藏思考）；
 * - `temperature` 0–2，默认 1（思考模式下无效）；
 * - 思考增量在 `delta.reasoning_content`；
 * - 用量 `prompt_tokens = prompt_cache_hit_tokens + prompt_cache_miss_tokens`，无缓存写入计数；
 * - 回放：带 `tools` 的请求必须把之前每一轮的 `reasoning_content` 原样带回，否则 400；不带 tools 时
 *   带回会被忽略。所以同一端点同一模型产出的思考块总是作为 `reasoning_content` 回放（与较早的
 *   deepseek-reasoner「带回即 400」相反；该模型名已于 2026-07-24 下线）。
 */
const deepseek: Dialect = {
  name: "deepseek",
  // 接口的 messages 不限制 system 的位置
  midConversationSystem: true,
  // 磁盘缓存自动生效
  caching: true,
  parameters: (m) => [
    ...(m.reasoning
      ? [
          thinkingKnob("on"),
          {
            key: "effort",
            standard: "effort" as const,
            schema: { type: "string" as const, enum: ["low", "high", "max"] },
            default: "high",
            label: { zh: "思考深度", en: "Effort" },
          },
        ]
      : []),
    temperature(2, 1),
    maxOutput(m),
  ],
  applyParams(body, params, model) {
    if (!model.reasoning) {
      body.thinking = { type: "disabled" };
    } else if (params.thinking === "on" || params.thinking === "off") {
      body.thinking = { type: params.thinking === "on" ? "enabled" : "disabled" };
    }
    if (typeof params.effort === "string" && params.thinking !== "off") {
      body.reasoning_effort = params.effort as OpenAI.ReasoningEffort & string;
    }
    if (typeof params.temperature === "number") body.temperature = params.temperature;
  },
  readDelta: readTextAndReasoning,
  replayAssistant(blocks, req, model) {
    const msg = baseAssistant(blocks);
    // 其他模型 / 供应商的思考块不回放
    const own = blocks.filter((b) => b.type === "thinking" && sameOrigin(b.opaque, req.model));
    if (own.length > 0) {
      return {
        ...msg,
        reasoning_content: own.map((b) => (b.type === "thinking" ? b.text : "")).join(""),
      };
    }
    // 带 tools 的思考模式请求要求每个历史 assistant 回合都带 reasoning_content（否则 400，不可重试）：
    // 别的模型产出的回合（兜底 / 换模型）、关闭思考时产出的回合没有本模型的思考，补空串。
    // 非推理模型的请求总是关闭思考（见 applyParams），不补。
    // 只取决于本条消息与请求级设定，仍然只追加。DeepSeek 不再要求时（文档变更）可删除。
    if (model.reasoning && req.tools.length > 0 && req.params.thinking !== "off") {
      return { ...msg, reasoning_content: "" };
    }
    return msg;
  },
  usage(raw) {
    const total = num(raw?.prompt_tokens);
    const hit = num(raw?.prompt_cache_hit_tokens ?? raw?.prompt_tokens_details?.cached_tokens);
    return {
      inputTokens: Math.max(0, total - hit),
      outputTokens: num(raw?.completion_tokens),
      cacheReadTokens: hit,
      cacheWriteTokens: 0,
    };
  },
};

/**
 * Qwen / 阿里云百炼 OpenAI 兼容接口（https://www.alibabacloud.com/help/en/model-studio/deep-thinking ，
 * https://www.alibabacloud.com/help/en/model-studio/context-cache ，2026-10 核实）：
 * - `enable_thinking: boolean`；默认值因模型而异（Qwen3 商业版默认关，Qwen3.5 及以后默认开），所以 thinking 旋钮不给默认值；
 * - 思考增量在 `delta.reasoning_content`；历史里的 `reasoning_content` 只在 `preserve_thinking` 时被读取，默认不回传；
 * - 用量：`prompt_tokens` 含 `prompt_tokens_details.cached_tokens`（命中）与 `cache_creation_input_tokens`（显式缓存写入）；
 * - temperature 默认值因模型而异，不给默认值；
 * - system 消息的位置规则文档未写明，按保守做法转成 user 文本（端点可改）。
 */
const qwen: Dialect = {
  name: "qwen",
  midConversationSystem: false,
  // 隐式缓存自动生效（不保证命中）
  caching: true,
  parameters: (m) => [...(m.reasoning ? [thinkingKnob()] : []), temperature(2), maxOutput(m)],
  applyParams(body, params) {
    if (params.thinking === "on" || params.thinking === "off") {
      body.enable_thinking = params.thinking === "on";
    }
    if (typeof params.temperature === "number") body.temperature = params.temperature;
  },
  readDelta: readTextAndReasoning,
  replayAssistant: (blocks) => baseAssistant(blocks),
  usage(raw) {
    const total = num(raw?.prompt_tokens);
    const cached = num(raw?.prompt_tokens_details?.cached_tokens);
    const created = num(raw?.prompt_tokens_details?.cache_creation_input_tokens);
    return {
      inputTokens: Math.max(0, total - cached - created),
      outputTokens: num(raw?.completion_tokens),
      cacheReadTokens: cached,
      cacheWriteTokens: created,
    };
  },
};

/**
 * 火山方舟 Ark（Chat API https://www.volcengine.com/docs/82379/1298454 ，
 * 深度思考 https://www.volcengine.com/docs/82379/1449737 ，2026-10-19 核实；baseUrl
 * `https://ark.cn-beijing.volces.com/api/v3`）：
 * - `thinking: { type: "enabled" | "disabled" | "auto" }`；文档写明默认值与支持情况因模型而异、未给出统一默认，
 *   所以 thinking 旋钮不给默认值，只映射 on / off（`auto` 不暴露）；未设置时不发该字段；
 *   部署配置为 `reasoning: false` 的模型不声明旋钮也不发 `thinking`（不支持的模型发该字段可能被拒，保守处理）；
 * - 思考增量在 `delta.reasoning_content`（seed 系列、deepseek-v4-pro / flash 支持）；
 * - 用量：`prompt_tokens_details.cached_tokens` 为命中的输入 token，`prompt_tokens` 含之；无缓存写入计数；
 * - `reasoning_effort`（none…max）的支持模型与默认值文档未能确认，不实现；temperature 默认值未确认，不给默认值；
 * - 历史 `reasoning_content` 的回放规则、system 消息的位置规则未能确认，保守处理：不回放思考，
 *   中途 system 转成 user 文本（端点可改）；是否有自动缓存未确认，`caching` 默认 false。
 */
const ark: Dialect = {
  name: "ark",
  midConversationSystem: false,
  caching: false,
  parameters: (m) => [...(m.reasoning ? [thinkingKnob()] : []), temperature(2), maxOutput(m)],
  applyParams(body, params) {
    if (params.thinking === "on" || params.thinking === "off") {
      body.thinking = { type: params.thinking === "on" ? "enabled" : "disabled" };
    }
    if (typeof params.temperature === "number") body.temperature = params.temperature;
  },
  readDelta: readTextAndReasoning,
  replayAssistant: (blocks) => baseAssistant(blocks),
  usage: openaiStyleUsage,
};

export const DIALECTS: Readonly<Record<DialectName, Dialect>> = { generic, deepseek, qwen, ark };
