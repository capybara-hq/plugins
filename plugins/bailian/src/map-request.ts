import {
  type ContentBlock,
  ModelError,
  type ModelMessage,
  type ModelRequest,
} from "@capybara-hq/plugin-sdk";
import type { Endpoint } from "./list.js";
import { CACHE_TTL_1H_SECONDS, PROVIDER } from "./tables.js";

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
): NativeMessage | null {
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
  if (text === "" && reasoning === undefined && calls.length === 0) return null;
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
      const a = mapAssistant(m.content, req, endpoint);
      if (a !== null) out.push(a);
    }
  }
  return out;
}

const EPHEMERAL = { type: "ephemeral" } as const;

/**
 * The system message as parts, with an explicit cache marker (`cache_control: { type:
 * "ephemeral" }`, a 5-minute cache refreshed on every hit) after the last block the kernel marked
 * `cache: true`: the system prompt and tools are shared by every conversation of the agent. Live
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
    ...(i === lastCached ? { cache_control: EPHEMERAL } : {}),
  }));
  return { role: "system", content };
}

/**
 * The history cache marker: `cache_control` on the last content block of the last message, as
 * DashScope documents for multi-turn conversations
 * (https://help.aliyun.com/zh/model-studio/context-cache). Explicit and implicit caching are
 * mutually exclusive within one request, so with only the system marker the history got neither.
 * Each turn the marker moves to the new last block: the previous turn's entry ends where this
 * turn's new messages begin, one block before them, well within the 20-block lookback, so the
 * whole earlier history is read from the cache and only the new messages are written. The bytes
 * of earlier messages change only by the marker leaving them (a string content becomes one text
 * part while it carries the marker); the cache matches on the rendered prompt, not on the JSON
 * (live 2026-11-27, qwen-plus and glm-5.1 on text-generation, qwen3.8-flash on
 * multimodal-generation: each turn read the whole previous request from the cache). DashScope has
 * no top-level automatic marker like Anthropic's (a top-level `cache_control` was ignored, live
 * 2026-11-27). Known gap, live 2026-11-27: qwen-plus / qwen-flash read only the system entry
 * after an assistant turn with two or more parallel tool calls (glm-5.1, deepseek-v4-pro and
 * qwen3.8-flash do not). With the system marker this makes 2 of the 4 markers allowed.
 */
function markLastBlock(messages: NativeMessage[], endpoint: Endpoint): void {
  const last = messages[messages.length - 1];
  if (last === undefined || last.role === "system") return;
  if (typeof last.content === "string") {
    if (last.content === "") return;
    last.content = [{ ...textPart(last.content, endpoint), cache_control: EPHEMERAL }];
    return;
  }
  const i = last.content.length - 1;
  const part = last.content[i];
  if (part === undefined) return;
  // only text parts: the docs show a marker after media for qwen3-vl-plus alone
  if (!("text" in part) || part.text === "") return;
  last.content[i] = { ...part, cache_control: EPHEMERAL };
}

/**
 * Whether the reply's tool calls are dropped: `toolChoice: "none"` (the in-context summary and the
 * step-limit wrap-up) keeps the tools declared so the request shares the cache prefix of the turns
 * before it, but DashScope renders a request with `tool_choice: "none"` as one without tools: the
 * tool definitions, rendered ahead of the system text, disappear, the prompt differs from token 0
 * and nothing is read from the cache, the same as `tools: []` (live 2026-11-28, qwen4-max,
 * qwen-plus, glm-5.1: after a 6745-token turn, a summary-shaped request with "none" read 0 tokens
 * and counted 3974 in all, the tools gone; with the default auto it read 6741). So
 * `tool_choice` is left at its default (auto) and the stream mapping guarantees the contract
 * instead: no tool_call events or blocks, only the text, stop reason end_turn. The model is told
 * in the request not to call tools; one that does anyway leaves only its text before the call
 * (often empty or a short lead-in), which the kernel's callers already treat as a failed or short
 * answer (a summary too short to accept fails the compaction; a wrap-up ends the run with that
 * text). Remove once DashScope keeps the tool definitions in the prompt under "none".
 */
export function toolCallsDropped(req: ModelRequest): boolean {
  return req.toolChoice === "none";
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
    // `toolChoice: "none"` is not sent: see toolCallsDropped
  }
  const thinking = req.params.thinking;
  if (thinking === "on" || thinking === "off") {
    parameters.enable_thinking = thinking === "on";
    // Lets the models that support it read the replayed reasoning_content of earlier turns
    if (thinking === "on") parameters.preserve_thinking = true;
  }
  if (typeof req.params.temperature === "number") parameters.temperature = req.params.temperature;
  // A top-level `prompt_cache_options` is silently ignored: it goes in `parameters`
  if (req.cacheTtl === CACHE_TTL_1H_SECONDS) parameters.prompt_cache_options = { ttl: "1h" };
  const history = mapMessages(req.messages, req, endpoint);
  markLastBlock(history, endpoint);
  return {
    model: req.model,
    input: { messages: [...(system !== null ? [system] : []), ...history] },
    parameters,
  };
}
