import { type EmbedRequest, type EmbedResult, ModelError } from "@capybara-hq/plugin-sdk";
import type { Target } from "./config.js";
import { requestJson } from "./http.js";
import { EMBEDDING_MODELS } from "./tables.js";

/**
 * Sync text embedding (https://help.aliyun.com/zh/model-studio/text-embedding-synchronous-api,
 * checked live 2026-11-08): `{ model, input: { texts }, parameters: { dimension, text_type } }` →
 * `output.embeddings[{ text_index | index, embedding }]` (the qwen3.7 flash model answers with
 * `index` and `type`), `usage.total_tokens`.
 */
interface EmbedResponse {
  output?: { embeddings?: { text_index?: number; index?: number; embedding?: number[] }[] };
  usage?: { total_tokens?: number; input_tokens?: number };
}

const PATH = "/api/v1/services/embeddings/text-embedding/text-embedding";

export async function embedTexts(
  t: Target,
  req: EmbedRequest,
  signal: AbortSignal,
): Promise<EmbedResult> {
  const info = EMBEDDING_MODELS[req.model];
  if (info === undefined) {
    throw new ModelError(
      "invalid_request",
      `Bailian: "${req.model}" is not a supported embedding model`,
    );
  }
  if (req.input.length === 0 || req.input.length > info.maxBatch) {
    throw new ModelError(
      "invalid_request",
      `Bailian: ${req.model} takes 1 to ${info.maxBatch} inputs per call, got ${req.input.length}`,
    );
  }
  if (req.dimensions !== undefined && !info.dimensions.includes(req.dimensions)) {
    throw new ModelError(
      "invalid_request",
      `Bailian: ${req.model} does not produce ${req.dimensions} dimensions (${info.dimensions.join(", ")})`,
    );
  }
  const parameters: Record<string, unknown> = {};
  // Only adjustable models get `dimension` (fixed ones ignore it anyway)
  if (info.dimensions.length > 1) parameters.dimension = req.dimensions ?? info.defaultDimensions;
  parameters.text_type = req.inputType ?? "document";
  const res = await requestJson<EmbedResponse>(t, PATH, {
    method: "POST",
    body: { model: req.model, input: { texts: req.input }, parameters },
    signal,
  });
  const rows = (res.output?.embeddings ?? []).map((e, i) => ({
    at: typeof e.text_index === "number" ? e.text_index : typeof e.index === "number" ? e.index : i,
    vector: e.embedding,
  }));
  rows.sort((a, b) => a.at - b.at);
  if (
    rows.length !== req.input.length ||
    rows.some((r, i) => r.at !== i || !Array.isArray(r.vector))
  ) {
    throw new ModelError(
      "server",
      `Bailian: expected ${req.input.length} embeddings in order, got ${rows.length}`,
    );
  }
  return {
    vectors: rows.map((r) => r.vector as number[]),
    usage: { inputTokens: res.usage?.total_tokens ?? res.usage?.input_tokens ?? 0 },
  };
}
