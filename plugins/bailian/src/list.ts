import type { Logger, ModelInfo, ModelKind, ModelParameter } from "@capybara-hq/plugin-sdk";
import type { Target } from "./config.js";
import { requestJson } from "./http.js";
import {
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_OUTPUT_TOKENS,
  EMBEDDING_MODELS,
  LIST_MAX_PAGES,
  LIST_PAGE_SIZE,
  REASONING_STREAM_IDLE_MS,
  VERIFIED_INFERENCE_PROVIDERS,
} from "./tables.js";

/**
 * One entry of `GET /api/v1/models` (https://help.aliyun.com/zh/model-studio/list-models, fields
 * read live 2026-11-08). Read defensively: one odd entry is skipped, never fails the list.
 */
export interface RawModel {
  model?: unknown;
  name?: unknown;
  description?: unknown;
  provider?: unknown;
  inference_provider?: unknown;
  capabilities?: unknown;
  features?: unknown;
  inference_metadata?: { request_modality?: unknown } | null;
  model_info?: Record<string, unknown> | null;
  inference_offline_info?: { offline_time?: unknown } | null;
}

interface ListPage {
  output?: { total?: number; models?: RawModel[] } | null;
}

/** The generation endpoint a chat model is served on. */
export type Endpoint = "text" | "multimodal";

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

const positive = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : undefined;

/** Whether a list entry is a vision model (`VU`, or images in `request_modality`). */
export function isVision(raw: RawModel): boolean {
  return (
    strings(raw.capabilities).includes("VU") ||
    strings(raw.inference_metadata?.request_modality).includes("Image")
  );
}

/**
 * The native endpoint of a chat model: vision models are served only on multimodal-generation,
 * text-only models only on text-generation (live 2026-11-08: the other one answers 400
 * "url error"), whatever the request contains.
 */
export const endpointOf = (raw: RawModel): Endpoint => (isVision(raw) ? "multimodal" : "text");

/**
 * Capability codes → kind. `TG` / `VU` chat (one chat model with vision when both); `TR` is used
 * for embedding and rerank models alike (live list): an embedding model from the bundled table, a
 * model named `*rerank*` rerank (list-only), anything else skipped; `IG` / `VG` / `ASR` / `TTS` the
 * list-only kinds. `ME` (multimodal embedding: `embed` is text only), the realtime / omni codes,
 * `3D-generation`, `World-Model` and unknown codes have no SDK kind: skipped.
 */
function kindOf(id: string, caps: string[]): ModelKind | "skip" | "unknown-embedding" {
  if (caps.includes("TG") || caps.includes("VU")) return "chat";
  if (caps.includes("TR")) {
    if (EMBEDDING_MODELS[id] !== undefined) return "embedding";
    // HEURISTIC: the list tags rerank models `TR` too (live 2026-11-08: gte-rerank-v2,
    // qwen3-rerank, qwen3.7-text-rerank, qwen3-vl-rerank), so the id tells them apart. Remove when
    // the list gives rerank models a capability code of their own.
    if (/rerank/i.test(id)) return "rerank";
    return "unknown-embedding";
  }
  if (caps.includes("IG")) return "image_generation";
  if (caps.includes("VG")) return "video_generation";
  if (caps.includes("ASR")) return "speech_to_text";
  if (caps.includes("TTS")) return "text_to_speech";
  return "skip";
}

const thinkingKnob: ModelParameter = {
  key: "thinking",
  standard: "thinking",
  schema: { type: "string", enum: ["off", "on"] },
  // No default: whether thinking is on by default differs per model (qwen-flash off, glm-5.1 on)
  label: { zh: "思考模式", en: "Thinking" },
  description: { zh: "是否先思考再回答", en: "Whether the model thinks before answering" },
};

const temperatureKnob: ModelParameter = {
  key: "temperature",
  standard: "temperature",
  // DashScope's range is [0, 2): 2 itself answers 400 "Temperature should be in [0.0, 2.0)" (live
  // 2026-11-08); the declaration schema has no exclusive bound, so 1.99 stands for "below 2"
  schema: { type: "number", minimum: 0, maximum: 1.99 },
  // No default: DashScope's default temperature differs per model
  label: { zh: "温度", en: "Temperature" },
  description: { zh: "采样随机性，越高越发散", en: "Sampling randomness; higher is more diverse" },
};

const maxOutputKnob = (max: number): ModelParameter => ({
  key: "maxOutputTokens",
  standard: "maxOutputTokens",
  schema: { type: "integer", minimum: 1, maximum: max },
  label: { zh: "最大输出 token", en: "Max output tokens" },
});

/** `offline_time` ("2027-01-19 10:00:00") → its ISO date. */
function retiresAt(raw: RawModel): string | undefined {
  const t = raw.inference_offline_info?.offline_time;
  if (typeof t !== "string") return undefined;
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(t);
  return m?.[1];
}

type Mapped =
  | { info: ModelInfo }
  | { skip: "unverified" | "no-kind" | "unknown-embedding" | "invalid" };

/** One list entry → ModelInfo, or why it is left out. */
export function mapModel(raw: RawModel): Mapped {
  const id = raw.model;
  if (typeof id !== "string" || id === "" || !Array.isArray(raw.capabilities)) {
    return { skip: "invalid" };
  }
  if (!VERIFIED_INFERENCE_PROVIDERS.includes(String(raw.inference_provider))) {
    return { skip: "unverified" };
  }
  const caps = strings(raw.capabilities);
  const kind = kindOf(id, caps);
  if (kind === "skip") return { skip: "no-kind" };
  if (kind === "unknown-embedding") return { skip: "unknown-embedding" };
  const features = strings(raw.features);
  const info = raw.model_info ?? {};
  const contextWindow =
    positive(info.context_window) ?? positive(info.max_input_tokens) ?? DEFAULT_CONTEXT_WINDOW;
  const maxOutputTokens = positive(info.max_output_tokens) ?? DEFAULT_MAX_OUTPUT_TOKENS;
  const reasoning = kind === "chat" && caps.includes("Reasoning");
  const out: ModelInfo = {
    id,
    displayName: typeof raw.name === "string" && raw.name !== "" ? raw.name : id,
    kind,
    ...(typeof raw.provider === "string" && raw.provider !== "" ? { publisher: raw.provider } : {}),
    ...(typeof raw.description === "string" && raw.description !== ""
      ? { description: raw.description }
      : {}),
    contextWindow: kind === "chat" ? contextWindow : (positive(info.context_window) ?? 0),
    maxOutputTokens: kind === "chat" ? maxOutputTokens : 0,
    capabilities: {
      tools: kind === "chat" && features.includes("function-calling"),
      // VU / request_modality from the list (live 2026-11-08)
      vision: kind === "chat" && isVision(raw),
      reasoning,
      caching: kind === "chat" && features.includes("cache"),
      // Mid-conversation system turns go out as in-place "[system] " user text: whether every
      // hosted model keeps a native mid-history system message in position is not established.
      midConversationSystem: false,
      // Native generation takes no inline documents (qwen-long / doc-turbo use uploaded file ids)
      documents: false,
    },
    parameters:
      kind === "chat"
        ? [...(reasoning ? [thinkingKnob] : []), temperatureKnob, maxOutputKnob(maxOutputTokens)]
        : [],
    ...(reasoning ? { streamIdleTimeoutMs: REASONING_STREAM_IDLE_MS } : {}),
  };
  const retires = retiresAt(raw);
  if (retires !== undefined) out.retiresAt = retires;
  if (kind === "embedding") {
    const e = EMBEDDING_MODELS[id];
    if (e !== undefined) out.embedding = { ...e, dimensions: [...e.dimensions] };
  }
  return { info: out };
}

/** Builds the list query of one page. */
function listPath(pageNo: number, extra: Record<string, string> = {}): string {
  const q = new URLSearchParams({
    page_no: String(pageNo),
    page_size: String(LIST_PAGE_SIZE),
    supports: "inference",
    language: "zh-CN",
    ...extra,
  });
  return `/api/v1/models?${q.toString()}`;
}

/** Every page of the list, raw. */
async function fetchAll(t: Target, signal?: AbortSignal): Promise<RawModel[]> {
  const all: RawModel[] = [];
  for (let page = 1; page <= LIST_MAX_PAGES; page++) {
    const res = await requestJson<ListPage>(t, listPath(page), { method: "GET", signal });
    const models = res.output?.models ?? [];
    all.push(...models);
    const total = res.output?.total;
    if (models.length < LIST_PAGE_SIZE || (typeof total === "number" && all.length >= total)) break;
  }
  return all;
}

/** All of the platform's models this plugin can describe. */
export async function listBailianModels(
  t: Target,
  log?: Pick<Logger, "warn">,
): Promise<ModelInfo[]> {
  const out: ModelInfo[] = [];
  const unknownEmbeddings: string[] = [];
  for (const raw of await fetchAll(t)) {
    let m: Mapped;
    try {
      m = mapModel(raw);
    } catch {
      continue;
    }
    if ("info" in m) out.push(m.info);
    else if (m.skip === "unknown-embedding") unknownEmbeddings.push(String(raw.model));
  }
  if (unknownEmbeddings.length > 0) {
    log?.warn("bailian: embedding models missing from the bundled table are not listed", {
      models: unknownEmbeddings,
    });
  }
  return out;
}

/** One model's list entry (the list filters by exact `model`), or null when not listed. */
export async function findModel(
  t: Target,
  id: string,
  signal?: AbortSignal,
): Promise<RawModel | null> {
  const res = await requestJson<ListPage>(t, listPath(1, { model: id }), { method: "GET", signal });
  return res.output?.models?.find((m) => m.model === id) ?? null;
}
