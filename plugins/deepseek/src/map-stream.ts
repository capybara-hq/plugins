import {
  type ContentBlock,
  ModelError,
  type ModelRequest,
  type ModelStreamEvent,
  type ModelUsage,
  type StopReason,
} from "@capybara-hq/plugin-sdk";
import type OpenAI from "openai";
import { toModelError } from "./errors.js";
import { buildRequest, PROVIDER, type ThinkingOpaque } from "./map-request.js";

type ChunkDelta = OpenAI.Chat.ChatCompletionChunk.Choice.Delta & {
  reasoning_content?: string | null;
};
type RawUsage = OpenAI.CompletionUsage & {
  prompt_cache_hit_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
};

function parseArguments(raw: string, name: string): Record<string, unknown> {
  const text = raw.trim() === "" ? "{}" : raw;
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch (cause) {
    throw new ModelError("invalid_request", `Tool call "${name}" has invalid JSON arguments`, {
      cause,
    });
  }
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    throw new ModelError("invalid_request", `Tool call "${name}" arguments are not a JSON object`);
  }
  return v as Record<string, unknown>;
}

function stopReasonOf(finish: string, hasToolCall: boolean): StopReason {
  switch (finish) {
    case "stop":
    case "tool_calls":
      return hasToolCall ? "tool_use" : "end_turn";
    case "length":
      return "max_tokens";
    case "content_filter":
      return "refusal";
    default:
      return "other";
  }
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** `prompt_tokens` = cache hit + cache miss; the contract wants the three kinds disjoint. */
function usageOf(raw: RawUsage | null): ModelUsage {
  const total = num(raw?.prompt_tokens);
  const hit = num(raw?.prompt_cache_hit_tokens ?? raw?.prompt_tokens_details?.cached_tokens);
  return {
    inputTokens: Math.max(0, total - hit),
    outputTokens: num(raw?.completion_tokens),
    cacheReadTokens: hit,
    cacheWriteTokens: 0,
  };
}

const nonEmpty = (v: unknown): v is string => typeof v === "string" && v !== "";
const aborted = () => new ModelError("aborted", "Request aborted");

interface ToolAcc {
  id: string;
  name: string;
  args: string;
}

/**
 * One streaming Chat Completions call mapped to model-provider@2 events; ends with exactly one
 * message_complete, errors throw ModelError. Text, reasoning and tool calls are accumulated from the
 * raw chunks (arguments concatenated by index, parsed at the end).
 */
export async function* streamChat(
  client: OpenAI,
  req: ModelRequest,
  signal: AbortSignal,
): AsyncGenerator<ModelStreamEvent> {
  if (signal.aborted) throw aborted();
  let stream: Awaited<ReturnType<typeof open>> | undefined;
  const body = buildRequest(req);
  const open = () => client.chat.completions.create(body, { signal });
  try {
    stream = await open();
    let text = "";
    let reasoning = "";
    const tools = new Map<number, ToolAcc>();
    let finish: string | null = null;
    let usage: RawUsage | null = null;
    for await (const chunk of stream) {
      if (signal.aborted) throw aborted();
      const finishedBefore = finish !== null;
      if (chunk.usage != null) usage = chunk.usage as RawUsage;
      for (const choice of chunk.choices ?? []) {
        if (choice.index !== 0) continue;
        const delta = (choice.delta ?? {}) as ChunkDelta;
        if (nonEmpty(delta.reasoning_content)) {
          reasoning += delta.reasoning_content;
          yield { type: "thinking_delta", text: delta.reasoning_content };
        }
        if (nonEmpty(delta.content)) {
          text += delta.content;
          yield { type: "text_delta", text: delta.content };
        }
        for (const tc of delta.tool_calls ?? []) {
          const acc = tools.get(tc.index) ?? { id: "", name: "", args: "" };
          if (tc.id) acc.id = tc.id;
          if (tc.function?.name) acc.name = tc.function.name;
          if (tc.function?.arguments) acc.args += tc.function.arguments;
          tools.set(tc.index, acc);
        }
        if (choice.finish_reason != null) finish = choice.finish_reason;
      }
      if (signal.aborted) throw aborted();
      // Stop rule: once finish_reason is in, stop when usage is in; without usage read at most one
      // more chunk (usage normally follows at once), then stop either way. `[DONE]` ends the SDK's
      // iteration; a server that keeps the connection open must not make us wait for the idle timeout.
      if (finish !== null && (usage !== null || finishedBefore)) break;
    }
    if (signal.aborted) throw aborted();
    if (finish === null) {
      throw new ModelError("network", "DeepSeek: stream ended before finish_reason");
    }
    // The generation was cut short by the service: content is incomplete, retryable.
    if (finish === "insufficient_system_resource" || finish === "aborted") {
      throw new ModelError("server", `DeepSeek: generation interrupted (${finish})`);
    }

    const content: ContentBlock[] = [];
    if (reasoning !== "") {
      content.push({
        type: "thinking",
        text: reasoning,
        opaque: {
          provider: PROVIDER,
          model: req.model,
          data: { field: "reasoning_content" } satisfies ThinkingOpaque,
        },
      });
    }
    if (text !== "") content.push({ type: "text", text });
    // A truncated (length) reply has incomplete tool arguments: not returned.
    const calls =
      finish === "length" ? [] : [...tools.entries()].sort(([a], [b]) => a - b).map(([, c]) => c);
    for (const [i, c] of calls.entries()) {
      if (c.name === "") {
        throw new ModelError("invalid_request", `Tool call #${i} has no function name`);
      }
      content.push({
        type: "tool_call",
        id: c.id !== "" ? c.id : `call_${i}`,
        name: c.name,
        input: parseArguments(c.args, c.name),
      });
    }
    yield {
      type: "message_complete",
      content,
      stopReason: stopReasonOf(finish, calls.length > 0),
      usage: usageOf(usage),
    };
  } catch (e) {
    throw toModelError(e, signal);
  } finally {
    stream?.controller.abort();
  }
}
