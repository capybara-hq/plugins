import {
  type ImageGenerateRequest,
  type ImageGenerateResult,
  type ImageMediaType,
  ModelError,
} from "@capybara-hq/plugin-sdk";
import { fetchError, httpError, isModerationCode, kindFromCode } from "./errors.js";
import { imageGenerationInfo } from "./tables.js";

/** One entry of the response's `data` (live 2026-11-18: `size`, `output_format`, `b64_json`). */
interface RawImage {
  b64_json?: unknown;
  url?: unknown;
  error?: { code?: unknown; message?: unknown } | null;
}

interface RawImagesResponse {
  data?: unknown;
  usage?: { output_tokens?: unknown } | null;
}

const WHAT = "generating an image";

const nonNegInt = (v: unknown): number =>
  typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : 0;

/** The image type by its first bytes; only the types the models declare (JPEG, PNG). */
function sniff(b64: string): ImageMediaType | null {
  const head = Buffer.from(b64.slice(0, 16), "base64");
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "image/jpeg";
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (png.every((b, i) => head[i] === b)) return "image/png";
  return null;
}

/**
 * The vendor's image URL (valid 24 h) as base64, with the call's signal. Only a fallback: the
 * request asks for `b64_json`, so a URL is not expected.
 */
async function download(url: string, signal: AbortSignal): Promise<string> {
  let res: Response;
  try {
    res = await fetch(url, { signal });
  } catch (cause) {
    throw fetchError(cause, "downloading the image", signal);
  }
  if (!res.ok) {
    throw new ModelError("server", `Ark: downloading the image: HTTP ${res.status}`);
  }
  try {
    return Buffer.from(await res.arrayBuffer()).toString("base64");
  } catch (cause) {
    throw fetchError(cause, "downloading the image", signal);
  }
}

/** One `POST {baseUrl}/images/generations` → one image and its output tokens. */
async function generateOne(
  baseUrl: string,
  apiKey: string,
  body: Record<string, unknown>,
  signal: AbortSignal,
): Promise<{ mediaType: ImageMediaType; data: string; outputTokens: number }> {
  let res: Response;
  try {
    res = await fetch(`${baseUrl}/images/generations`, {
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
    throw fetchError(cause, WHAT, signal);
  }
  if (!res.ok) throw await httpError(res, WHAT, { refusals: true });
  let text: string;
  try {
    text = await res.text();
  } catch (cause) {
    throw fetchError(cause, "reading the image", signal);
  }
  let raw: RawImagesResponse;
  try {
    raw = JSON.parse(text) as RawImagesResponse;
  } catch (cause) {
    throw new ModelError("server", "Ark: the image response is not JSON", { cause });
  }
  const item: RawImage | undefined =
    typeof raw === "object" && raw !== null && Array.isArray(raw.data)
      ? (raw.data[0] as RawImage | undefined)
      : undefined;
  if (typeof item !== "object" || item === null) {
    throw new ModelError("server", "Ark: the image response carries no image");
  }
  // A per-image failure inside a 200 (documented for group generation)
  if (item.error != null) {
    const code = typeof item.error.code === "string" ? item.error.code : "";
    const message = typeof item.error.message === "string" ? item.error.message : "";
    const kind = isModerationCode(code) ? "refusal" : (kindFromCode(code) ?? "server");
    throw new ModelError(kind, `Ark: ${WHAT}: ${code || "error"}: ${message}`.trim());
  }
  let data: string;
  if (typeof item.b64_json === "string" && item.b64_json !== "") data = item.b64_json;
  else if (typeof item.url === "string" && item.url !== "") data = await download(item.url, signal);
  else throw new ModelError("server", "Ark: the image response carries no image");
  const mediaType = sniff(data);
  if (mediaType === null) {
    throw new ModelError("server", "Ark: the returned image is neither JPEG nor PNG");
  }
  return { mediaType, data, outputTokens: nonNegInt(raw.usage?.output_tokens) };
}

/**
 * Seedream on `POST {baseUrl}/images/generations`, one image per request (Ark has no `n`; group
 * generation may return fewer than asked). The models declare `maxImages` 1 and a larger `n` is
 * `invalid_request` before any request (no per-image loop: a partial failure would bill images
 * that are then lost). `watermark` is always false (Ark's default is true; the plugin has no
 * option for it). Usage: Ark's `output_tokens` (width × height / 256 per image) as output tokens,
 * no input tokens, and the images returned.
 */
export async function generateImages(
  baseUrl: string,
  apiKey: string,
  req: ImageGenerateRequest,
  signal: AbortSignal,
): Promise<ImageGenerateResult> {
  const info = imageGenerationInfo(req.model);
  if (info === undefined) {
    throw new ModelError("invalid_request", `Ark: "${req.model}" is not an image generation model`);
  }
  if (!Number.isInteger(req.n) || req.n < 1 || req.n > info.maxImages) {
    throw new ModelError(
      "invalid_request",
      `Ark: ${req.model} produces at most ${info.maxImages} image(s) per call (maxImages), not ${req.n}`,
    );
  }
  const refs = (req.referenceImages ?? []).map((r) => `data:${r.mediaType};base64,${r.data}`);
  if (refs.length > info.maxReferenceImages) {
    throw new ModelError(
      "invalid_request",
      `Ark: ${req.model} takes at most ${info.maxReferenceImages} reference images, not ${refs.length}`,
    );
  }
  const body: Record<string, unknown> = {
    model: req.model,
    prompt: req.prompt,
    size: `${req.size.width}x${req.size.height}`,
    ...(refs.length === 1 ? { image: refs[0] } : refs.length > 1 ? { image: refs } : {}),
    response_format: "b64_json",
    watermark: false,
  };
  if (signal.aborted) throw new ModelError("aborted", "Request aborted");
  const one = await generateOne(baseUrl, apiKey, body, signal);
  const images: ImageGenerateResult["images"] = [{ mediaType: one.mediaType, data: one.data }];
  const outputTokens = one.outputTokens;
  return {
    images,
    usage: {
      inputTokens: 0,
      outputTokens,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outputImages: images.length,
    },
  };
}
