import {
  type ContentBlock,
  type Effort,
  ModelError,
  type ModelMessage,
  type ModelRequest,
  type ProviderOpaque,
} from "@capybara-hq/plugin-sdk";
import type OpenAI from "openai";

export const PROVIDER = "openai";

/** 请求体（不含 stream 字段；发送时补 `stream: true`）。 */
export type OpenAIParams = Omit<OpenAI.Responses.ResponseCreateParamsStreaming, "stream">;
type InputItem = OpenAI.Responses.ResponseInputItem;

/** 请求映射需要的模型属性（来自部署配置）。 */
export interface ModelTraits {
  reasoning: boolean;
}

/** function_call 的 opaque.data：原始输出项的 id（与 reasoning 项一同回放）。 */
export interface FunctionCallOpaque {
  id: string;
}

/** 只回放给产生它的同一供应商、同一模型。 */
export function sameOrigin(
  opaque: ProviderOpaque | undefined,
  model: string,
): opaque is ProviderOpaque {
  return opaque?.provider === PROVIDER && opaque.model === model && opaque.data != null;
}

/** xhigh / max 统一映射为 high。 */
function mapEffort(e: Effort): "low" | "medium" | "high" {
  return e === "xhigh" || e === "max" ? "high" : e;
}

function serializeArgs(input: unknown, name: string): string {
  try {
    return JSON.stringify(input ?? {});
  } catch (cause) {
    throw new ModelError("invalid_request", `Tool call "${name}" input is not serializable`, {
      cause,
    });
  }
}

function userText(text: string): InputItem {
  return { role: "user", content: [{ type: "input_text", text }] };
}

function mapUserBlock(b: ContentBlock): InputItem | null {
  switch (b.type) {
    case "text":
      return userText(b.text);
    case "tool_result":
      return { type: "function_call_output", call_id: b.callId, output: b.content };
    default:
      return null;
  }
}

function mapAssistantBlock(b: ContentBlock, model: string): InputItem | null {
  switch (b.type) {
    case "text":
      // 不带输出项 id：没有对应的 reasoning 项时带 id 会被拒绝
      return {
        role: "assistant",
        content: [{ type: "output_text", text: b.text }],
      } as unknown as InputItem;
    case "thinking":
      // reasoning 项（含 encrypted_content）只原样回放给产生它的同一模型
      return sameOrigin(b.opaque, model) ? (b.opaque.data as InputItem) : null;
    case "tool_call": {
      const id = sameOrigin(b.opaque, model) ? (b.opaque.data as FunctionCallOpaque).id : undefined;
      return {
        type: "function_call",
        ...(typeof id === "string" ? { id } : {}),
        call_id: b.id,
        name: b.name,
        arguments: serializeArgs(b.input, b.name),
      };
    }
    default:
      return null;
  }
}

/**
 * 映射消息。每条消息的映射只取决于它自己与请求模型，不看后续消息、不调整顺序，
 * 所以较早请求的 input 总是较晚请求的前缀（发给模型的历史只追加）。
 * 对话中途的 system 消息在原位置转成 `developer` 输入项。
 */
function mapMessages(messages: ModelMessage[], model: string): InputItem[] {
  const out: InputItem[] = [];
  for (const m of messages) {
    if (m.role === "system") {
      out.push({ role: "developer", content: [{ type: "input_text", text: m.content }] });
      continue;
    }
    for (const b of m.content) {
      const item = m.role === "user" ? mapUserBlock(b) : mapAssistantBlock(b, model);
      if (item !== null) out.push(item);
    }
  }
  return out;
}

/** model-provider@1 请求 → OpenAI Responses API 请求。纯函数。 */
export function buildRequest(req: ModelRequest, traits: ModelTraits): OpenAIParams {
  const params: OpenAIParams = {
    model: req.model,
    input: mapMessages(req.messages, req.model),
    max_output_tokens: req.maxOutputTokens,
    // 不在服务端保存；推理状态以 encrypted_content 随历史回放
    store: false,
  };
  // 缓存是自动的（按前缀），不需要标记
  const instructions = req.system.map((s) => s.text).join("\n\n");
  if (instructions !== "") params.instructions = instructions;
  if (traits.reasoning) {
    params.include = ["reasoning.encrypted_content"];
    params.reasoning = {
      ...(req.effort !== undefined ? { effort: mapEffort(req.effort) } : {}),
      summary: "auto",
    };
  }
  if (req.tools.length > 0) {
    params.tools = req.tools.map((t) => ({
      type: "function",
      name: t.name,
      description: t.description,
      parameters: t.inputSchema,
      strict: false,
    }));
  }
  return params;
}
