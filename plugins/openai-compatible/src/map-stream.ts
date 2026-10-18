import {
  type ContentBlock,
  ModelError,
  type ModelRequest,
  type ModelStreamEvent,
  type StopReason,
} from "@capybara-hq/plugin-sdk";
import type OpenAI from "openai";
import { type ChunkDelta, PROVIDER, type RawUsage, type ThinkingOpaque } from "./dialects.js";
import { toModelError } from "./errors.js";
import { buildRequest, type ChatTarget } from "./map-request.js";

/** 自己用 JSON.parse 解析工具参数：非对象或解析失败都是 invalid_request。 */
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

type FinishReason = NonNullable<OpenAI.Chat.ChatCompletionChunk.Choice["finish_reason"]> | string;

function stopReasonOf(finish: FinishReason, hasToolCall: boolean): StopReason {
  switch (finish) {
    case "stop":
    case "tool_calls":
      // 部分服务（如一些 vLLM 版本）带着工具调用却报 stop：有工具调用就是 tool_use
      return hasToolCall ? "tool_use" : "end_turn";
    case "length":
      return "max_tokens";
    case "content_filter":
      return "refusal";
    default:
      return "other";
  }
}

interface ToolAcc {
  id: string;
  name: string;
  args: string;
}

const aborted = () => new ModelError("aborted", "Request aborted");

/**
 * 发起一次流式 Chat Completions 调用并映射为 model-provider@2 事件；以且仅以一个 message_complete 结束，
 * 出错抛 ModelError。在原始 chunk 上自行累积文本、思考与工具调用（按 index 拼接 arguments，结束时解析）。
 */
export async function* streamChat(
  client: OpenAI,
  req: ModelRequest,
  opts: { signal: AbortSignal; target: ChatTarget },
): AsyncGenerator<ModelStreamEvent> {
  const { signal, target } = opts;
  const dialect = target.dialect;
  if (signal.aborted) throw aborted();
  const open = () => client.chat.completions.create(buildRequest(req, target), { signal });
  let stream: Awaited<ReturnType<typeof open>> | undefined;
  try {
    stream = await open();
    let text = "";
    let reasoning = "";
    const tools = new Map<number, ToolAcc>();
    let finish: FinishReason | null = null;
    let usage: RawUsage | null = null;
    for await (const chunk of stream) {
      if (signal.aborted) throw aborted();
      if (chunk.usage != null) usage = chunk.usage as RawUsage;
      for (const choice of chunk.choices ?? []) {
        if (choice.index !== 0) continue;
        const delta = (choice.delta ?? {}) as ChunkDelta;
        const d = dialect.readDelta(delta);
        if (d.reasoning !== undefined) {
          reasoning += d.reasoning;
          yield { type: "thinking_delta", text: d.reasoning };
        }
        if (d.text !== undefined) {
          text += d.text;
          yield { type: "text_delta", text: d.text };
        }
        for (const tc of delta.tool_calls ?? []) {
          const acc = tools.get(tc.index) ?? { id: "", name: "", args: "" };
          if (tc.id) acc.id = tc.id;
          if (tc.function?.name) acc.name += tc.function.name;
          if (tc.function?.arguments) acc.args += tc.function.arguments;
          tools.set(tc.index, acc);
        }
        if (choice.finish_reason != null) finish = choice.finish_reason;
      }
      if (signal.aborted) throw aborted();
      // 拿到 finish_reason 与用量后不再读：服务端（或中间代理）不关连接时，继续读只会等到空闲超时
      if (finish !== null && usage !== null) break;
    }
    if (signal.aborted) throw aborted();
    if (finish === null) {
      throw new ModelError("network", "OpenAI-compatible stream ended before finish_reason");
    }

    const content: ContentBlock[] = [];
    if (reasoning !== "") {
      content.push({
        type: "thinking",
        text: reasoning,
        // 思考就是 reasoning_content 本身；按请求的对外模型 id（含端点名）打标签，只回放给同一端点同一模型
        opaque: {
          provider: PROVIDER,
          model: req.model,
          data: { field: "reasoning_content" } satisfies ThinkingOpaque,
        },
      });
    }
    if (text !== "") content.push({ type: "text", text });
    // 被截断（length）时工具参数不完整，不回传
    const calls =
      finish === "length" ? [] : [...tools.entries()].sort(([a], [b]) => a - b).map(([, c]) => c);
    for (const [i, c] of calls.entries()) {
      content.push({
        type: "tool_call",
        // 个别服务不给 id：用稳定的序号兜底（同一条消息里唯一，回放时与 tool_result 对得上）
        id: c.id !== "" ? c.id : `call_${i}`,
        name: c.name,
        input: parseArguments(c.args, c.name),
      });
    }
    yield {
      type: "message_complete",
      content,
      stopReason: stopReasonOf(finish, calls.length > 0),
      usage: dialect.usage(usage),
    };
  } catch (e) {
    throw toModelError(e, signal);
  } finally {
    // 调用方提前停止迭代、或读到终止 chunk 后提前退出时，关掉底层连接
    stream?.controller.abort();
  }
}
