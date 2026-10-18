import type { ContentBlock, ModelMessage, ModelRequest } from "@capybara-hq/plugin-sdk";
import type OpenAI from "openai";
import type { ChatBody, Dialect } from "./dialects.js";

type Message = OpenAI.Chat.ChatCompletionMessageParam;

/** 一次调用的目标：端点上的原始模型 id、方言，以及中途 system 的写法（方言默认，端点可覆盖）。 */
export interface ChatTarget {
  upstreamModel: string;
  dialect: Dialect;
  midConversationSystem: boolean;
}

/**
 * user 消息：工具结果先按块顺序转成 `role: "tool"` 消息（必须紧跟带 tool_calls 的 assistant 消息），
 * 文本块合并成一条 user 消息放在其后。只看消息自身。
 */
function mapUser(content: ContentBlock[]): Message[] {
  const out: Message[] = [];
  const texts: string[] = [];
  for (const b of content) {
    if (b.type === "tool_result") {
      out.push({ role: "tool", tool_call_id: b.callId, content: b.content });
    } else if (b.type === "text") {
      texts.push(b.text);
    }
  }
  if (texts.length > 0) out.push({ role: "user", content: texts.join("\n\n") });
  return out;
}

/**
 * 映射消息。每条消息的映射只取决于它自己与请求模型，不看后续消息、不调整顺序，
 * 所以较早请求的 messages 总是较晚请求的前缀（发给模型的历史只追加）。
 */
function mapMessages(messages: ModelMessage[], req: ModelRequest, t: ChatTarget): Message[] {
  const out: Message[] = [];
  for (const m of messages) {
    if (m.role === "system") {
      out.push(
        t.midConversationSystem
          ? { role: "system", content: m.content }
          : { role: "user", content: `[system] ${m.content}` },
      );
    } else if (m.role === "user") {
      out.push(...mapUser(m.content));
    } else {
      out.push(t.dialect.replayAssistant(m.content, req));
    }
  }
  return out;
}

/** model-provider@2 请求 → Chat Completions 流式请求体。纯函数。 */
export function buildRequest(req: ModelRequest, t: ChatTarget): ChatBody {
  const system = req.system.map((s) => s.text).join("\n\n");
  const body: ChatBody = {
    model: t.upstreamModel,
    // 前缀缓存由服务自动处理（DeepSeek 磁盘缓存、Qwen 隐式缓存、vLLM prefix caching），不打标记
    messages: [
      ...(system !== "" ? [{ role: "system" as const, content: system }] : []),
      ...mapMessages(req.messages, req, t),
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
  }
  t.dialect.applyParams(body, req.params);
  return body;
}
