import {
  type FakeRequest,
  type FakeResponse,
  isPngBase64,
  pdfSampleWord,
} from "@capybara-hq/testing";

/**
 * Handwritten Ark fixtures in the native shapes seen live on 2026-11-08 (cn-beijing): the data
 * plane's `GET /api/v3/models`, streaming `POST /api/v3/chat/completions` (`data: <chunk>` …
 * `data: [DONE]`, `delta.reasoning_content`, one `delta.encrypted_content` between thinking and
 * answer) and `POST /api/v3/embeddings/multimodal` (one fused vector per call, `data` an object).
 */

export const SEED = "doubao-seed-2-0-lite-260428";
export const DEEPSEEK = "deepseek-v4-flash-ga-260731";
export const EMBED = "doubao-embedding-vision-251215";
export const SEEDREAM = "doubao-seedream-5-0-flash-260915";
export const SEEDREAM_4 = "doubao-seedream-4-0-20260415";

const features = (o: { tools?: boolean; cache?: boolean; thinking?: string[] } = {}) => ({
  batch: { batch_chat: false, batch_job: false },
  cache: { prefix_cache: o.cache ?? false, session_cache: false },
  structured_outputs: { json_object: false, json_schema: false },
  ...(o.thinking !== undefined ? { thinking: { types: o.thinking } } : {}),
  tools: { function_calling: o.tools ?? false, web_search: false },
});

/** Entries copied from the live list (trimmed), plus odd ones the mapping must survive. */
export const MODELS_BODY = {
  object: "list",
  data: [
    {
      api_supported: { "chat/completions": true, responses: true },
      context_window: 1048576,
      domain: "LLM",
      effort: { default_level: "max", supported_levels: ["low", "high", "max"] },
      features: features({ tools: true, cache: true, thinking: ["enabled", "disabled"] }),
      id: "kimi-k3-1-pro-261024",
      max_output_tokens: 1048576,
      modalities: { input_modalities: ["text", "image", "video"], output_modalities: ["text"] },
      name: "kimi-k3-1-pro",
      object: "model",
      status: "Published",
      task_type: ["text_generation", "visual_question_answering"],
      token_limits: { context_window: 1048576, max_output_token_length: 1048576 },
      version: "261024",
    },
    {
      api_supported: { "chat/completions": true, messages: true, responses: true },
      context_window: 262144,
      domain: "VLM",
      effort: { default_level: "medium", supported_levels: ["low", "medium", "high", "minimal"] },
      features: features({ tools: true, cache: true, thinking: ["enabled", "disabled"] }),
      id: SEED,
      max_output_tokens: 131072,
      modalities: {
        input_modalities: ["text", "image", "video", "audio"],
        output_modalities: ["text"],
      },
      name: "doubao-seed-2-0-lite",
      object: "model",
      status: "Published",
      version: "260428",
    },
    {
      api_supported: { "chat/completions": true, messages: true, responses: true },
      context_window: 1048576,
      domain: "LLM",
      effort: {
        default_level: "high",
        supported_levels: ["none", "low", "high", "max", "minimal"],
      },
      features: features({ tools: true, cache: true, thinking: ["enabled", "disabled"] }),
      id: DEEPSEEK,
      max_output_tokens: 393216,
      modalities: { input_modalities: ["text"], output_modalities: ["text"] },
      name: "deepseek-v4-flash-ga",
      object: "model",
      status: "Published",
      version: "260731",
    },
    {
      api_supported: { "chat/completions": true },
      context_window: 1048576,
      domain: "LLM",
      effort: { default_level: "max", supported_levels: ["low", "high", "max"] },
      features: features({ tools: true, cache: true, thinking: ["auto", "enabled", "disabled"] }),
      id: "glm-5-3-flash-260828",
      max_output_tokens: 131072,
      modalities: { input_modalities: ["text", "image", "video"], output_modalities: ["text"] },
      name: "glm-5-3-flash",
      object: "model",
      status: "Published",
      version: "260828",
    },
    {
      api_supported: { "chat/completions": true },
      context_window: 131072,
      domain: "LLM",
      features: features({ tools: false, cache: true }),
      id: "doubao-seed-character-251128",
      max_output_tokens: 32768,
      modalities: { input_modalities: ["text"], output_modalities: ["text"] },
      name: "doubao-seed-character",
      object: "model",
      status: "Retiring",
      version: "251128",
    },
    // A chat model the list gives no limits for: conservative defaults
    {
      api_supported: { "chat/completions": true },
      domain: "LLM",
      id: "mystery-chat-260101",
      name: "mystery-chat",
      object: "model",
      status: "Published",
    },
    {
      api_supported: { "embeddings/multimodal": true },
      context_window: 131072,
      domain: "Embedding",
      features: features(),
      id: EMBED,
      modalities: { input_modalities: ["text", "image", "video"] },
      name: "doubao-embedding-vision",
      object: "model",
      status: "Published",
      version: "251215",
    },
    // Retiring, empty domain, in the bundled table: listed as embedding
    {
      api_supported: { "embeddings/multimodal": true },
      domain: "",
      id: "doubao-embedding-vision-250615",
      name: "doubao-embedding-vision",
      object: "model",
      status: "Retiring",
      version: "250615",
    },
    // A prototype member's name is not a bundled embedding model: skipped
    {
      api_supported: { "embeddings/multimodal": true },
      domain: "Embedding",
      id: "toString",
      object: "model",
      status: "Published",
    },
    // Text-only legacy embedding with no bundled facts: skipped
    {
      api_supported: { embeddings: true },
      domain: "",
      id: "doubao-embedding-large-text-250515",
      name: "doubao-embedding-large",
      object: "model",
      status: "Retiring",
    },
    {
      api_supported: { "images/generations": true },
      domain: "ImageGeneration",
      id: SEEDREAM,
      modalities: { input_modalities: ["text", "image"], output_modalities: ["image"] },
      name: "doubao-seedream-5-0-flash",
      object: "model",
      status: "Published",
      task_type: ["text_to_image", "image_to_image"],
      version: "260915",
    },
    // Live shape (2026-11-18): no api_supported, no modalities
    {
      domain: "ImageGeneration",
      id: SEEDREAM_4,
      name: "doubao-seedream-4-0",
      object: "model",
      status: "Published",
      version: "20260415",
    },
    // An image model with no bundled facts: listed, not callable (no imageGeneration)
    {
      api_supported: { "images/generations": true },
      domain: "ImageGeneration",
      id: "doubao-seededit-3-0-i2i-250628",
      name: "doubao-seededit-3-0-i2i",
      object: "model",
      status: "Published",
    },
    {
      api_supported: { "contents/generations": true },
      domain: "VideoGeneration",
      id: "doubao-seedance-2-5-260628",
      name: "doubao-seedance-2-5",
      object: "model",
      status: "Published",
    },
    // No SDK kind: skipped
    {
      api_supported: { "contents/generations": true },
      domain: "3DGeneration",
      id: "doubao-seed3d-2-0-260328",
      name: "doubao-seed3d-2-0",
      object: "model",
      status: "Published",
    },
    {
      api_supported: { "chat/completions": true },
      domain: "Router",
      id: "doubao-smart-router-250928",
      name: "doubao-smart-router",
      object: "model",
      status: "Published",
    },
    { domain: "", id: "hitem3d-2-0-251223", name: "hitem3d-2-0", object: "model" },
    {
      api_supported: { "chat/completions": true },
      domain: "LLM",
      id: "old-chat-240101",
      object: "model",
      status: "Shutdown",
    },
    { object: "model", domain: "LLM" },
    "not an object",
  ],
};

export type RawUsage = Record<string, unknown> & {
  prompt_tokens: number;
  completion_tokens: number;
};

export const usageOf = (u: { total: number; cached?: number; output: number }): RawUsage => ({
  prompt_tokens: u.total,
  completion_tokens: u.output,
  total_tokens: u.total + u.output,
  prompt_tokens_details: { cached_tokens: u.cached ?? 0 },
  completion_tokens_details: { reasoning_tokens: 0 },
});

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

/** One streaming chat completion. */
export function sseChat(opts: {
  model: string;
  reasoning?: string | undefined;
  encrypted?: string | undefined;
  text?: string;
  toolCalls?: ToolCallFixture[];
  /** null: no finish_reason (a cut stream). */
  finish: "stop" | "tool_calls" | "length" | "content_filter" | null;
  usage?: RawUsage;
  omitDone?: boolean;
  midStreamError?: { message: string; type?: string; code?: string };
}): FakeResponse {
  const data: string[] = [];
  const chunk = (choices: unknown[], extra: Record<string, unknown> = {}) =>
    data.push(
      JSON.stringify({
        id: "021fixture",
        object: "chat.completion.chunk",
        created: 1_790_000_000,
        model: opts.model,
        service_tier: "default",
        choices,
        ...extra,
      }),
    );
  const delta = (d: Record<string, unknown>) =>
    chunk([{ index: 0, delta: d, finish_reason: null }]);

  delta({ role: "assistant", content: "" });
  for (const r of pieces(opts.reasoning ?? "", 5)) delta({ content: "", reasoning_content: r });
  if (opts.encrypted !== undefined) delta({ content: "", encrypted_content: opts.encrypted });
  for (const t of pieces(opts.text ?? "", 6)) delta({ content: t });
  (opts.toolCalls ?? []).forEach((c, index) => {
    delta({
      tool_calls: [
        { index, id: c.id, type: "function", function: { name: c.name, arguments: "" } },
      ],
    });
    for (const a of pieces(c.args, 4))
      delta({ tool_calls: [{ index, function: { arguments: a } }] });
  });
  if (opts.midStreamError !== undefined) data.push(JSON.stringify({ error: opts.midStreamError }));
  if (opts.finish !== null) {
    chunk([{ index: 0, delta: { content: "" }, finish_reason: opts.finish }]);
    if (opts.usage) chunk([], { usage: opts.usage });
  }
  if (!opts.omitDone) data.push("[DONE]");
  return { status: 200, sse: data.map((d) => ({ data: d })) };
}

/** Ark's error body: `{ error: { code, message, param, type } }`. */
export const errorJson = (
  status: number,
  error: { code: string; message: string; type?: string; param?: string },
  headers?: Record<string, string>,
): FakeResponse => ({
  status,
  json: { error: { param: "", type: "BadRequest", ...error } },
  ...(headers !== undefined ? { headers } : {}),
});

/** A deterministic unit vector for a text. */
export function vectorFor(text: string, dims: number): number[] {
  let h = 2166136261;
  for (const ch of text) h = Math.imul(h ^ (ch.codePointAt(0) ?? 0), 16777619) >>> 0;
  const v = Array.from({ length: dims }, (_, i) => Math.sin(h + i * 7.13));
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return v.map((x) => x / norm);
}

interface Msg {
  role: string;
  content?: unknown;
  reasoning_content?: string;
  encrypted_content?: string;
  tool_calls?: unknown[];
}

interface Body {
  model: string;
  messages: Msg[];
  stream?: boolean;
  stream_options?: { include_usage?: boolean };
  max_tokens?: number;
  max_completion_tokens?: number;
  tools?: { type: string; function: { name: string } }[];
  thinking?: { type: string };
}

function parseDataUrl(v: unknown): [string, string] | null {
  const m = typeof v === "string" ? /^data:([^;,]+);base64,(.*)$/.exec(v) : null;
  return m?.[1] !== undefined && m[2] !== undefined ? [m[1], m[2]] : null;
}

function mediaAnswer(messages: Msg[]): string | null {
  for (const m of messages) {
    if (m.role !== "user") continue;
    const parts = Array.isArray(m.content)
      ? (m.content as Record<string, unknown>[])
      : [{ type: "text", text: m.content }];
    for (const part of parts) {
      if (part.type === "image_url") {
        const d = parseDataUrl((part.image_url as { url?: unknown }).url);
        if (d?.[0] === "image/png" && isPngBase64(d[1])) return "Red.";
      }
      if (part.type === "file") {
        const d = parseDataUrl((part.file as { file_data?: unknown }).file_data);
        const word = d !== null ? pdfSampleWord(d[1]) : null;
        if (word !== null) return word;
      }
      if (part.type === "text") {
        const word = /secret word is (\w+)/.exec(String(part.text))?.[1];
        if (word !== undefined) return word;
      }
    }
  }
  return null;
}

/** Reasons a request breaks the protocol (the fixture guards it the way the API would). */
function violation(b: Body, issued: Set<string>): string | null {
  if (b.stream !== true) return "stream must be true";
  if (b.stream_options?.include_usage !== true) return "stream_options.include_usage must be true";
  if (b.max_tokens !== undefined && b.max_completion_tokens !== undefined)
    return "max_tokens and max_completion_tokens cannot be set at the same time";
  if (typeof b.max_completion_tokens !== "number") return "max_completion_tokens is expected";
  if (b.messages.some((m, i) => m.role === "system" && i > 0))
    return "mid-conversation system messages are sent as [system] user turns";
  for (const m of b.messages) {
    if (m.encrypted_content !== undefined && !issued.has(m.encrypted_content))
      return "Invalid signature";
    if (m.encrypted_content !== undefined && m.reasoning_content !== undefined)
      return "encrypted_content takes priority; reasoning_content is not sent with it";
    if (m.reasoning_content !== undefined && !b.model.startsWith("deepseek-"))
      return "reasoning_content is replayed only to deepseek models";
    if (!Array.isArray(m.content)) continue;
    for (const part of m.content as Record<string, unknown>[]) {
      if (m.role !== "user") return "content parts are only expected in user messages";
      if (part.type === "file") {
        const f = part.file as { filename?: unknown; file_data?: unknown } | undefined;
        if (typeof f?.filename !== "string") return "file.filename is required";
        if (parseDataUrl(f.file_data)?.[0] !== "application/pdf")
          return "file.file_data must be a PDF data URL";
      } else if (part.type === "image_url") {
        if (parseDataUrl((part.image_url as { url?: unknown }).url) === null)
          return "image_url.url must be a data URL";
      } else if (part.type !== "text") return `unknown content part ${String(part.type)}`;
    }
  }
  return null;
}

/** A tiny JPEG (SOI + JFIF APP0 + EOI): the bytes the plugin sniffs, nothing more. */
export const FAKE_JPEG_BASE64 = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01,
  0x00, 0x01, 0x00, 0x00, 0xff, 0xd9,
]).toString("base64");

export interface ImageBody {
  model?: unknown;
  prompt?: unknown;
  size?: unknown;
  image?: unknown;
  response_format?: unknown;
  watermark?: unknown;
  [k: string]: unknown;
}

/** `POST /api/v3/images/generations` in the shape seen live (2026-11-18, seedream 5.0 flash). */
export const imageOk = (o: { size: string; b64?: string; format?: string }): FakeResponse => {
  const [w, h] = o.size.split("x").map(Number);
  const tokens = ((w ?? 0) * (h ?? 0)) / 256;
  return {
    status: 200,
    json: {
      model: SEEDREAM,
      created: 1_794_980_225,
      data: [
        {
          size: o.size,
          output_format: o.format ?? "jpeg",
          background: "opaque",
          b64_json: o.b64 ?? FAKE_JPEG_BASE64,
        },
      ],
      usage: { input_images: 0, generated_images: 1, output_tokens: tokens, total_tokens: tokens },
    },
  };
};

/** Seedream's checks as the API makes them (live 2026-11-18): pixel `WxH`, area per family. */
function imageRoute(b: ImageBody): FakeResponse {
  const range: Record<string, [number, number]> = {
    [SEEDREAM]: [921_600, 4_624_220],
    [SEEDREAM_4]: [921_600, 16_777_216],
  };
  const r = typeof b.model === "string" ? range[b.model] : undefined;
  if (r === undefined) {
    return errorJson(404, {
      code: "InvalidEndpointOrModel.NotFound",
      message: `The model or endpoint ${String(b.model)} does not exist or you do not have access to it.`,
      type: "Not Found",
    });
  }
  const bad = (message: string, param = "") =>
    errorJson(400, { code: "InvalidParameter", message, param });
  if (b.response_format !== "b64_json") return bad("response_format must be b64_json here");
  if (b.watermark !== false) return bad("watermark must be false here");
  if ("n" in b || "sequential_image_generation" in b) return bad("one image per request here");
  if (typeof b.prompt !== "string" || b.prompt === "") return bad("prompt is required", "prompt");
  const m = typeof b.size === "string" ? /^(\d+)x(\d+)$/.exec(b.size) : null;
  if (m === null) return bad("must be 'WIDTHxHEIGHT' or a supported size preset", "size");
  const area = Number(m[1]) * Number(m[2]);
  if (area < r[0] || area > r[1]) return bad(`image area out of range`, "size");
  if (b.image !== undefined) {
    const refs = Array.isArray(b.image) ? b.image : [b.image];
    if (refs.length === 0 || refs.some((x) => parseDataUrl(x) === null))
      return bad("image must be a data URL or URL", "image");
  }
  if (b.prompt.includes("forbidden")) {
    return errorJson(400, {
      code: "OutputImageSensitiveContentDetected",
      message: "The request failed because the output image may contain sensitive information.",
    });
  }
  return imageOk({ size: b.size as string });
}

/** Routes for the conformance suite: `/api/v3/models`, chat, multimodal embeddings and images. */
export function arkRoutes(): (req: FakeRequest) => FakeResponse {
  const cachedPrefixes = new Set<string>();
  const issued = new Set<string>();
  let n = 0;
  return (req) => {
    if (req.headers.authorization !== "Bearer ark-fixture") {
      return errorJson(401, {
        code: "AuthenticationError",
        message: "The API key format is incorrect.",
        type: "Unauthorized",
      });
    }
    if (req.path === "/api/v3/models") return { status: 200, json: MODELS_BODY };
    if (req.path === "/api/v3/embeddings/multimodal") {
      const b = req.body as {
        model: string;
        input: { type: string; text: string }[];
        dimensions?: number;
      };
      if (b.model !== EMBED && b.model !== "doubao-embedding-vision-250615")
        return errorJson(404, {
          code: "InvalidEndpointOrModel.NotFound",
          message: "not found",
          type: "Not Found",
        });
      if (b.dimensions !== undefined && b.dimensions !== 1024 && b.dimensions !== 2048)
        return errorJson(400, {
          code: "InvalidParameter",
          message: "invalid",
          param: "dimensions",
        });
      // Ark fuses every input of a call into one vector
      const text = b.input.map((i) => i.text).join("\u0000");
      return {
        status: 200,
        json: {
          created: 1_790_000_000,
          id: "021fixture",
          model: b.model,
          object: "list",
          data: { embedding: vectorFor(text, b.dimensions ?? 2048), object: "embedding" },
          usage: { prompt_tokens: 5, total_tokens: 5 },
        },
      };
    }
    if (req.path === "/api/v3/images/generations") return imageRoute(req.body as ImageBody);
    if (req.path !== "/api/v3/chat/completions") {
      return errorJson(404, { code: "NotFound", message: "not found", type: "Not Found" });
    }
    const b = req.body as Body;
    const bad = violation(b, issued);
    if (bad !== null) return errorJson(400, { code: "InvalidParameter", message: bad });
    const model = b.model;
    const deepseek = model.startsWith("deepseek-");
    const thinks = b.thinking?.type !== "disabled";
    const reasoning = thinks ? "17 * 23 = 391." : undefined;
    let encrypted: string | undefined;
    if (thinks && !deepseek) {
      n += 1;
      encrypted = `djE-enc-${n}`;
      issued.add(encrypted);
    }
    const usage = (total: number, output: number, cached = 0) => usageOf({ total, output, cached });

    const system = b.messages[0]?.role === "system" ? String(b.messages[0].content) : "";
    if (system.length > 4000) {
      // Only DeepSeek models cache a prefix automatically on Ark's chat API (live 2026-11-08)
      const seen = deepseek && cachedPrefixes.has(system);
      cachedPrefixes.add(system);
      return sseChat({
        model,
        reasoning,
        encrypted,
        text: "Hello.",
        finish: "stop",
        usage: usage(5010, 3, seen ? 5000 : 0),
      });
    }
    const media = mediaAnswer(b.messages);
    if (media !== null) {
      return sseChat({
        model,
        reasoning,
        encrypted,
        text: media,
        finish: "stop",
        usage: usage(1600, 2),
      });
    }
    if (b.messages.at(-1)?.role === "tool") {
      return sseChat({
        model,
        reasoning,
        encrypted,
        text: "It is sunny and 22C in Paris.",
        finish: "stop",
        usage: usage(150, 12),
      });
    }
    if ((b.tools?.length ?? 0) > 0) {
      return sseChat({
        model,
        reasoning,
        encrypted,
        text: "Let me check.",
        toolCalls: [
          {
            id: "call_fixture_1",
            name: b.tools?.[0]?.function.name ?? "tool",
            args: '{"city": "Paris"}',
          },
        ],
        finish: "tool_calls",
        usage: usage(120, 30),
      });
    }
    return sseChat({
      model,
      reasoning,
      encrypted,
      text: thinks ? "391" : "Hello there, friend!",
      finish: "stop",
      usage: usage(25, 8),
    });
  };
}

/** One `ListEndpoints` item in the live shape (trimmed). */
export const endpointItem = (
  id: string,
  name: string,
  model: { name: string; version: string } | null,
  status = "Running",
) => ({
  Id: id,
  Name: name,
  Description: "",
  ProjectName: "default",
  ModelReference: {
    FoundationModel: model !== null ? { Name: model.name, ModelVersion: model.version } : null,
    CustomModelId: model === null ? "cm-123" : "",
  },
  EndpointModelType: model !== null ? "FoundationModel" : "CustomModel",
  Status: status,
  InferenceDefaultParam: { ThinkingConfig: { Value: "disabled", IsSupported: true } },
});

/** A `ListEndpoints` response page. */
export const endpointsPage = (items: unknown[], total: number, page = 1): FakeResponse => ({
  status: 200,
  json: {
    ResponseMetadata: { RequestId: "fixture", Action: "ListEndpoints", Version: "2024-01-01" },
    Result: { TotalCount: total, PageNumber: page, PageSize: 100, Items: items },
  },
});
