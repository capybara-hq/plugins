import {
  type ContentBlock,
  ModelError,
  type ModelRequest,
  type ModelStreamEvent,
  type ModelUsage,
  type StopReason,
} from "@capybara-hq/plugin-sdk";
import type { Target } from "./config.js";
import { type ErrorBody, errorFromBody, errorFromResponse, toModelError } from "./errors.js";
import { headers } from "./http.js";
import type { Endpoint } from "./list.js";
import { buildRequest, type ThinkingOpaque } from "./map-request.js";
import { PROVIDER } from "./tables.js";

/** One server-sent event. */
export interface SseEvent {
  event: string;
  data: string;
}

/** Splits a byte stream into server-sent events (`event:` / `data:` lines, blank-line separated). */
export async function* parseSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const decoder = new TextDecoder();
  let buf = "";
  let event = "";
  let data: string[] = [];
  const flush = (): SseEvent | null => {
    const out = data.length > 0 ? { event: event || "message", data: data.join("\n") } : null;
    event = "";
    data = [];
    return out;
  };
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      buf += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let nl = buf.indexOf("\n");
      while (nl >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, "");
        buf = buf.slice(nl + 1);
        if (line === "") {
          const ev = flush();
          if (ev) yield ev;
        } else if (!line.startsWith(":")) {
          const i = line.indexOf(":");
          const field = i < 0 ? line : line.slice(0, i);
          let value = i < 0 ? "" : line.slice(i + 1);
          if (value.startsWith(" ")) value = value.slice(1);
          if (field === "event") event = value;
          else if (field === "data") data.push(value);
        }
        nl = buf.indexOf("\n");
      }
      if (done) {
        if (buf !== "") {
          // a last line without its newline
          const i = buf.indexOf(":");
          if (i >= 0 && buf.slice(0, i) === "data") data.push(buf.slice(i + 1).replace(/^ /, ""));
        }
        const ev = flush();
        if (ev) yield ev;
        return;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/** A native stream event's payload (live shape 2026-11-08). */
interface Chunk extends ErrorBody {
  output?: {
    choices?: {
      /** "null" (a string) until the last event; then stop / length / tool_calls. */
      finish_reason?: string | null;
      message?: {
        content?: string | { text?: string }[] | null;
        reasoning_content?: string | null;
        tool_calls?: {
          index?: number;
          id?: string;
          function?: { name?: string; arguments?: string };
        }[];
      };
    }[];
  };
  usage?: RawUsage;
}

/**
 * Native usage, cumulative on every event. `input_tokens` includes the cached and the cache-written
 * tokens (live 2026-11-08: 5035 input with `cached_tokens` 5023 on the hit, with
 * `cache_creation_input_tokens` 5023 on the write), so both are subtracted.
 */
export interface RawUsage {
  input_tokens?: number;
  output_tokens?: number;
  prompt_tokens_details?: {
    cached_tokens?: number;
    cache_creation_input_tokens?: number;
  };
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

export function usageOf(raw: RawUsage | null): ModelUsage {
  const cached = num(raw?.prompt_tokens_details?.cached_tokens);
  const written = num(raw?.prompt_tokens_details?.cache_creation_input_tokens);
  return {
    inputTokens: Math.max(0, num(raw?.input_tokens) - cached - written),
    outputTokens: num(raw?.output_tokens),
    cacheReadTokens: cached,
    cacheWriteTokens: written,
  };
}

const textOf = (content: string | { text?: string }[] | null | undefined): string =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.map((p) => (typeof p?.text === "string" ? p.text : "")).join("")
      : "";

/** Tool arguments parsed here: invalid JSON or a non-object is invalid_request. */
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
    default:
      return "other";
  }
}

const aborted = () => new ModelError("aborted", "Request aborted");

const GENERATION_PATH: Record<Endpoint, string> = {
  text: "/api/v1/services/aigc/text-generation/generation",
  multimodal: "/api/v1/services/aigc/multimodal-generation/generation",
};

/**
 * One native streaming generation as model-provider@2 events: ends with exactly one
 * message_complete or throws ModelError (an `event:error` by its code, a stream ending before a
 * finish_reason as network). Text, thinking and tool calls (by index, arguments concatenated) are
 * accumulated from the raw events.
 */
export async function* streamGeneration(
  t: Target,
  req: ModelRequest,
  endpoint: Endpoint,
  signal: AbortSignal,
): AsyncGenerator<ModelStreamEvent> {
  if (signal.aborted) throw aborted();
  const body = buildRequest(req, endpoint);
  // Our own controller also closes the connection when the caller stops iterating early
  const ac = new AbortController();
  const onAbort = () => ac.abort();
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    const res = await fetch(`${t.baseUrl}${GENERATION_PATH[endpoint]}`, {
      method: "POST",
      headers: headers(t, {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        "X-DashScope-SSE": "enable",
      }),
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    if (!res.ok) throw await errorFromResponse(res);
    if (res.body === null) throw new ModelError("network", "Bailian: empty response body");

    let text = "";
    let reasoning = "";
    const tools = new Map<number, { id: string; name: string; args: string }>();
    let finish: string | null = null;
    let usage: RawUsage | null = null;
    for await (const ev of parseSse(res.body)) {
      if (signal.aborted) throw aborted();
      let chunk: Chunk;
      try {
        chunk = JSON.parse(ev.data) as Chunk;
      } catch (cause) {
        throw new ModelError("server", "Bailian: malformed stream event", { cause });
      }
      if (ev.event === "error" || (chunk.code && chunk.output === undefined)) {
        throw errorFromBody(undefined, chunk);
      }
      if (chunk.usage) usage = chunk.usage;
      const choice = chunk.output?.choices?.[0];
      const msg = choice?.message;
      const r = msg?.reasoning_content;
      if (typeof r === "string" && r !== "") {
        reasoning += r;
        yield { type: "thinking_delta", text: r };
      }
      const delta = textOf(msg?.content);
      if (delta !== "") {
        text += delta;
        yield { type: "text_delta", text: delta };
      }
      for (const tc of msg?.tool_calls ?? []) {
        const index = typeof tc.index === "number" ? tc.index : 0;
        const acc = tools.get(index) ?? { id: "", name: "", args: "" };
        if (tc.id) acc.id = tc.id;
        if (tc.function?.name) acc.name = tc.function.name;
        if (tc.function?.arguments) acc.args += tc.function.arguments;
        tools.set(index, acc);
      }
      const f = choice?.finish_reason;
      if (typeof f === "string" && f !== "" && f !== "null") {
        finish = f;
        // The last event carries the final usage; the server closes the stream after it
        break;
      }
    }
    if (signal.aborted) throw aborted();
    if (finish === null) {
      throw new ModelError("network", "Bailian: stream ended before finish_reason");
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
    // Cut by max tokens: the arguments are incomplete, the calls are not returned
    const calls =
      finish === "length" ? [] : [...tools.entries()].sort(([a], [b]) => a - b).map(([, c]) => c);
    for (const [i, c] of calls.entries()) {
      if (c.name === "")
        throw new ModelError("invalid_request", `Tool call #${i} has no function name`);
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
    signal.removeEventListener("abort", onAbort);
    ac.abort();
  }
}
