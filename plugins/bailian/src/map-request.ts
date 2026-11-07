import {
  type ContentBlock,
  ModelError,
  type ModelMessage,
  type ModelRequest,
} from "@capybara-hq/plugin-sdk";
import type { Endpoint } from "./list.js";
import { PROVIDER } from "./tables.js";

/*
 * DashScope native generation (https://www.alibabacloud.com/help/en/model-studio/qwen-api-via-dashscope,
 * https://www.alibabacloud.com/help/en/model-studio/deep-thinking; shapes checked live 2026-11-08):
 * `{ model, input: { messages }, parameters }`. text-generation takes string contents (system
 * also as typed parts `{ type: "text", text, cache_control }`); multimodal-generation takes parts
 * `{ text }` / `{ image: <data URL> }`.
 */

/** Text part: typed on text-generation, bare on multimodal-generation. */
type Part =
  | { type?: "text"; text: string; cache_control?: { type: "ephemeral" } }
  | { image: string };

export interface NativeMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | Part[];
  reasoning_content?: string;
  tool_calls?: {
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }[];
  tool_call_id?: string;
}

export interface NativeBody {
  model: string;
  input: { messages: NativeMessage[] };
  parameters: Record<string, unknown>;
}

/** Opaque data of a thinking block: the text is the `reasoning_content` itself. */
export interface ThinkingOpaque {
  field: "reasoning_content";
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

const textPart = (text: string, endpoint: Endpoint): Part =>
  endpoint === "text" ? { type: "text", text } : { text };

/** A text-only message: a string on text-generation, one part on multimodal-generation. */
const textContent = (text: string, endpoint: Endpoint): string | Part[] =>
  endpoint === "text" ? text : [{ text }];

type MediaBlock = Extract<ContentBlock, { type: "image" | "document" }>;

/** An image as a data URL part (multimodal-generation only; the kernel gates `vision`). */
function mediaPart(b: MediaBlock, endpoint: Endpoint): Part {
  if (b.source.kind !== "base64") {
    throw new ModelError(
      "invalid_request",
      `The ${b.type} block has an unresolved attachment reference; the kernel must send base64 data`,
    );
  }
  if (b.type === "document") {
    // `documents` is declared false for every model: the kernel inlines text and never sends one
    throw new ModelError("invalid_request", "Bailian models do not accept document blocks");
  }
  if (endpoint !== "multimodal") {
    throw new ModelError("invalid_request", "This Bailian model does not accept images");
  }
  return { image: `data:${b.mediaType};base64,${b.source.data}` };
}

/**
 * A user message: tool results first as `role: "tool"` messages (they follow the assistant's
 * tool calls), then the remaining blocks as one user message. Looks only at the message itself.
 */
function mapUser(content: ContentBlock[], endpoint: Endpoint): NativeMessage[] {
  const out: NativeMessage[] = [];
  const parts: Part[] = [];
  for (const b of content) {
    if (b.type === "tool_result") {
      out.push({ role: "tool", tool_call_id: b.callId, content: b.content });
    } else if (b.type === "text") {
      parts.push(textPart(b.text, endpoint));
    } else if (b.type === "image" || b.type === "document") {
      parts.push(mediaPart(b, endpoint));
    }
  }
  if (parts.length === 0) return out;
  if (endpoint === "text") {
    // text-generation: text only (images were refused above), joined like the compatible mode
    out.push({ role: "user", content: parts.map((p) => ("text" in p ? p.text : "")).join("\n\n") });
  } else {
    out.push({ role: "user", content: parts });
  }
  return out;
}

/**
 * An assistant message. Thinking goes back as `reasoning_content` only when this plugin produced
 * it for the request's model; otherwise it is dropped whole. Whether the model reads it depends
 * on the model (live 2026-11-08: counted by qwen3.7-max with `preserve_thinking`, always by
 * glm-5.1, ignored by qwen-flash and deepseek-v4-flash).
 */
function mapAssistant(
  content: ContentBlock[],
  req: ModelRequest,
  endpoint: Endpoint,
): NativeMessage {
  let text = "";
  let reasoning: string | undefined;
  const calls: NonNullable<NativeMessage["tool_calls"]> = [];
  for (const b of content) {
    if (b.type === "text") text += b.text;
    else if (b.type === "thinking") {
      const o = b.opaque;
      if (o?.provider === PROVIDER && o.model === req.model && o.data != null) {
        reasoning = (reasoning ?? "") + b.text;
      }
    } else if (b.type === "tool_call") {
      calls.push({
        id: b.id,
        type: "function",
        function: { name: b.name, arguments: serializeArgs(b.input, b.name) },
      });
    }
  }
  const msg: NativeMessage = { role: "assistant", content: textContent(text, endpoint) };
  if (reasoning !== undefined) msg.reasoning_content = reasoning;
  if (calls.length > 0) msg.tool_calls = calls;
  return msg;
}

/**
 * Messages in order. Each message's mapping depends only on itself and request-level settings, so
 * an earlier request's messages are always a prefix of a later one's (append-only history).
 */
function mapMessages(
  messages: ModelMessage[],
  req: ModelRequest,
  endpoint: Endpoint,
): NativeMessage[] {
  const out: NativeMessage[] = [];
  for (const m of messages) {
    if (m.role === "system") {
      out.push({ role: "user", content: textContent(`[system] ${m.content}`, endpoint) });
    } else if (m.role === "user") {
      out.push(...mapUser(m.content, endpoint));
    } else {
      out.push(mapAssistant(m.content, req, endpoint));
    }
  }
  return out;
}

/**
 * The system message as parts, with an explicit cache marker (`cache_control: { type:
 * "ephemeral" }`, a 5-minute cache) after the last block the kernel marked `cache: true`. Live
 * 2026-11-08: implicit caching did not hit for a repeated 5k-token prompt, the explicit marker
 * did (both endpoints); models without explicit caching ignore the field.
 */
function systemMessage(req: ModelRequest, endpoint: Endpoint): NativeMessage | null {
  if (req.system.length === 0) return null;
  let lastCached = -1;
  req.system.forEach((s, i) => {
    if (s.cache) lastCached = i;
  });
  const content: Part[] = req.system.map((s, i) => ({
    ...textPart(s.text, endpoint),
    ...(i === lastCached ? { cache_control: { type: "ephemeral" as const } } : {}),
  }));
  return { role: "system", content };
}

/** model-provider@2 request → native streaming body. Pure. */
export function buildRequest(req: ModelRequest, endpoint: Endpoint): NativeBody {
  const system = systemMessage(req, endpoint);
  const parameters: Record<string, unknown> = {
    result_format: "message",
    // Required with thinking; also what makes every event a delta rather than the text so far
    incremental_output: true,
    max_tokens: req.maxOutputTokens,
  };
  if (req.tools.length > 0) {
    parameters.tools = req.tools.map((tool) => ({
      type: "function",
      function: { name: tool.name, description: tool.description, parameters: tool.inputSchema },
    }));
    // none: tools stay declared but must not be called (the wrap-up call); auto is the default
    if (req.toolChoice === "none") parameters.tool_choice = "none";
  }
  const thinking = req.params.thinking;
  if (thinking === "on" || thinking === "off") {
    parameters.enable_thinking = thinking === "on";
    // Lets the models that support it read the replayed reasoning_content of earlier turns
    if (thinking === "on") parameters.preserve_thinking = true;
  }
  if (typeof req.params.temperature === "number") parameters.temperature = req.params.temperature;
  return {
    model: req.model,
    input: {
      messages: [...(system !== null ? [system] : []), ...mapMessages(req.messages, req, endpoint)],
    },
    parameters,
  };
}
