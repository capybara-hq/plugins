import {
  type ContentBlock,
  clipMediaName,
  ModelError,
  type ModelMessage,
  type ModelRequest,
} from "@capybara-hq/plugin-sdk";
import type OpenAI from "openai";
import { conversationCacheKey } from "./cache-key.js";
import type { ChatBody, Dialect, ModelTraits } from "./dialects.js";

type Message = OpenAI.Chat.ChatCompletionMessageParam;

/** 一次调用的目标：端点上的原始模型 id、方言、模型属性，以及中途 system 的写法（方言默认，端点可覆盖）。 */
export interface ChatTarget {
  upstreamModel: string;
  dialect: Dialect;
  midConversationSystem: boolean;
  /** 部署配置里该模型的属性（请求级，对所有消息相同）。 */
  model: ModelTraits;
  /** The org the call is made for (part of the `prompt_cache_key` hash). */
  orgId?: string;
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

/**
 * PDF 的 filename：沿用附件名，没有 `.pdf` 后缀时补上（没有名字时为 `document.pdf`）；过长的按
 * `clipMediaName` 截短（补后缀之后再截，保留 `.pdf`）。
 */
function pdfFilename(name: string | undefined): string {
  const n = name ?? "document";
  return clipMediaName(/\.pdf$/i.test(n) ? n : `${n}.pdf`);
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

const EPHEMERAL = { type: "ephemeral" } as const;

/** A text part with DashScope's cache marker (not in the SDK's types). */
type MarkedText = OpenAI.Chat.ChatCompletionContentPartText & { cache_control?: typeof EPHEMERAL };

/**
 * The system prompt: one string (blocks joined by a blank line), or, with DashScope's explicit
 * cache, one text part per block with the marker on the last block marked `cache: true`.
 */
function systemMessage(req: ModelRequest, t: ChatTarget): Message | null {
  if (req.system.length === 0) return null;
  if (t.dialect.cacheFields !== "dashscope") {
    const text = req.system.map((s) => s.text).join("\n\n");
    return text === "" ? null : { role: "system", content: text };
  }
  const lastCached = req.system.map((s) => s.cache).lastIndexOf(true);
  const content: MarkedText[] = req.system.map((s, i) => ({
    type: "text",
    text: s.text,
    ...(i === lastCached ? { cache_control: EPHEMERAL } : {}),
  }));
  return { role: "system", content } as Message;
}

/**
 * DashScope's history marker on the last content block of the last message, as bailian's native
 * mapping does (see plugins/bailian/src/map-request.ts for the evidence): each turn it moves to
 * the new last block, the previous turn's entry sits one block before the new messages, and the
 * cache matches on the rendered prompt, so a string content that becomes one marked text part
 * still hits. Only text is marked; an empty or non-text last block gets none.
 */
function markLastBlock(messages: Message[]): void {
  const last = messages[messages.length - 1] as { role: string; content?: unknown } | undefined;
  if (last === undefined || last.role === "system") return;
  if (typeof last.content === "string") {
    if (last.content !== "") {
      last.content = [{ type: "text", text: last.content, cache_control: EPHEMERAL }];
    }
    return;
  }
  if (!Array.isArray(last.content)) return;
  const i = last.content.length - 1;
  const part = last.content[i] as { type?: string; text?: string } | undefined;
  if (part?.type !== "text" || part.text === "") return;
  last.content[i] = { ...part, cache_control: EPHEMERAL };
}

/**
 * Whether the reply's tool calls are dropped: `toolChoice: "none"` on a dialect that omits it
 * (`Dialect.toolChoiceNone`). The request keeps the default (auto) and the stream mapping
 * guarantees the contract: no tool_call events or blocks, only the text, stop reason end_turn.
 */
export function toolCallsDropped(req: ModelRequest, t: ChatTarget): boolean {
  return req.toolChoice === "none" && t.dialect.toolChoiceNone === "omit";
}

/** model-provider@2 请求 → Chat Completions 流式请求体。纯函数。 */
export function buildRequest(req: ModelRequest, t: ChatTarget): ChatBody {
  const system = systemMessage(req, t);
  const history = mapMessages(req.messages, req, t);
  // DeepSeek's disk cache and vLLM prefix caching need nothing; Qwen and Ark: see cacheFields
  if (t.dialect.cacheFields === "dashscope") markLastBlock(history);
  const body: ChatBody = {
    model: t.upstreamModel,
    messages: [...(system !== null ? [system] : []), ...history],
    max_tokens: req.maxOutputTokens,
    stream: true,
    stream_options: { include_usage: true },
  };
  if (t.dialect.cacheFields === "routing-key") {
    body.prompt_cache_key = conversationCacheKey(req, t.orgId);
  }
  if (req.tools.length > 0) {
    body.tools = req.tools.map((tool) => ({
      type: "function",
      function: { name: tool.name, description: tool.description, parameters: tool.inputSchema },
    }));
    // none: the tools stay declared but must not be called; auto is the default and not sent.
    // A dialect whose service drops the tools under "none" omits it: see toolCallsDropped
    if (req.toolChoice === "none" && t.dialect.toolChoiceNone === "send") body.tool_choice = "none";
  }
  t.dialect.applyParams(body, req.params, t.model);
  return body;
}
