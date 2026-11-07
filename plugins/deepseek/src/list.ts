import {
  EFFORT_VALUES,
  type Effort,
  ModelError,
  type ModelInfo,
  type ModelParameter,
} from "@capybara-hq/plugin-sdk";
import { kindFromStatus, retryAfterMs } from "./errors.js";

/** Conservative limits for a model the response gives no limits for and the table does not know. */
const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_OUTPUT = 8_192;
/** Thinking can go quiet for a long time. */
const REASONING_IDLE_TIMEOUT_MS = 300_000;
const LIST_TIMEOUT_MS = 30_000;

/** Limits of the known models (live `/models`, 2026-11-08), used when the response omits them. */
const BUNDLED: Record<string, { contextWindow: number; maxOutputTokens: number }> = {
  "deepseek-flash": { contextWindow: 1_048_576, maxOutputTokens: 393_216 },
  "deepseek-v4-pro": { contextWindow: 1_048_576, maxOutputTokens: 393_216 },
};

interface RawModel {
  id?: unknown;
  name?: unknown;
  context_window?: unknown;
  max_output_tokens?: unknown;
  input_modalities?: unknown;
  effort?: { supported_levels?: unknown; default_level?: unknown } | null;
}

const posInt = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isInteger(v) && v > 0 ? v : undefined;

function parameters(raw: RawModel): ModelParameter[] {
  const out: ModelParameter[] = [];
  if (raw.effort != null) {
    const supported = Array.isArray(raw.effort.supported_levels) ? raw.effort.supported_levels : [];
    const levels = EFFORT_VALUES.filter((l) => supported.includes(l));
    out.push({
      key: "thinking",
      standard: "thinking",
      schema: { type: "string", enum: ["off", "on"] },
      default: "on",
      label: { zh: "思考模式", en: "Thinking" },
      description: { zh: "是否先思考再回答", en: "Whether the model thinks before answering" },
    });
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
  out.push({
    key: "temperature",
    standard: "temperature",
    schema: { type: "number", minimum: 0, maximum: 2 },
    default: 1,
    label: { zh: "温度", en: "Temperature" },
    description: {
      zh: "采样随机性，越高越发散（思考模式下无效）",
      en: "Sampling randomness; higher is more diverse (no effect in thinking mode)",
    },
  });
  return out;
}

function mapModel(raw: RawModel & { id: string }): ModelInfo {
  const bundled = BUNDLED[raw.id];
  const reasoning = raw.effort != null;
  const modalities = Array.isArray(raw.input_modalities) ? raw.input_modalities : [];
  return {
    id: raw.id,
    displayName: typeof raw.name === "string" && raw.name !== "" ? raw.name : raw.id,
    kind: "chat",
    publisher: "DeepSeek",
    contextWindow: posInt(raw.context_window) ?? bundled?.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
    maxOutputTokens:
      posInt(raw.max_output_tokens) ?? bundled?.maxOutputTokens ?? DEFAULT_MAX_OUTPUT,
    capabilities: {
      tools: true,
      vision: modalities.includes("image"),
      // No document input is documented for Chat Completions
      documents: false,
      reasoning,
      caching: true,
      // `[system]` user turns, see map-request.ts
      midConversationSystem: false,
    },
    ...(reasoning ? { streamIdleTimeoutMs: REASONING_IDLE_TIMEOUT_MS } : {}),
    parameters: parameters(raw),
  };
}

/** `GET {baseUrl}/models`; the models the endpoint lists, as ModelInfo. */
export async function listDeepSeekModels(baseUrl: string, apiKey: string): Promise<ModelInfo[]> {
  let res: Response;
  try {
    res = await fetch(`${baseUrl.replace(/\/+$/, "")}/models`, {
      headers: { authorization: `Bearer ${apiKey}`, accept: "application/json" },
      signal: AbortSignal.timeout(LIST_TIMEOUT_MS),
    });
  } catch (cause) {
    const timeout = cause instanceof Error && cause.name === "TimeoutError";
    throw new ModelError(timeout ? "timeout" : "network", "DeepSeek: cannot list models", {
      cause,
    });
  }
  if (!res.ok) {
    let code: string | null = null;
    let message = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { error?: { code?: unknown; message?: unknown } };
      if (typeof body.error?.code === "string") code = body.error.code;
      if (typeof body.error?.message === "string") message = body.error.message;
    } catch {
      // not JSON: keep the status text
    }
    const kind = kindFromStatus(res.status, code);
    const ms = kind === "rate_limited" ? retryAfterMs(res.headers) : undefined;
    throw new ModelError(
      kind,
      `DeepSeek: ${message}`,
      ms !== undefined ? { retryAfterMs: ms } : {},
    );
  }
  let body: { data?: unknown };
  try {
    body = (await res.json()) as { data?: unknown };
  } catch (cause) {
    throw new ModelError("server", "DeepSeek: the model list is not valid JSON", { cause });
  }
  if (!Array.isArray(body.data)) {
    throw new ModelError("server", "DeepSeek: the model list has no data array");
  }
  return (body.data as RawModel[])
    .filter((m): m is RawModel & { id: string } => typeof m.id === "string" && m.id !== "")
    .map(mapModel);
}
