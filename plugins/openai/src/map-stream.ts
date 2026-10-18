import {
  type ContentBlock,
  ModelError,
  type ModelRequest,
  type ModelStreamEvent,
  type StopReason,
} from "@capybara-hq/plugin-sdk";
import type OpenAI from "openai";
import { kindFromCode, toModelError } from "./errors.js";
import {
  buildRequest,
  type FunctionCallOpaque,
  type MessageOpaque,
  type ModelTraits,
  PROVIDER,
} from "./map-request.js";

type Response = OpenAI.Responses.Response;
type Complete = Extract<ModelStreamEvent, { type: "message_complete" }>;

/** 推理摘要的多个段落之间的分隔（增量与最终文本一致）。 */
const SUMMARY_SEPARATOR = "\n\n";

/** 自己用 JSON.parse 解析 function_call 的参数：非对象或解析失败都是 invalid_request。 */
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

function stopReasonOf(r: Response, hasToolCall: boolean, hasRefusal: boolean): StopReason {
  if (r.status === "incomplete") {
    switch (r.incomplete_details?.reason) {
      case "max_output_tokens":
        return "max_tokens";
      case "content_filter":
        return "refusal";
      default:
        return "other";
    }
  }
  if (hasToolCall) return "tool_use";
  if (hasRefusal) return "refusal";
  return "end_turn";
}

/**
 * 终止事件里的完整响应 → message_complete。
 * opaque 按请求的模型 id 打标签：响应里的 `model` 是带日期的快照名，按它打标签下一轮永远无法回放。
 */
export function toComplete(r: Response, model: string): Complete {
  const content: ContentBlock[] = [];
  let hasToolCall = false;
  let hasRefusal = false;
  for (const item of r.output) {
    switch (item.type) {
      case "reasoning":
        content.push({
          type: "thinking",
          text: item.summary.map((s) => s.text).join(SUMMARY_SEPARATOR),
          // 原始 reasoning 项（含 encrypted_content）原样保存，回放时逐字节不变
          opaque: { provider: PROVIDER, model, data: item },
        });
        break;
      case "message": {
        let text = "";
        let hasRefusalPart = false;
        for (const part of item.content) {
          if (part.type === "output_text") text += part.text;
          else if (part.type === "refusal") {
            text += part.refusal;
            hasRefusalPart = true;
          }
        }
        if (hasRefusalPart) hasRefusal = true;
        if (text === "") break;
        // 含拒答的消息按普通文本回放（拒答部分不能原样还原成 output_text，不冒充原输出项）
        if (hasRefusalPart) {
          content.push({ type: "text", text });
          break;
        }
        // 输出项 id（与 phase、非 completed 的状态）随 text 块保存：跟在回放的 reasoning 项之后时要按原 id 回放
        content.push({
          type: "text",
          text,
          opaque: {
            provider: PROVIDER,
            model,
            data: {
              id: item.id,
              ...(item.phase != null ? { phase: item.phase } : {}),
              ...(item.status !== "completed" ? { status: item.status } : {}),
            } satisfies MessageOpaque,
          },
        });
        break;
      }
      case "function_call": {
        // 被截断（incomplete）的调用不回传：参数不完整，停止原因已是 max_tokens
        if (item.status === "incomplete" || item.status === "in_progress") break;
        hasToolCall = true;
        content.push({
          type: "tool_call",
          id: item.call_id,
          name: item.name,
          input: parseArguments(item.arguments, item.name),
          ...(item.id !== undefined
            ? {
                opaque: {
                  provider: PROVIDER,
                  model,
                  data: { id: item.id } satisfies FunctionCallOpaque,
                },
              }
            : {}),
        });
        break;
      }
      default:
        // 内置工具等不在 model-provider@2 契约内的输出项不回传
        break;
    }
  }
  const u = r.usage;
  const input = u?.input_tokens ?? 0;
  const cached = u?.input_tokens_details?.cached_tokens ?? 0;
  const written = u?.input_tokens_details?.cache_write_tokens ?? 0;
  return {
    type: "message_complete",
    content,
    stopReason: stopReasonOf(r, hasToolCall, hasRefusal),
    usage: {
      // OpenAI 的 input_tokens 含缓存读写部分；契约里 inputTokens 只是未缓存部分（R23 / R40）
      inputTokens: Math.max(0, input - cached - written),
      outputTokens: u?.output_tokens ?? 0,
      cacheReadTokens: cached,
      cacheWriteTokens: written,
    },
  };
}

const aborted = () => new ModelError("aborted", "Request aborted");

/**
 * 发起一次流式调用并映射为 model-provider@2 事件；以且仅以一个 message_complete 结束，出错抛 ModelError。
 * 用原始事件流（`responses.create({ stream: true })`），最终内容取自终止事件里的完整响应。
 * 不用 SDK 的 `responses.stream()`：它在本地累积并校验输出项，失败时抛出不带结构信息的
 * OpenAIError，无法按类型归类；工具参数也由本插件自己解析。
 */
export async function* streamResponses(
  client: OpenAI,
  req: ModelRequest,
  opts: { signal: AbortSignal; traits: ModelTraits },
): AsyncGenerator<ModelStreamEvent> {
  const { signal } = opts;
  if (signal.aborted) throw aborted();
  const open = () =>
    client.responses.create({ ...buildRequest(req, opts.traits), stream: true }, { signal });
  let stream: Awaited<ReturnType<typeof open>> | undefined;
  try {
    stream = await open();
    let final: Response | null = null;
    // 终止事件之后不再读：服务端（或中间代理）不关连接时，继续读只会等到空闲超时。
    read: for await (const ev of stream) {
      if (signal.aborted) throw aborted();
      switch (ev.type) {
        case "response.output_text.delta":
        case "response.refusal.delta":
          yield { type: "text_delta", text: ev.delta };
          break;
        case "response.reasoning_summary_part.added":
          if (ev.summary_index > 0) yield { type: "thinking_delta", text: SUMMARY_SEPARATOR };
          break;
        case "response.reasoning_summary_text.delta":
          yield { type: "thinking_delta", text: ev.delta };
          break;
        case "response.completed":
        case "response.incomplete":
          final = ev.response;
          break read;
        case "response.failed": {
          const err = ev.response.error;
          throw new ModelError(
            kindFromCode(err?.code) ?? "server",
            `OpenAI: response failed: ${err?.message ?? "unknown error"}`,
          );
        }
        default:
          break;
      }
      if (signal.aborted) throw aborted();
    }
    if (signal.aborted) throw aborted();
    if (final === null) {
      throw new ModelError("network", "OpenAI stream ended before response.completed");
    }
    yield toComplete(final, req.model);
  } catch (e) {
    throw toModelError(e, signal);
  } finally {
    // 调用方提前停止迭代时也要关掉底层连接
    stream?.controller.abort();
  }
}
