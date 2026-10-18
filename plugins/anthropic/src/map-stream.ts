import type Anthropic from "@anthropic-ai/sdk";
import {
  type ContentBlock,
  ModelError,
  type ModelRequestV1,
  type ModelStreamEvent,
  type StopReason,
} from "@capybara-hq/plugin-sdk";
import { toModelError } from "./errors.js";
import { type BuiltRequest, buildRequest, PROVIDER, type ServerFallbacks } from "./map-request.js";

type StreamEvent = Anthropic.RawMessageStreamEvent | Anthropic.Beta.BetaRawMessageStreamEvent;
/** beta 接口的请求体与标准接口同形（多出 betas / fallbacks）。 */
type BetaParams = Omit<Anthropic.Beta.Messages.MessageCreateParamsNonStreaming, "stream">;

interface RawStream extends AsyncIterable<StreamEvent> {
  controller: AbortController;
}

/**
 * 用原始事件流（`create({ stream: true })`），自己累积最终消息。
 * 不用 SDK 的 MessageStream：它在 content_block_stop 时自行解析工具输入，非截断的畸形 JSON
 * 会被包成不带结构信息的 AnthropicError，无法按类型归为 invalid_request。
 */
async function openStream(
  client: Anthropic,
  built: BuiltRequest,
  signal: AbortSignal,
): Promise<RawStream> {
  if (built.beta !== null) {
    return client.beta.messages.create(
      { ...(built.params as BetaParams), ...built.beta, stream: true },
      { signal },
    );
  }
  return client.messages.create({ ...built.params, stream: true }, { signal });
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
function parseToolInput(raw: string, name: string): Record<string, unknown> {
  const text = raw.trim() === "" ? "{}" : raw;
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

type BlockAcc =
  | { kind: "text"; text: string }
  | { kind: "thinking"; thinking: string; signature: string }
  | { kind: "redacted_thinking"; data: string }
  | { kind: "tool_use"; id: string; name: string; json: string }
  | { kind: "other" };

/** 单次调用内的最终消息累积器（请求局部状态）。 */
class MessageAccumulator {
  model = "";
  /**
   * 服务端拒答兜底时最后一个 fallback 块的 `to.model`：真正作答的模型（R39）。
   * 整条消息的思考块都按它打标签，下一轮不会回放给原模型（原模型校验签名会拒绝）。
   */
  fallbackTo: string | null = null;
  stopReason: string | null = null;
  started = false;
  stopped = false;
  readonly usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  readonly blocks = new Map<number, BlockAcc>();

  add(ev: StreamEvent): void {
    switch (ev.type) {
      case "message_start": {
        this.started = true;
        this.model = ev.message.model;
        const u = ev.message.usage;
        this.usage.input = u.input_tokens ?? 0;
        this.usage.output = u.output_tokens ?? 0;
        this.usage.cacheRead = u.cache_read_input_tokens ?? 0;
        this.usage.cacheWrite = u.cache_creation_input_tokens ?? 0;
        break;
      }
      case "content_block_start": {
        const b = ev.content_block;
        if (b.type === "text") this.blocks.set(ev.index, { kind: "text", text: b.text });
        else if (b.type === "thinking") {
          this.blocks.set(ev.index, {
            kind: "thinking",
            thinking: b.thinking,
            signature: b.signature,
          });
        } else if (b.type === "redacted_thinking") {
          this.blocks.set(ev.index, { kind: "redacted_thinking", data: b.data });
        } else if (b.type === "tool_use") {
          this.blocks.set(ev.index, { kind: "tool_use", id: b.id, name: b.name, json: "" });
        } else {
          if (b.type === "fallback") this.fallbackTo = b.to.model;
          this.blocks.set(ev.index, { kind: "other" });
        }
        break;
      }
      case "content_block_delta": {
        const acc = this.blocks.get(ev.index);
        const d = ev.delta;
        if (acc?.kind === "text" && d.type === "text_delta") acc.text += d.text;
        else if (acc?.kind === "thinking" && d.type === "thinking_delta") {
          acc.thinking += d.thinking;
        } else if (acc?.kind === "thinking" && d.type === "signature_delta") {
          acc.signature += d.signature;
        } else if (acc?.kind === "tool_use" && d.type === "input_json_delta") {
          acc.json += d.partial_json;
        }
        break;
      }
      case "message_delta": {
        this.stopReason = ev.delta.stop_reason;
        const u = ev.usage;
        if (u.output_tokens != null) this.usage.output = u.output_tokens;
        if (u.input_tokens != null) this.usage.input = u.input_tokens;
        if (u.cache_read_input_tokens != null) this.usage.cacheRead = u.cache_read_input_tokens;
        if (u.cache_creation_input_tokens != null) {
          this.usage.cacheWrite = u.cache_creation_input_tokens;
        }
        break;
      }
      case "message_stop":
        this.stopped = true;
        break;
      default:
        break;
    }
  }

  complete(): Extract<ModelStreamEvent, { type: "message_complete" }> {
    if (!this.started || !this.stopped) {
      throw new ModelError("network", "Anthropic stream ended before message_stop");
    }
    const model = this.fallbackTo ?? this.model;
    const content: ContentBlock[] = [];
    const indices = [...this.blocks.keys()].sort((a, b) => a - b);
    for (const i of indices) {
      const b = this.blocks.get(i) as BlockAcc;
      switch (b.kind) {
        case "text":
          content.push({ type: "text", text: b.text });
          break;
        case "thinking":
          content.push({
            type: "thinking",
            text: b.thinking,
            opaque: {
              provider: PROVIDER,
              model,
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
              model,
              data: { type: "redacted_thinking", data: b.data },
            },
          });
          break;
        case "tool_use":
          content.push({
            type: "tool_call",
            id: b.id,
            name: b.name,
            input: parseToolInput(b.json, b.name),
          });
          break;
        default:
          // 服务端工具、fallback 切换标记等不在 model-provider@1 契约内的块不回传
          break;
      }
    }
    return {
      type: "message_complete",
      content,
      stopReason: mapStopReason(this.stopReason),
      usage: {
        // Anthropic 的 input_tokens 本身不含缓存读写部分（R23）
        inputTokens: this.usage.input,
        outputTokens: this.usage.output,
        cacheReadTokens: this.usage.cacheRead,
        cacheWriteTokens: this.usage.cacheWrite,
      },
    };
  }
}

const aborted = () => new ModelError("aborted", "Request aborted");

/** 发起一次流式调用并映射为 model-provider@1 事件；以且仅以一个 message_complete 结束，出错抛 ModelError。 */
export async function* streamMessages(
  client: Anthropic,
  req: ModelRequestV1,
  opts: { signal: AbortSignal; serverFallbacks: ServerFallbacks; thinking?: boolean },
): AsyncGenerator<ModelStreamEvent> {
  const { signal } = opts;
  if (signal.aborted) throw aborted();
  const built = buildRequest(req, {
    serverFallbacks: opts.serverFallbacks,
    ...(opts.thinking !== undefined ? { thinking: opts.thinking } : {}),
  });
  const acc = new MessageAccumulator();
  let stream: RawStream | undefined;
  try {
    stream = await openStream(client, built, signal);
    for await (const ev of stream) {
      if (signal.aborted) throw aborted();
      acc.add(ev);
      // message_stop 之后不再读：服务端（或中间代理）不关连接时，继续读只会等到空闲超时。
      if (ev.type === "message_stop") break;
      if (ev.type === "content_block_delta") {
        const d = ev.delta;
        if (d.type === "text_delta") yield { type: "text_delta", text: d.text };
        else if (d.type === "thinking_delta") yield { type: "thinking_delta", text: d.thinking };
        if (signal.aborted) throw aborted();
      }
    }
    if (signal.aborted) throw aborted();
    yield acc.complete();
  } catch (e) {
    throw toModelError(e, signal);
  } finally {
    // 调用方提前停止迭代时也要关掉底层连接
    stream?.controller.abort();
  }
}
