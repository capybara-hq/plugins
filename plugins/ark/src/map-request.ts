import {
  type ContentBlock,
  clipMediaName,
  ModelError,
  type ModelMessage,
  type ModelRequest,
  type ProviderOpaque,
} from "@capybara-hq/plugin-sdk";
import type OpenAI from "openai";
import { replaysReasoning } from "./tables.js";

export const PROVIDER = "ark";

/** Request body: the SDK's streaming params plus Ark's extension fields (`thinking`). */
export type ChatBody = OpenAI.Chat.ChatCompletionCreateParamsStreaming & Record<string, unknown>;

type Message = OpenAI.Chat.ChatCompletionMessageParam;
type AssistantMessage = OpenAI.Chat.ChatCompletionAssistantMessageParam & {
  reasoning_content?: string;
  encrypted_content?: string;
};
type Part = OpenAI.Chat.ChatCompletionContentPart;

/**
 * `opaque.data` of a thinking block: the text is `reasoning_content`; `encrypted_content` is the
 * signed thinking newer seed models send once between thinking and answer, to be handed back
 * verbatim on later turns (https://docs.volcengine.com/docs/82379/1298454, live 2026-11-08 on
 * doubao-seed-2-0-lite-260428 and doubao-seed-2-1-lite-260915).
 */
export interface ThinkingOpaque {
  field: "reasoning_content";
  encrypted_content?: string;
}

/** A thinking block is replayed only to the provider and model that produced it. */
function sameOrigin(opaque: ProviderOpaque | undefined, model: string): boolean {
  return opaque?.provider === PROVIDER && opaque.model === model && opaque.data != null;
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

/**
 * Assistant turn: text and tool calls, plus this model's own thinking. `encrypted_content`, when
 * the turn has one, goes back alone (it takes priority over `reasoning_content` per the docs);
 * else the `reasoning_content` text goes back to models that use it (`replaysReasoning`); else
 * the thinking is dropped. Thinking from another model or provider is always dropped whole.
 */
function mapAssistant(blocks: ContentBlock[], req: ModelRequest): AssistantMessage {
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
  const msg: AssistantMessage = {
    role: "assistant",
    content: text === "" && toolCalls.length > 0 ? null : text,
    ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
  };
  const own = blocks.flatMap((b) =>
    b.type === "thinking" && sameOrigin(b.opaque, req.model) ? [b] : [],
  );
  if (own.length === 0) return msg;
  // One signature per turn (the stream emits one thinking block); joining two would break it,
  // so a turn that somehow holds several sends the last
  const encrypted = own
    .map((b) => (b.opaque?.data as Partial<ThinkingOpaque> | undefined)?.encrypted_content)
    .filter((e): e is string => typeof e === "string" && e !== "")
    .at(-1);
  if (encrypted !== undefined) return { ...msg, encrypted_content: encrypted };
  if (replaysReasoning(req.model)) {
    return { ...msg, reasoning_content: own.map((b) => b.text).join("") };
  }
  return msg;
}

type MediaBlock = Extract<ContentBlock, { type: "image" | "document" }>;

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
 * Media (live 2026-11-08): images as `image_url` data URLs (doubao-seed-2-0-lite read a red PNG);
 * PDFs as `file` parts with a data URL (read on three image-input models); `text/*` decoded into a
 * text part with a first line naming the file, as the other providers write it.
 */
function mapMedia(b: MediaBlock): Part {
  const data = base64Of(b);
  if (b.type === "image") {
    return { type: "image_url", image_url: { url: `data:${b.mediaType};base64,${data}` } };
  }
  if (b.mediaType === "application/pdf") {
    const n = b.name ?? "document";
    return {
      type: "file",
      file: {
        filename: clipMediaName(/\.pdf$/i.test(n) ? n : `${n}.pdf`),
        file_data: `data:application/pdf;base64,${data}`,
      },
    };
  }
  const text = Buffer.from(data, "base64").toString("utf8");
  return {
    type: "text",
    text: `[Attached file ${JSON.stringify(b.name ?? "document")} (${b.mediaType})]\n${text}`,
  };
}

/** User message: tool results first (role tool), then one user message for the other blocks. */
function mapUser(content: ContentBlock[]): Message[] {
  const out: Message[] = [];
  const parts: Part[] = [];
  for (const b of content) {
    if (b.type === "tool_result") {
      out.push({ role: "tool", tool_call_id: b.callId, content: b.content });
    } else if (b.type === "text") {
      parts.push({ type: "text", text: b.text });
    } else if (b.type === "image" || b.type === "document") {
      parts.push(mapMedia(b));
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
 * Each message maps from itself and the request-level settings only, so an earlier request's
 * messages are always a prefix of a later one's (append-only history). Mid-conversation system
 * turns go out as `[system] ` user turns: an in-place system message was obeyed in one live probe,
 * which does not prove it stays in position on every hosted model.
 */
function mapMessages(messages: ModelMessage[], req: ModelRequest): Message[] {
  const out: Message[] = [];
  for (const m of messages) {
    if (m.role === "system") out.push({ role: "user", content: `[system] ${m.content}` });
    else if (m.role === "user") out.push(...mapUser(m.content));
    else out.push(mapAssistant(m.content, req));
  }
  return out;
}

/**
 * model-provider@2 request → streaming Chat Completions body. Pure.
 * The budget is `max_completion_tokens` (thinking + answer, live 2026-11-08): `max_tokens` leaves
 * thinking unbounded (a 60-token max_tokens produced 1302 reasoning tokens), so it would not hold
 * the kernel's output budget. The two cannot be sent together.
 */
export function buildRequest(req: ModelRequest): ChatBody {
  const system = req.system.map((s) => s.text).join("\n\n");
  const body: ChatBody = {
    model: req.model,
    messages: [
      ...(system !== "" ? [{ role: "system" as const, content: system }] : []),
      ...mapMessages(req.messages, req),
    ],
    max_completion_tokens: req.maxOutputTokens,
    stream: true,
    stream_options: { include_usage: true },
  };
  if (req.tools.length > 0) {
    body.tools = req.tools.map((tool) => ({
      type: "function",
      function: { name: tool.name, description: tool.description, parameters: tool.inputSchema },
    }));
    if (req.toolChoice === "none") body.tool_choice = "none";
  }
  const { thinking, effort, temperature } = req.params;
  if (thinking === "on" || thinking === "off") {
    body.thinking = { type: thinking === "on" ? "enabled" : "disabled" };
  }
  if (typeof effort === "string" && thinking !== "off") {
    body.reasoning_effort = effort as OpenAI.ReasoningEffort & string;
  }
  if (typeof temperature === "number") body.temperature = temperature;
  return body;
}
