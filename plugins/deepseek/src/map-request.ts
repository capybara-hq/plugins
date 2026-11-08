import {
  type ContentBlock,
  ModelError,
  type ModelMessage,
  type ModelRequest,
  type ProviderOpaque,
} from "@capybara-hq/plugin-sdk";
import type OpenAI from "openai";

export const PROVIDER = "deepseek";

/** Request body: the SDK's streaming params plus DeepSeek's extension fields. */
export type ChatBody = OpenAI.Chat.ChatCompletionCreateParamsStreaming & Record<string, unknown>;

type Message = OpenAI.Chat.ChatCompletionMessageParam;
type AssistantMessage = OpenAI.Chat.ChatCompletionAssistantMessageParam & {
  reasoning_content?: string;
};
type Part = OpenAI.Chat.ChatCompletionContentPart;

/** `opaque.data` of a thinking block: the thinking is the `reasoning_content` field. */
export interface ThinkingOpaque {
  field: "reasoning_content";
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

/** Thinking is on unless the call turns it off (the API default is enabled). */
export const thinkingOn = (req: ModelRequest): boolean => req.params.thinking !== "off";

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
  const own = blocks.filter((b) => b.type === "thinking" && sameOrigin(b.opaque, req.model));
  if (own.length > 0) {
    return {
      ...msg,
      reasoning_content: own.map((b) => (b.type === "thinking" ? b.text : "")).join(""),
    };
  }
  // A thinking-mode request with tools needs reasoning_content on every history assistant turn
  // (else a non-retryable 400): turns by another model or made with thinking off get "". Depends
  // only on the message and the request-level settings, so the history stays append-only.
  if (req.tools.length > 0 && thinkingOn(req)) return { ...msg, reasoning_content: "" };
  return msg;
}

type MediaBlock = Extract<ContentBlock, { type: "image" | "document" }>;

function mapMedia(b: MediaBlock): Part {
  if (b.type === "document") {
    throw new ModelError(
      "invalid_request",
      "DeepSeek does not accept documents; the model is declared with documents: false",
    );
  }
  if (b.source.kind !== "base64") {
    throw new ModelError(
      "invalid_request",
      "The image block has an unresolved attachment reference; the kernel must send base64 data",
    );
  }
  return { type: "image_url", image_url: { url: `data:${b.mediaType};base64,${b.source.data}` } };
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
 * turns go out as `[system] ` user turns: on Chat Completions deepseek-v4-pro does not keep an
 * in-place system message in position (live probe 2026-11-07), and the model list's
 * `system_prompt_update` describes the Anthropic endpoint, not this one.
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

/** model-provider@2 request → streaming Chat Completions body. Pure. */
export function buildRequest(req: ModelRequest): ChatBody {
  const system = req.system.map((s) => s.text).join("\n\n");
  const body: ChatBody = {
    model: req.model,
    messages: [
      ...(system !== "" ? [{ role: "system" as const, content: system }] : []),
      ...mapMessages(req.messages, req),
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
    // The contract has "auto" | "none"; a forced choice is refused here the way the API would.
    const choice = req.toolChoice as string | undefined;
    if (choice === "none") body.tool_choice = "none";
    else if (choice !== undefined && choice !== "auto") {
      if (thinkingOn(req)) {
        throw new ModelError(
          "invalid_request",
          "DeepSeek does not allow a forced tool choice in thinking mode",
        );
      }
      body.tool_choice = choice as "required";
    }
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
