import { type FakeRequest, type FakeResponse, isPngBase64 } from "@capybara-hq/testing";

/**
 * Handwritten DashScope fixtures in the native shapes recorded live on 2026-11-08 (cn-beijing):
 * the model list (`GET /api/v1/models`), native SSE generation (`event:result` / `event:error`,
 * cumulative usage on every event, `finish_reason` the string "null" until the end) and text
 * embedding (`text_index`, possibly out of order).
 */

export interface RawModel {
  model: string;
  name?: string | null;
  description?: string | null;
  provider?: string;
  inference_provider?: string;
  capabilities?: unknown;
  features?: string[];
  inference_metadata?: { request_modality?: string[]; response_modality?: string[] } | null;
  model_info?: Record<string, number | null> | null;
  inference_offline_info?: { offline_time: string } | null;
}

const limits = (context: number | null, output: number | null) => ({
  context_window: context,
  max_input_tokens: context,
  max_output_tokens: output,
  max_reasoning_tokens: null,
  reasoning_max_input_tokens: null,
  reasoning_max_output_tokens: null,
});

const text = { request_modality: ["Text"], response_modality: ["Text"] };
const vision = { request_modality: ["Text", "Image", "Video"], response_modality: ["Text"] };

/** The interesting entries: every kind, an unknown code, a retired model, a third-party server. */
export const SPECIAL_MODELS: RawModel[] = [
  {
    model: "qwen3.8-flash",
    name: "Qwen3.8-Flash",
    description: "旗舰轻量模型",
    provider: "qwen",
    inference_provider: "aliyun-bailian",
    capabilities: ["TG", "VU", "Reasoning"],
    features: ["function-calling", "cache", "structured-outputs"],
    inference_metadata: vision,
    model_info: limits(1_000_000, 131_072),
    inference_offline_info: null,
  },
  {
    model: "qwen-flash",
    name: "Qwen-Flash",
    description: "速度快、成本低",
    provider: "qwen",
    inference_provider: "aliyun-bailian",
    capabilities: ["Reasoning", "TG"],
    features: ["function-calling", "cache"],
    inference_metadata: text,
    model_info: limits(1_000_000, 32_768),
    inference_offline_info: null,
  },
  {
    // a hosted vendor's model served by Bailian itself: listed, publisher deepseek
    model: "deepseek-v4-pro",
    name: "DeepSeek-V4-Pro",
    provider: "deepseek",
    inference_provider: "aliyun-bailian",
    capabilities: ["TG"],
    features: ["function-calling"],
    inference_metadata: text,
    model_info: limits(1_000_000, 393_216),
    inference_offline_info: null,
  },
  {
    // null limits: conservative defaults
    model: "decision-model-preview",
    name: null,
    provider: "qwen-domain-model",
    inference_provider: "aliyun-bailian",
    capabilities: ["TG"],
    features: [],
    inference_metadata: text,
    model_info: limits(null, null),
    inference_offline_info: null,
  },
  {
    // retired: offline_time becomes retiresAt
    model: "qwen3.5-plus",
    name: "Qwen3.5-Plus",
    provider: "qwen",
    inference_provider: "aliyun-bailian",
    capabilities: ["TG", "Reasoning", "VU"],
    features: ["function-calling"],
    inference_metadata: vision,
    model_info: limits(1_000_000, 65_536),
    inference_offline_info: { offline_time: "2027-01-19 10:00:00" },
  },
  {
    // a third-party inference provider: left out
    model: "siliconflow/deepseek-v3.2",
    name: "DeepSeek-V3.2",
    provider: "deepseek",
    inference_provider: "siliconflow",
    capabilities: ["TG", "Reasoning"],
    features: [],
    inference_metadata: text,
    model_info: limits(163_840, 65_536),
    inference_offline_info: null,
  },
  {
    model: "text-embedding-v4",
    name: "Text-Embedding-V4",
    provider: "qwen-domain-model",
    inference_provider: "aliyun-bailian",
    capabilities: ["TR"],
    features: [],
    inference_metadata: text,
    model_info: limits(null, null),
    inference_offline_info: null,
  },
  {
    // TR but not in the embedding table and not a rerank model: skipped with a warn
    model: "text-embedding-async-v2",
    provider: "qwen-domain-model",
    inference_provider: "aliyun-bailian",
    capabilities: ["TR"],
    features: [],
    inference_metadata: text,
    model_info: limits(null, null),
    inference_offline_info: null,
  },
  {
    model: "gte-rerank-v2",
    provider: "qwen-domain-model",
    inference_provider: "aliyun-bailian",
    capabilities: ["TR"],
    features: [],
    inference_metadata: text,
    model_info: limits(30_000, 0),
    inference_offline_info: null,
  },
  {
    model: "wan2.7-t2i",
    provider: "wan",
    inference_provider: "aliyun-bailian",
    capabilities: ["IG"],
    inference_metadata: { request_modality: ["Text"], response_modality: ["Image"] },
    model_info: null,
  },
  {
    model: "wan2.7-t2v",
    provider: "wan",
    inference_provider: "aliyun-bailian",
    capabilities: ["VG"],
    inference_metadata: null,
    model_info: null,
  },
  {
    model: "paraformer-v2",
    provider: "qwen",
    inference_provider: "aliyun-bailian",
    capabilities: ["ASR"],
  },
  {
    model: "cosyvoice-v3",
    provider: "qwen",
    inference_provider: "aliyun-bailian",
    capabilities: ["TTS"],
  },
  // no SDK kind: skipped
  { model: "multimodal-embedding-v1", inference_provider: "aliyun-bailian", capabilities: ["ME"] },
  {
    model: "qwen3-omni-realtime",
    inference_provider: "aliyun-bailian",
    capabilities: ["Realtime-Omni"],
  },
  { model: "tripo-3d", inference_provider: "aliyun-bailian", capabilities: ["3D-generation"] },
  { model: "future-model", inference_provider: "aliyun-bailian", capabilities: ["Hologram"] },
  // malformed entries never fail the list
  { model: "broken-caps", inference_provider: "aliyun-bailian", capabilities: "TG" },
  { model: "", inference_provider: "aliyun-bailian", capabilities: ["TG"] },
];

/** 210 TTS fillers ahead of the special entries, so the list spans two pages of 200. */
export function fixtureModels(): RawModel[] {
  const fillers: RawModel[] = Array.from({ length: 210 }, (_, i) => ({
    model: `cosyvoice-filler-${i}`,
    provider: "qwen",
    inference_provider: "aliyun-bailian",
    capabilities: ["TTS"],
  }));
  return [...fillers, ...SPECIAL_MODELS];
}

/** `GET /api/v1/models`: paging by `page_no` / `page_size` (max 200, as the live API) and `model`. */
export function listResponse(path: string, models: RawModel[]): FakeResponse {
  const url = new URL(path, "http://fixture");
  const pageNo = Number(url.searchParams.get("page_no") ?? "1");
  const pageSize = Number(url.searchParams.get("page_size") ?? "20");
  if (pageSize > 200) {
    return {
      status: 200,
      json: {
        code: "10110400",
        message: "Pagination parameter page_size exceeds the length limit",
        success: false,
        output: null,
        request_id: "req-fixture",
      },
    };
  }
  const only = url.searchParams.get("model");
  const all = only !== null ? models.filter((m) => m.model === only) : models;
  const page = all.slice((pageNo - 1) * pageSize, pageNo * pageSize);
  return {
    status: 200,
    json: {
      code: null,
      message: null,
      success: true,
      request_id: "req-fixture",
      output: { total: all.length, page_no: pageNo, page_size: pageSize, models: page },
    },
  };
}

export interface RawUsage {
  input_tokens: number;
  output_tokens: number;
  total_tokens?: number;
  prompt_tokens_details?: Record<string, unknown>;
  output_tokens_details?: Record<string, unknown>;
}

export interface ToolCallFixture {
  id: string;
  name: string;
  args: string;
}

const pieces = (s: string, n: number): string[] => {
  const out: string[] = [];
  for (let i = 0; i < s.length; i += n) out.push(s.slice(i, i + n));
  return out;
};

/** One native generation stream. `multimodal` writes `content` as `[{ text }]` arrays. */
export function sseGeneration(opts: {
  reasoning?: string;
  text?: string;
  toolCalls?: ToolCallFixture[];
  /** null: the stream ends without a finish_reason (cut). */
  finish: "stop" | "tool_calls" | "length" | null;
  usage?: RawUsage;
  multimodal?: boolean;
  /** An `event:error` after the deltas instead of the final event. */
  midStreamError?: { code: string; message: string };
  delayMs?: number;
}): FakeResponse {
  const usage = opts.usage ?? { input_tokens: 20, output_tokens: 8, total_tokens: 28 };
  const events: { event?: string; data: string }[] = [];
  const content = (t: string) => (opts.multimodal ? (t === "" ? [] : [{ text: t }]) : t);
  const push = (message: Record<string, unknown>, finish: string) =>
    events.push({
      event: "result",
      data: JSON.stringify({
        output: {
          choices: [{ finish_reason: finish, message: { role: "assistant", ...message } }],
        },
        usage,
        request_id: "req-fixture",
      }),
    });
  for (const r of pieces(opts.reasoning ?? "", 5)) {
    push({ content: content(""), reasoning_content: r }, "null");
  }
  for (const t of pieces(opts.text ?? "", 6)) push({ content: content(t) }, "null");
  (opts.toolCalls ?? []).forEach((c, index) => {
    push(
      {
        content: content(""),
        tool_calls: [
          { id: c.id, index, type: "function", function: { name: c.name, arguments: "" } },
        ],
      },
      "null",
    );
    for (const a of pieces(c.args, 7)) {
      push(
        {
          content: content(""),
          tool_calls: [{ id: "", index, type: "function", function: { arguments: a } }],
        },
        "null",
      );
    }
  });
  if (opts.midStreamError) {
    events.push({
      event: "error",
      data: JSON.stringify({ ...opts.midStreamError, request_id: "req-fixture" }),
    });
  } else if (opts.finish !== null) {
    push(
      { content: content(""), ...(opts.reasoning ? { reasoning_content: "" } : {}) },
      opts.finish,
    );
  }
  return { status: 200, sse: events, ...(opts.delayMs ? { delayMs: opts.delayMs } : {}) };
}

/** A DashScope error body. */
export function errorJson(
  status: number,
  code: string,
  message: string,
  headers?: Record<string, string>,
): FakeResponse {
  return {
    status,
    json: { request_id: "req-fixture", code, message },
    ...(headers ? { headers } : {}),
  };
}

interface Body {
  model: string;
  input: { messages: Msg[]; texts?: string[] };
  parameters: Record<string, unknown>;
}
interface Msg {
  role: string;
  content: unknown;
  tool_calls?: unknown[];
  reasoning_content?: string;
}

const partsOf = (content: unknown): Record<string, unknown>[] =>
  Array.isArray(content) ? (content as Record<string, unknown>[]) : [{ text: content }];

/** Deterministic vector per text, of `dim` numbers. */
export function vectorFor(text: string, dim: number): number[] {
  let h = 0;
  for (const ch of text) h = (h * 31 + ch.charCodeAt(0)) % 1000;
  return Array.from({ length: dim }, (_, i) => ((h + i) % 97) / 97);
}

/**
 * Routes for the conformance suite: list, both generation endpoints, embeddings. Text-only models
 * on the multimodal endpoint (and the reverse) answer like the live API ("url error").
 */
export function bailianRoutes(
  models: RawModel[] = fixtureModels(),
): (req: FakeRequest) => FakeResponse {
  const cacheSeen = new Set<string>();
  const isVision = (id: string) =>
    models.some(
      (m) => m.model === id && Array.isArray(m.capabilities) && m.capabilities.includes("VU"),
    );
  return (req) => {
    if (req.path.startsWith("/api/v1/models")) return listResponse(req.path, models);
    const body = req.body as Body;
    if (req.path === "/api/v1/services/embeddings/text-embedding/text-embedding") {
      const dim = Number(body.parameters?.dimension ?? 1024);
      const texts = body.input.texts ?? [];
      // reversed on purpose: the provider must sort by text_index
      const embeddings = texts
        .map((t, i) => ({ text_index: i, embedding: vectorFor(t, dim) }))
        .reverse();
      return {
        status: 200,
        json: { output: { embeddings }, usage: { total_tokens: texts.length * 3 } },
      };
    }
    const multimodal = req.path === "/api/v1/services/aigc/multimodal-generation/generation";
    if (!multimodal && req.path !== "/api/v1/services/aigc/text-generation/generation") {
      return errorJson(404, "InvalidParameter", `no route ${req.path}`);
    }
    if (multimodal !== isVision(body.model)) {
      return errorJson(400, "InvalidParameter", "url error, please check url！");
    }
    const msgs = body.input.messages;
    const last = msgs[msgs.length - 1];
    const tools = Array.isArray(body.parameters.tools) && body.parameters.tools.length > 0;
    const thinking = body.parameters.enable_thinking === true;
    const sys = msgs[0]?.role === "system" ? partsOf(msgs[0].content) : [];
    const cached = sys.find((p) => p.cache_control !== undefined && String(p.text).length > 2000);
    let usage: RawUsage = { input_tokens: 30, output_tokens: 9, total_tokens: 39 };
    if (cached !== undefined) {
      const key = String(cached.text);
      const n = Math.ceil(key.length / 4);
      usage = {
        input_tokens: n + 10,
        output_tokens: 5,
        prompt_tokens_details: cacheSeen.has(key)
          ? { cached_tokens: n, cache_creation_input_tokens: 0 }
          : { cached_tokens: 0, cache_creation_input_tokens: n },
      };
      cacheSeen.add(key);
    }
    const reasoning = thinking ? "Let me think about this." : undefined;
    const base = { multimodal, usage, ...(reasoning ? { reasoning } : {}) };
    if (last?.role === "tool") {
      return sseGeneration({ ...base, text: "It is sunny in Paris, 22C.", finish: "stop" });
    }
    const lastParts = partsOf(last?.content);
    const image = lastParts.find((p) => typeof p.image === "string");
    if (image !== undefined) {
      const data = String(image.image).replace(/^data:image\/png;base64,/, "");
      return sseGeneration({
        ...base,
        text: isPngBase64(data) ? "Red." : "Unknown.",
        finish: "stop",
      });
    }
    if (tools && msgs.every((m) => m.role !== "tool")) {
      return sseGeneration({
        ...base,
        toolCalls: [{ id: "call_fixture_1", name: "get_weather", args: '{"city": "Paris"}' }],
        finish: "tool_calls",
      });
    }
    return sseGeneration({ ...base, text: "Hello there, friend!", finish: "stop" });
  };
}
