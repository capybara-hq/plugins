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
import { buildRequest, type ChatTarget, toolCallsDropped } from "./map-request.js";

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
  /** tool_call_start has been emitted (the id is then fixed). */
  started: boolean;
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
  const dropCalls = toolCallsDropped(req, target);
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
      const finishedBefore = finish !== null;
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
        // toolChoice "none" on a dialect that omits it is enforced here (toolCallsDropped)
        for (const tc of dropCalls ? [] : (delta.tool_calls ?? [])) {
          const acc = tools.get(tc.index) ?? { id: "", name: "", args: "", started: false };
          // The id is fixed when the call starts (synthesized if absent); an id that arrives after the
          // start is ignored, so message_complete carries the id the start event announced
          if (tc.id && !acc.started) acc.id = tc.id;
          // Name assigned whole: some services repeat it in every delta
          if (tc.function?.name) acc.name = tc.function.name;
          const fragment = tc.function?.arguments;
          if (fragment) acc.args += fragment;
          tools.set(tc.index, acc);
          if (!acc.started) {
            // Start once the name is known (an upstream may send the arguments first); an upstream
            // that never sends an id gets a synthesized one, reused in message_complete
            // No name yet: keep the arguments, start (and flush them) once the name arrives
            if (acc.name === "") continue;
            acc.id = acc.id !== "" ? acc.id : `call_${tc.index}`;
            acc.started = true;
            yield { type: "tool_call_start", id: acc.id, name: acc.name };
            if (acc.args !== "") yield { type: "tool_call_delta", id: acc.id, input: acc.args };
          } else if (fragment) {
            yield { type: "tool_call_delta", id: acc.id, input: fragment };
          }
        }
        if (choice.finish_reason != null) finish = choice.finish_reason;
      }
      if (signal.aborted) throw aborted();
      // 停读规则：拿到 finish_reason 后，有了用量就停；没有用量时最多再读一个 chunk（用量通常紧随其后，
      // 服务忽略 include_usage 时则不会来），之后不论有没有用量都停。`[DONE]` 由 SDK 结束迭代。
      // 服务端（或中间代理）不关连接时继续读只会等到空闲超时。finish 之后既无 chunk、也无 [DONE] 且不关连接的服务
      // 仍会等到内核看门狗超时（无法与「用量还在路上」区分）。
      if (finish !== null && (usage !== null || finishedBefore)) break;
    }
    if (signal.aborted) throw aborted();
    if (finish === null) {
      throw new ModelError("network", "OpenAI-compatible stream ended before finish_reason");
    }
    // DeepSeek：服务端资源不足导致生成中断，内容不完整，按可重试的服务端错误处理
    if (finish === "insufficient_system_resource") {
      throw new ModelError(
        "server",
        "OpenAI-compatible: generation interrupted (insufficient_system_resource)",
      );
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
      if (c.name === "") {
        throw new ModelError("invalid_request", `Tool call #${i} has no function name`);
      }
      // A call without arguments streamed no fragment: announce its input once, as `{}`
      if (c.args.trim() === "") yield { type: "tool_call_delta", id: c.id, input: "{}" };
      content.push({
        type: "tool_call",
        id: c.id,
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
