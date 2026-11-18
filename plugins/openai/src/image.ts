import {
  type ImageGenerateRequest,
  type ImageGenerateResult,
  ModelError,
  type ModelImageGenerationInfo,
  type ModelInfo,
} from "@capybara-hq/plugin-sdk";
import OpenAI, { toFile } from "openai";
import { toModelError } from "./errors.js";

// capybara:allow-module-state a read-only table of documented sizes
const STANDARD_SIZES = [
  { width: 1024, height: 1024 },
  { width: 1536, height: 1024 },
  { width: 1024, height: 1536 },
];

/**
 * gpt-image-2 and later accept any WxH with both sides divisible by 16, ratio at most 3:1, up to
 * 3840x2160, with anything above 2560x1440 pixels experimental. The contract wants a fixed list, so
 * these are a few sizes that follow that rule and stay at or below 2560x1440 pixels (3,686,400):
 * 1920x1920 is the square of exactly that count; 2048x2048 is above it and left out.
 */
// capybara:allow-module-state a read-only table of documented sizes
const FLEXIBLE_SIZES = [
  ...STANDARD_SIZES,
  { width: 1920, height: 1920 },
  { width: 2048, height: 1152 },
  { width: 1152, height: 2048 },
  { width: 2560, height: 1440 },
  { width: 1440, height: 2560 },
];

/**
 * Image models whose facts come from OpenAI's docs (checked 2026-11-18; gpt-image-1 was shut down on
 * 2026-10-23). `/v1/models` carries no capability metadata, so the deployment names the ids it wants
 * (`imageModels`) and the facts come from this table. n is 1..10 and edits take 1..16 images on every
 * one; output is requested as png.
 */
// capybara:allow-module-state a read-only table of documented model facts
const KNOWN_IMAGE_MODELS: Record<string, ModelImageGenerationInfo> = Object.fromEntries(
  [
    ["gpt-image-1.5", STANDARD_SIZES],
    ["gpt-image-1-mini", STANDARD_SIZES],
    ["gpt-image-2", FLEXIBLE_SIZES],
    ["gpt-image-2.5-sunburst", FLEXIBLE_SIZES],
    ["gpt-image-2.5-flare", FLEXIBLE_SIZES],
  ].map(([id, sizes]) => [
    id as string,
    {
      sizes: sizes as typeof STANDARD_SIZES,
      defaultSize: { width: 1024, height: 1024 },
      maxImages: 10,
      maxReferenceImages: 16,
      outputMediaTypes: ["image/png"],
    },
  ]),
);

// capybara:allow-module-state a read-only list of model ids
export const KNOWN_IMAGE_MODEL_IDS = Object.keys(KNOWN_IMAGE_MODELS);

/** The model's listing entry; its facts are a copy, never the shared table object. */
export function imageModelInfo(id: string): ModelInfo {
  const info = Object.hasOwn(KNOWN_IMAGE_MODELS, id) ? KNOWN_IMAGE_MODELS[id] : undefined;
  if (info === undefined) throw new Error(`Unknown OpenAI image model "${id}"`);
  return {
    id,
    displayName: id,
    kind: "image_generation",
    contextWindow: 0,
    maxOutputTokens: 0,
    capabilities: {
      tools: false,
      vision: false,
      reasoning: false,
      caching: false,
      midConversationSystem: false,
      documents: false,
    },
    parameters: [],
    imageGeneration: structuredClone(info),
  };
}

/** Vendor content-moderation rejections arrive as HTTP 400 with one of these codes. */
// capybara:allow-module-state a read-only set of error codes
const MODERATION_CODES = new Set(["moderation_blocked", "content_policy_violation"]);

function imageError(e: unknown, signal: AbortSignal): ModelError {
  if (
    !signal.aborted &&
    e instanceof OpenAI.BadRequestError &&
    e.code !== null &&
    e.code !== undefined &&
    MODERATION_CODES.has(e.code)
  ) {
    return new ModelError("refusal", `OpenAI declined the prompt: ${e.message}`, { cause: e });
  }
  return toModelError(e, signal);
}

/** Reference image types the edits endpoint takes, and their file extensions. */
// capybara:allow-module-state a read-only map of media types
const EXTENSION: Readonly<Record<string, string>> = {
  "image/png": "png",
  "image/jpeg": "jpeg",
  "image/webp": "webp",
};

/** Text to image on `/v1/images/generations`; with reference images on `/v1/images/edits`. */
export async function generateOpenAIImage(
  client: OpenAI,
  req: ImageGenerateRequest,
  signal: AbortSignal,
): Promise<ImageGenerateResult> {
  const size = `${req.size.width}x${req.size.height}` as const;
  const common = {
    model: req.model,
    prompt: req.prompt,
    n: req.n,
    size,
    output_format: "png",
  } as const;
  const refs = req.referenceImages ?? [];
  for (const r of refs) {
    if (!Object.hasOwn(EXTENSION, r.mediaType)) {
      throw new ModelError(
        "invalid_request",
        `OpenAI: reference images must be PNG, JPEG or WebP, not ${r.mediaType}`,
      );
    }
  }
  try {
    const res =
      refs.length === 0
        ? await client.images.generate(common, { signal })
        : await client.images.edit(
            {
              ...common,
              image: await Promise.all(
                refs.map((r, i) =>
                  toFile(
                    Buffer.from(r.data, "base64"),
                    `reference-${i}.${EXTENSION[r.mediaType]}`,
                    {
                      type: r.mediaType,
                    },
                  ),
                ),
              ),
            },
            { signal },
          );
    const data = res.data ?? [];
    if (data.length !== req.n || data.some((d) => typeof d.b64_json !== "string" || !d.b64_json)) {
      throw new ModelError(
        "server",
        `OpenAI: the image response carries ${data.filter((d) => d.b64_json).length} b64_json image(s), expected ${req.n}`,
      );
    }
    const images = data.map((d) => ({
      mediaType: "image/png" as const,
      data: d.b64_json as string,
    }));
    return {
      images,
      // Tokens are for the whole request; GPT image models never return a revised prompt.
      usage: {
        inputTokens: res.usage?.input_tokens ?? 0,
        outputTokens: res.usage?.output_tokens ?? 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        outputImages: images.length,
      },
    };
  } catch (e) {
    throw imageError(e, signal);
  }
}
