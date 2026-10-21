import {
  type ContentBlock,
  clipMediaName,
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
  /**
   * 部署配置："off" 时一律不请求推理摘要（未完成组织验证的账号请求摘要会被拒绝，此时也不声明 thinking 旋钮）。
   * "auto" 时为默认值，请求带 `params.thinking` 时以它为准（`summarized` 请求摘要，`on` 不请求）。
   */
  reasoningSummary: "auto" | "off";
}

/** function_call 的 opaque.data：原始输出项的 id（与 reasoning 项一同回放）。 */
export interface FunctionCallOpaque {
  id: string;
}

/**
 * text 块的 opaque.data：产出它的 message 输出项的 id（与 phase）。只在它跟在回放的 reasoning 项之后时
 * 带 id 回放（推理模型要求 reasoning 项后面紧跟它产出的那个输出项）。
 */
export interface MessageOpaque {
  id: string;
  phase?: "commentary" | "final_answer";
  /** 原输出项的状态，只在不是 completed（如被截断的 incomplete）时记录。 */
  status?: "in_progress" | "incomplete";
}

/** 只回放给产生它的同一供应商、同一模型。 */
export function sameOrigin(
  opaque: ProviderOpaque | undefined,
  model: string,
): opaque is ProviderOpaque {
  return opaque?.provider === PROVIDER && opaque.model === model && opaque.data != null;
}

/**
 * 契约的 effort 原样传给原生 `reasoning.effort`（R40）：SDK 的 ReasoningEffort 接受全部五个值，
 * 这里的类型标注保证 SDK 收窄取值时编译失败，届时只为被拒绝的值补映射。
 */
function mapEffort(e: Effort): NonNullable<OpenAI.ReasoningEffort> {
  return e;
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
 * PDF 的 filename：沿用附件名，没有 `.pdf` 后缀时补上（没有名字时为 `document.pdf`）；过长的按
 * `clipMediaName` 截短（补后缀之后再截，保留 `.pdf`）。
 */
function pdfFilename(name: string | undefined): string {
  const n = name ?? "document";
  return clipMediaName(/\.pdf$/i.test(n) ? n : `${n}.pdf`);
}

/**
 * 媒体块 → Responses API 输入项（https://developers.openai.com/api/docs/guides/images-vision ，
 * https://developers.openai.com/api/docs/guides/pdf-files ，2026-10-21 核实）：
 * - 图片：`input_image`，`image_url` 为 `data:<type>;base64,…`，`detail: "auto"`（即默认值；SDK 类型要求给出）；
 *   png / jpeg / webp / 非动图 gif；单次请求总负载 512 MB、最多 1500 张；
 * - PDF：`input_file`，`file_data` 为 `data:application/pdf;base64,…`，带 `filename`；单个文件与单次请求
 *   合计都不超过 50 MB；页面图像需要支持视觉的模型（gpt-4o 及以后）；
 * - `text/*`：按 UTF-8 解码成 `input_text`，开头一行标出文件名与类型（与内核内联文本的写法一致）。
 *   Responses API 的 `input_file` 也收纯文本类文件，但类型按文件名后缀识别，附件名不一定带后缀；
 *   内联文本行为确定，不依赖文件名。
 * 每个块一个 user 输入项（与文本块相同），映射只看块自身。
 */
function mapMedia(b: MediaBlock): InputItem {
  const data = base64Of(b);
  if (b.type === "image") {
    return {
      role: "user",
      content: [
        { type: "input_image", image_url: `data:${b.mediaType};base64,${data}`, detail: "auto" },
      ],
    };
  }
  if (b.mediaType === "application/pdf") {
    return {
      role: "user",
      content: [
        {
          type: "input_file",
          filename: pdfFilename(b.name),
          file_data: `data:application/pdf;base64,${data}`,
        },
      ],
    };
  }
  const text = Buffer.from(data, "base64").toString("utf8");
  return userText(
    `[Attached file ${JSON.stringify(b.name ?? "document")} (${b.mediaType})]\n${text}`,
  );
}

function mapUserBlock(b: ContentBlock): InputItem | null {
  switch (b.type) {
    case "text":
      return userText(b.text);
    case "image":
    case "document":
      return mapMedia(b);
    case "tool_result":
      return { type: "function_call_output", call_id: b.callId, output: b.content };
    default:
      return null;
  }
}

/** assistant 消息只回放文本、推理项与工具调用；媒体块只出现在 user 消息里，出现在这里也不发。 */
function mapAssistantBlock(
  b: ContentBlock,
  model: string,
  afterReasoning: boolean,
): InputItem | null {
  switch (b.type) {
    case "text": {
      // 跟在本消息里回放的 reasoning 项之后（同一模型）：按原 message 输出项（带 id）回放，
      // 否则 reasoning 项缺少它要求的后继项。其余情况不带 id：没有对应的 reasoning 项时带 id 会被拒绝。
      const data = sameOrigin(b.opaque, model) ? (b.opaque.data as Partial<MessageOpaque>) : null;
      if (afterReasoning && typeof data?.id === "string") {
        const item: OpenAI.Responses.ResponseOutputMessage = {
          type: "message",
          id: data.id,
          role: "assistant",
          status: data.status ?? "completed",
          ...(data.phase !== undefined ? { phase: data.phase } : {}),
          content: [{ type: "output_text", text: b.text, annotations: [] }],
        };
        return item;
      }
      return {
        role: "assistant",
        content: [{ type: "output_text", text: b.text }],
      } as unknown as InputItem;
    }
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
    // 本条 assistant 消息里是否已回放过 reasoning 项（只看消息自身，映射仍与后续消息无关）
    let afterReasoning = false;
    for (const b of m.content) {
      const item =
        m.role === "user" ? mapUserBlock(b) : mapAssistantBlock(b, model, afterReasoning);
      if (item === null) continue;
      if (b.type === "thinking") afterReasoning = true;
      out.push(item);
    }
  }
  return out;
}

/** 是否请求推理摘要：部署为 off 时从不请求；否则 `params.thinking` 优先（summarized 请求、on 不请求），未设置时请求。 */
function wantsSummary(req: ModelRequest, traits: ModelTraits): boolean {
  if (traits.reasoningSummary === "off") return false;
  const t = req.params.thinking;
  if (t === "summarized") return true;
  return t !== "on";
}

/** model-provider@2 请求 → OpenAI Responses API 请求。纯函数。非推理模型忽略 effort / thinking。 */
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
    const effort = req.params.effort;
    const reasoning: OpenAI.Reasoning = {
      ...(typeof effort === "string" ? { effort: mapEffort(effort as Effort) } : {}),
      ...(wantsSummary(req, traits) ? { summary: "auto" as const } : {}),
    };
    if (Object.keys(reasoning).length > 0) params.reasoning = reasoning;
  }
  if (req.tools.length > 0) {
    params.tools = req.tools.map((t) => ({
      type: "function",
      name: t.name,
      description: t.description,
      parameters: t.inputSchema,
      strict: false,
    }));
    // none：照常声明工具但不得调用（收尾调用）；auto 即默认值，不设置
    if (req.toolChoice === "none") params.tool_choice = "none";
  }
  return params;
}
