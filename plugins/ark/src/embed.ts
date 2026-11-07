import { type EmbedRequest, type EmbedResult, ModelError } from "@capybara-hq/plugin-sdk";
import { fetchError, httpError } from "./errors.js";
import { EMBEDDING_MODELS } from "./tables.js";

/**
 * `inputType` → doubao-embedding-vision's instruction templates
 * (https://docs.volcengine.com/docs/ark/vectorization, read 2026-11-08): the query side names the
 * target modality and the retrieval task, the corpus side asks to compress the input. Without an
 * `inputType` no instruction is sent.
 */
const INSTRUCTIONS = {
  query:
    "Target_modality: text.\nInstruction:Given a query, retrieve the most relevant passages\nQuery:",
  document: "Instruction:Compress the text into one word.\nQuery:",
} as const;

interface RawEmbedding {
  data?: { embedding?: unknown } | { embedding?: unknown }[] | null;
  usage?: { prompt_tokens?: unknown; total_tokens?: unknown } | null;
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/**
 * `POST {baseUrl}/embeddings/multimodal`, one text per call: the endpoint fuses every input of a
 * call into one vector (live 2026-11-08: three inputs gave one 2048-dim vector), so `maxBatch` is
 * 1 and a longer request is sent as one call per input, in order. Vectors come back in input order.
 */
export async function embedTexts(
  baseUrl: string,
  apiKey: string,
  req: EmbedRequest,
  signal: AbortSignal,
): Promise<EmbedResult> {
  const info = EMBEDDING_MODELS[req.model];
  if (info === undefined) {
    throw new ModelError("invalid_request", `Ark: "${req.model}" is not an embedding model`);
  }
  if (req.dimensions !== undefined && !info.dimensions.includes(req.dimensions)) {
    throw new ModelError(
      "invalid_request",
      `Ark: ${req.model} produces ${info.dimensions.join(" or ")} dimensions, not ${req.dimensions}`,
    );
  }
  const dims = req.dimensions ?? info.defaultDimensions;
  const vectors: number[][] = [];
  let inputTokens = 0;
  for (const text of req.input) {
    if (signal.aborted) throw new ModelError("aborted", "Request aborted");
    const body = {
      model: req.model,
      input: [{ type: "text", text }],
      ...(req.dimensions !== undefined ? { dimensions: req.dimensions } : {}),
      ...(req.inputType !== undefined ? { instructions: INSTRUCTIONS[req.inputType] } : {}),
      encoding_format: "float",
    };
    let res: Response;
    try {
      res = await fetch(`${baseUrl}/embeddings/multimodal`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify(body),
        signal,
      });
    } catch (cause) {
      throw fetchError(cause, "embedding", signal);
    }
    if (!res.ok) throw await httpError(res, "embedding");
    let raw: RawEmbedding;
    try {
      raw = (await res.json()) as RawEmbedding;
    } catch (cause) {
      throw fetchError(cause, "reading the embedding", signal);
    }
    // `data` is one object live; an array (OpenAI shape) is read by its first entry
    const item = Array.isArray(raw.data) ? raw.data[0] : raw.data;
    const v = item?.embedding;
    if (
      !Array.isArray(v) ||
      v.length !== dims ||
      !v.every((x) => typeof x === "number" && Number.isFinite(x))
    ) {
      throw new ModelError("server", `Ark: the embedding is not a ${dims}-dimension vector`);
    }
    vectors.push(v as number[]);
    inputTokens += num(raw.usage?.prompt_tokens ?? raw.usage?.total_tokens);
  }
  return { vectors, usage: { inputTokens } };
}
