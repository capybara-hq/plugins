import {
  EFFORT_VALUES,
  type Effort,
  ModelError,
  type ModelInfo,
  type ModelKind,
  type ModelParameter,
} from "@capybara-hq/plugin-sdk";
import { fetchError, httpError } from "./errors.js";
import {
  cachesAutomatically,
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_OUTPUT,
  EMBEDDING_MODELS,
  publisherOf,
} from "./tables.js";

/** Thinking can go quiet for a long time. */
const REASONING_IDLE_TIMEOUT_MS = 300_000;
const LIST_TIMEOUT_MS = 30_000;

/**
 * One entry of `GET /api/v3/models` (the inference key lists models; live 2026-11-08, cn-beijing,
 * 53 entries). Every field is optional here: the list mixes chat, embedding, image, video and 3D
 * models, and old entries carry little more than an id.
 */
interface RawModel {
  id?: unknown;
  name?: unknown;
  version?: unknown;
  domain?: unknown;
  status?: unknown;
  api_supported?: Record<string, unknown> | null;
  context_window?: unknown;
  max_output_tokens?: unknown;
  token_limits?: { context_window?: unknown; max_output_token_length?: unknown } | null;
  modalities?: { input_modalities?: unknown } | null;
  effort?: { supported_levels?: unknown; default_level?: unknown } | null;
  features?: {
    thinking?: { types?: unknown } | null;
    tools?: { function_calling?: unknown } | null;
  } | null;
}

const posInt = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isInteger(v) && v > 0 ? v : undefined;
const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

/** Models still served: `Published`, and `Retiring` until their shutdown date. */
const listedStatus = (s: string): boolean => s === "Published" || s === "Retiring";

/**
 * The SDK kind of an entry, or null to skip it (no SDK kind: 3D generation, the smart router whose
 * limits and parameters the list leaves out, entries with no API). Chat needs the chat API;
 * embedding needs the multimodal embedding API and bundled facts (dimensions are not listed).
 */
function kindOf(raw: RawModel, id: string): ModelKind | null {
  const api = raw.api_supported ?? {};
  const domain = typeof raw.domain === "string" ? raw.domain : "";
  if ((domain === "LLM" || domain === "VLM") && api["chat/completions"] === true) return "chat";
  if (api["embeddings/multimodal"] === true && EMBEDDING_MODELS[id] !== undefined) {
    return "embedding";
  }
  if (domain === "ImageGeneration") return "image_generation";
  if (domain === "VideoGeneration") return "video_generation";
  return null;
}

const temperature: ModelParameter = {
  key: "temperature",
  standard: "temperature",
  schema: { type: "number", minimum: 0, maximum: 2 },
  label: { zh: "温度", en: "Temperature" },
  description: {
    zh: "采样随机性，越高越发散",
    en: "Sampling randomness; higher is more diverse",
  },
};

/**
 * Parameters from the list: `thinking` (off / on) when the model can switch thinking both ways
 * (`features.thinking.types` has `enabled` and `disabled`); no default, since the API default
 * differs per model and endpoint. `effort` with the standard levels among `supported_levels`
 * (`minimal` / `none` are not standard and are left out), defaulting to the listed
 * `default_level` when it is one of them: the list states the API's own default.
 */
function parameters(raw: RawModel): ModelParameter[] {
  const out: ModelParameter[] = [];
  const types = strings(raw.features?.thinking?.types);
  if (types.includes("enabled") && types.includes("disabled")) {
    out.push({
      key: "thinking",
      standard: "thinking",
      schema: { type: "string", enum: ["off", "on"] },
      label: { zh: "思考模式", en: "Thinking" },
      description: { zh: "是否先思考再回答", en: "Whether the model thinks before answering" },
    });
  }
  if (raw.effort != null) {
    const supported = strings(raw.effort.supported_levels);
    const levels = EFFORT_VALUES.filter((l) => supported.includes(l));
    if (levels.length > 0) {
      const def = raw.effort.default_level;
      out.push({
        key: "effort",
        standard: "effort",
        schema: { type: "string", enum: levels },
        ...(typeof def === "string" && levels.includes(def as Effort) ? { default: def } : {}),
        label: { zh: "思考深度", en: "Effort" },
        description: {
          zh: "越高思考越充分，耗时与用量越多",
          en: "Higher means more thorough reasoning, more time and tokens",
        },
      });
    }
  }
  // Ark documents temperature 0-2; its default differs per model, so none is declared
  out.push(temperature);
  return out;
}

const NO_CAPABILITIES = {
  tools: false,
  vision: false,
  reasoning: false,
  caching: false,
  midConversationSystem: false,
};

function mapModel(raw: RawModel, id: string, kind: ModelKind): ModelInfo {
  const name = typeof raw.name === "string" && raw.name !== "" ? raw.name : undefined;
  const version = typeof raw.version === "string" && raw.version !== "" ? raw.version : undefined;
  const publisher = publisherOf(name ?? id);
  const common = {
    id,
    displayName: name !== undefined ? (version !== undefined ? `${name} (${version})` : name) : id,
    kind,
    ...(publisher !== undefined ? { publisher } : {}),
  };
  if (kind === "embedding") {
    const embedding = EMBEDDING_MODELS[id];
    if (embedding === undefined) throw new Error("unreachable: kindOf checks the table");
    return {
      ...common,
      embedding,
      contextWindow: embedding.maxInputTokens,
      maxOutputTokens: 0,
      capabilities: NO_CAPABILITIES,
      parameters: [],
    };
  }
  if (kind !== "chat") {
    // List-only kinds: the kernel ignores the chat fields
    return {
      ...common,
      contextWindow: 0,
      maxOutputTokens: 0,
      capabilities: NO_CAPABILITIES,
      parameters: [],
    };
  }
  const params = parameters(raw);
  const types = strings(raw.features?.thinking?.types);
  const reasoning = types.includes("enabled") || params.some((p) => p.key === "effort");
  const input = strings(raw.modalities?.input_modalities);
  return {
    ...common,
    contextWindow:
      posInt(raw.context_window) ??
      posInt(raw.token_limits?.context_window) ??
      DEFAULT_CONTEXT_WINDOW,
    maxOutputTokens:
      posInt(raw.max_output_tokens) ??
      posInt(raw.token_limits?.max_output_token_length) ??
      DEFAULT_MAX_OUTPUT,
    capabilities: {
      tools: raw.features?.tools?.function_calling === true,
      vision: input.includes("image"),
      // Live 2026-11-08: the chat API read a PDF `file` part on the image-input models
      // (doubao-seed-2-0-lite, deepseek-v4-1-flash, kimi-k3-1-pro); the text-only
      // deepseek-v4-flash-ga answered without seeing it. So documents follow image input.
      documents: input.includes("image"),
      reasoning,
      caching: cachesAutomatically(id),
      // `[system]` user turns, see map-request.ts
      midConversationSystem: false,
    },
    ...(reasoning ? { streamIdleTimeoutMs: REASONING_IDLE_TIMEOUT_MS } : {}),
    parameters: params,
  };
}

/**
 * `GET {baseUrl}/models` with the inference key: the models the platform serves, as ModelInfo.
 * One odd entry is skipped, never the whole list. Custom inference endpoints (`ep-…`) are not in
 * this list (they need the control plane's ListEndpoints with AK/SK, which the plugin dropped).
 */
export async function listArkModels(baseUrl: string, apiKey: string): Promise<ModelInfo[]> {
  let res: Response;
  try {
    res = await fetch(`${baseUrl}/models`, {
      headers: { authorization: `Bearer ${apiKey}`, accept: "application/json" },
      signal: AbortSignal.timeout(LIST_TIMEOUT_MS),
    });
  } catch (cause) {
    throw fetchError(cause, "listing models");
  }
  if (!res.ok) throw await httpError(res, "listing models");
  let body: { data?: unknown };
  try {
    body = (await res.json()) as { data?: unknown };
  } catch (cause) {
    throw new ModelError("server", "Ark: the model list is not JSON", { cause });
  }
  if (!Array.isArray(body.data)) {
    throw new ModelError("server", "Ark: the model list has no data array");
  }
  const out: ModelInfo[] = [];
  const seen = new Set<string>();
  for (const entry of body.data) {
    if (typeof entry !== "object" || entry === null) continue;
    const raw = entry as RawModel;
    if (typeof raw.id !== "string" || raw.id === "" || seen.has(raw.id)) continue;
    if (typeof raw.status === "string" && !listedStatus(raw.status)) continue;
    const kind = kindOf(raw, raw.id);
    if (kind === null) continue;
    seen.add(raw.id);
    out.push(mapModel(raw, raw.id, kind));
  }
  return out;
}
