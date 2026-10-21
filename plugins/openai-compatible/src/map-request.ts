import {
  type ContentBlock,
  ModelError,
  type ModelMessage,
  type ModelRequest,
} from "@capybara-hq/plugin-sdk";
import type OpenAI from "openai";
import type { ChatBody, Dialect, ModelTraits } from "./dialects.js";

type Message = OpenAI.Chat.ChatCompletionMessageParam;

/** 一次调用的目标：端点上的原始模型 id、方言、模型属性，以及中途 system 的写法（方言默认，端点可覆盖）。 */
export interface ChatTarget {
  upstreamModel: string;
  dialect: Dialect;
  midConversationSystem: boolean;
  /** 部署配置里该模型的属性（请求级，对所有消息相同）。 */
  model: ModelTraits;
}

type Part = OpenAI.Chat.ChatCompletionContentPart;
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

/** PDF 的 filename：沿用附件名，没有 `.pdf` 后缀时补上（没有名字时为 `document.pdf`）。 */
function pdfFilename(name: string | undefined): string {
  const n = name ?? "document";
  return /\.pdf$/i.test(n) ? n : `${n}.pdf`;
}

/**
 * 媒体块 → 内容片段（各方言的出处见 `dialects.ts`）：图片 `image_url`（data URL）；PDF 用 `file`
 * （只在 `pdfInput` 的方言上，否则内核不该发来，报不可重试的请求错误）；`text/*` 按 UTF-8 解码成文本片段，
 * 开头一行标出文件名与类型（与内核内联文本的写法一致）——Chat Completions 的 `file` 只收 PDF。
 */
function mapMedia(b: MediaBlock, dialect: Dialect): Part {
  const data = base64Of(b);
  if (b.type === "image") {
    return { type: "image_url", image_url: { url: `data:${b.mediaType};base64,${data}` } };
  }
  if (b.mediaType === "application/pdf") {
    if (!dialect.pdfInput) {
      throw new ModelError(
        "invalid_request",
        `The ${dialect.name} endpoint does not accept PDF documents`,
      );
    }
    return {
      type: "file",
      file: { filename: pdfFilename(b.name), file_data: `data:application/pdf;base64,${data}` },
    };
  }
  const text = Buffer.from(data, "base64").toString("utf8");
  return {
    type: "text",
    text: `[Attached file ${JSON.stringify(b.name ?? "document")} (${b.mediaType})]\n${text}`,
  };
}

/**
 * user 消息：工具结果先按块顺序转成 `role: "tool"` 消息（必须紧跟带 tool_calls 的 assistant 消息），
 * 其余块合成一条 user 消息放在其后：只有文本时内容是 `"\n\n"` 连接的字符串（与引入媒体之前逐字节相同），
 * 含媒体时是按块顺序的内容片段数组。只看消息自身。
 */
function mapUser(content: ContentBlock[], dialect: Dialect): Message[] {
  const out: Message[] = [];
  const parts: Part[] = [];
  for (const b of content) {
    if (b.type === "tool_result") {
      out.push({ role: "tool", tool_call_id: b.callId, content: b.content });
    } else if (b.type === "text") {
      parts.push({ type: "text", text: b.text });
    } else if (b.type === "image" || b.type === "document") {
      parts.push(mapMedia(b, dialect));
    }
  }
  if (parts.length === 0) return out;
  const textOnly = parts.every((p) => p.type === "text");
  out.push(
    textOnly
      ? { role: "user", content: parts.map((p) => (p.type === "text" ? p.text : "")).join("\n\n") }
      : { role: "user", content: parts },
  );
  return out;
}

/**
 * 映射消息。每条消息的映射只取决于它自己与请求模型，不看后续消息、不调整顺序，
 * 所以较早请求的 messages 总是较晚请求的前缀（发给模型的历史只追加）。
 */
function mapMessages(messages: ModelMessage[], req: ModelRequest, t: ChatTarget): Message[] {
  const out: Message[] = [];
  for (const m of messages) {
    if (m.role === "system") {
      out.push(
        t.midConversationSystem
          ? { role: "system", content: m.content }
          : { role: "user", content: `[system] ${m.content}` },
      );
    } else if (m.role === "user") {
      out.push(...mapUser(m.content, t.dialect));
    } else {
      out.push(t.dialect.replayAssistant(m.content, req, t.model));
    }
  }
  return out;
}

/** model-provider@2 请求 → Chat Completions 流式请求体。纯函数。 */
export function buildRequest(req: ModelRequest, t: ChatTarget): ChatBody {
  const system = req.system.map((s) => s.text).join("\n\n");
  const body: ChatBody = {
    model: t.upstreamModel,
    // 前缀缓存由服务自动处理（DeepSeek 磁盘缓存、Qwen 隐式缓存、vLLM prefix caching），不打标记
    messages: [
      ...(system !== "" ? [{ role: "system" as const, content: system }] : []),
      ...mapMessages(req.messages, req, t),
    ],
    max_tokens: req.maxOutputTokens,
    stream: true,
    stream_options: { include_usage: true },
  };
  if (req.tools.length > 0) {
    body.tools = req.tools.map((tool) => ({
      type: "function",
      function: { name: tool.name, description: tool.description, parameters: tool.inputSchema },
    }));
    // none：照常声明工具但不得调用（收尾调用）；auto 即默认值，不设置
    if (req.toolChoice === "none") body.tool_choice = "none";
  }
  t.dialect.applyParams(body, req.params, t.model);
  return body;
}
