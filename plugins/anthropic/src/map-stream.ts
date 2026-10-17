import type Anthropic from "@anthropic-ai/sdk";
import {
  type ContentBlock,
  ModelError,
  type ModelRequest,
  type ModelStreamEvent,
  type StopReason,
} from "@capybara-hq/plugin-sdk";
import { toModelError } from "./errors.js";
import { type BuiltRequest, buildRequest, PROVIDER, type ServerFallbacks } from "./map-request.js";

type StreamEvent = Anthropic.RawMessageStreamEvent | Anthropic.Beta.BetaRawMessageStreamEvent;
type FinalMessage = Anthropic.Message | Anthropic.Beta.BetaMessage;
/** beta 接口的请求体与标准接口同形（多出 betas / fallbacks）。 */
type BetaParams = Omit<Anthropic.Beta.Messages.MessageCreateParamsNonStreaming, "stream">;

interface StreamLike extends AsyncIterable<StreamEvent> {
  finalMessage(): Promise<FinalMessage>;
  abort(): void;
}

function openStream(client: Anthropic, built: BuiltRequest, signal: AbortSignal): StreamLike {
  if (built.beta !== null) {
    return client.beta.messages.stream(
      { ...(built.params as BetaParams), ...built.beta },
      { signal },
    );
  }
  return client.messages.stream(built.params, { signal });
}

function mapStopReason(r: string | null): StopReason {
  switch (r) {
    case "end_turn":
    case "tool_use":
    case "max_tokens":
    case "refusal":
      return r;
    default:
      return "other";
  }
}

/** 客户端工具开了 eager_input_streaming 后 API 不再校验输入：自己用 JSON.parse 解析原始片段。 */
function parseToolInput(raw: string | undefined, name: string): Record<string, unknown> {
  const text = raw === undefined || raw.trim() === "" ? "{}" : raw;
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch (cause) {
    throw new ModelError("invalid_request", `Tool call "${name}" has invalid JSON input`, {
      cause,
    });
  }
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    throw new ModelError("invalid_request", `Tool call "${name}" input is not a JSON object`);
  }
  return v as Record<string, unknown>;
}

function mapFinal(
  msg: FinalMessage,
  rawToolInput: Map<number, string>,
): Extract<ModelStreamEvent, { type: "message_complete" }> {
  const content: ContentBlock[] = [];
  msg.content.forEach((b, index) => {
    switch (b.type) {
      case "text":
        content.push({ type: "text", text: b.text });
        break;
      case "thinking":
        content.push({
          type: "thinking",
          text: b.thinking,
          opaque: {
            provider: PROVIDER,
            model: msg.model,
            data: { type: "thinking", thinking: b.thinking, signature: b.signature },
          },
        });
        break;
      case "redacted_thinking":
        content.push({
          type: "thinking",
          text: "",
          opaque: {
            provider: PROVIDER,
            model: msg.model,
            data: { type: "redacted_thinking", data: b.data },
          },
        });
        break;
      case "tool_use":
        content.push({
          type: "tool_call",
          id: b.id,
          name: b.name,
          input: parseToolInput(rawToolInput.get(index), b.name),
        });
        break;
      default:
        // 服务端工具、fallback 切换标记等不在 model-provider@1 契约内的块不回传
        break;
    }
  });
  const u = msg.usage;
  return {
    type: "message_complete",
    content,
    stopReason: mapStopReason(msg.stop_reason),
    usage: {
      // Anthropic 的 input_tokens 本身不含缓存读写部分（R23）
      inputTokens: u.input_tokens ?? 0,
      outputTokens: u.output_tokens ?? 0,
      cacheReadTokens: u.cache_read_input_tokens ?? 0,
      cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
    },
  };
}

const aborted = () => new ModelError("aborted", "Request aborted");

/** 发起一次流式调用并映射为 model-provider@1 事件；以且仅以一个 message_complete 结束，出错抛 ModelError。 */
export async function* streamMessages(
  client: Anthropic,
  req: ModelRequest,
  opts: { signal: AbortSignal; serverFallbacks: ServerFallbacks },
): AsyncGenerator<ModelStreamEvent> {
  const { signal } = opts;
  if (signal.aborted) throw aborted();
  const built = buildRequest(req, { serverFallbacks: opts.serverFallbacks });
  const rawToolInput = new Map<number, string>();
  let stream: StreamLike | undefined;
  try {
    stream = openStream(client, built, signal);
    for await (const ev of stream) {
      if (signal.aborted) throw aborted();
      if (ev.type === "content_block_start" && ev.content_block.type === "tool_use") {
        rawToolInput.set(ev.index, "");
      } else if (ev.type === "content_block_delta") {
        const d = ev.delta;
        if (d.type === "text_delta") yield { type: "text_delta", text: d.text };
        else if (d.type === "thinking_delta") yield { type: "thinking_delta", text: d.thinking };
        else if (d.type === "input_json_delta") {
          rawToolInput.set(ev.index, (rawToolInput.get(ev.index) ?? "") + d.partial_json);
        }
        if (signal.aborted) throw aborted();
      }
    }
    if (signal.aborted) throw aborted();
    const msg = await stream.finalMessage();
    yield mapFinal(msg, rawToolInput);
  } catch (e) {
    throw toModelError(e, signal);
  } finally {
    // 调用方提前停止迭代时也要关掉底层连接
    stream?.abort();
  }
}
