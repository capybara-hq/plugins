import {
  type ImageGenerateRequest,
  type ImageGenerateResult,
  type ImageMediaType,
  ModelError,
} from "@capybara-hq/plugin-sdk";
import type { Target } from "./config.js";
import { type ErrorOptions, errorFromBody, isModerationCode } from "./errors.js";
import { requestJson } from "./http.js";
import { IMAGE_MODELS, type ImageModelInfo } from "./tables.js";

/*
 * Image generation on DashScope's native API (https://help.aliyun.com/zh/model-studio/
 * qwen-image-api, /qwen-image-edit-api, /text-to-image-v2-api-reference; shapes checked live
 * 2026-11-18, cn-beijing). Two shapes:
 * - sync `multimodal-generation` (Qwen-Image 2.0, wan2.6-t2i): `input.messages` with the reference
 *   images and one text, images as URLs in `output.choices[].message.content[].image`;
 * - async `text2image/image-synthesis` (wan2.5 and earlier): submit with `X-DashScope-Async`, poll
 *   `GET /api/v1/tasks/{id}` until `SUCCEEDED` (`output.results[].url`, `actual_prompt` when the
 *   prompt was rewritten) or `FAILED` (`output.code` / `message`).
 * Result URLs are signed OSS links valid for 24 h: downloaded inside the call, returned as bytes.
 * Usage is `image_count` only: tokens 0, `outputImages` the images returned. No retries.
 */

export const MULTIMODAL_PATH = "/api/v1/services/aigc/multimodal-generation/generation";
export const TEXT2IMAGE_PATH = "/api/v1/services/aigc/text2image/image-synthesis";

/** Moderation codes are `refusal` on every image request. */
const ERRORS: ErrorOptions = { moderationIsRefusal: true };

export interface PollTiming {
  /** The wait before the first poll; doubled after each poll. */
  initialMs: number;
  /** The longest wait between two polls. */
  maxMs: number;
}

export interface ImageCallOptions {
  signal: AbortSignal;
  poll: PollTiming;
  /** Origins besides https `*.aliyuncs.com` that result images may come from (tests). */
  downloadOrigins: readonly string[];
}

interface MultimodalResponse {
  output?: {
    choices?: { message?: { content?: { image?: unknown }[] | null } | null }[] | null;
  } | null;
}

interface TaskResult {
  url?: unknown;
  actual_prompt?: unknown;
  code?: string | null;
  message?: string | null;
}

interface TaskResponse {
  output?: {
    task_id?: unknown;
    task_status?: unknown;
    results?: TaskResult[] | null;
    code?: string | null;
    message?: string | null;
  } | null;
}

const invalid = (message: string) => new ModelError("invalid_request", `Bailian: ${message}`);
const server = (message: string) => new ModelError("server", `Bailian: ${message}`);

/** Checks the request against the model's facts before any request is sent. */
function check(req: ImageGenerateRequest): ImageModelInfo {
  const info = IMAGE_MODELS[req.model];
  if (info === undefined) {
    throw invalid(`"${req.model}" is not a supported image generation model`);
  }
  if (!Number.isInteger(req.n) || req.n < 1 || req.n > info.maxImages) {
    throw invalid(`${req.model} makes 1 to ${info.maxImages} images per call, got ${req.n}`);
  }
  if (!info.sizes.some((s) => s.width === req.size.width && s.height === req.size.height)) {
    throw invalid(
      `${req.model} does not offer ${req.size.width}x${req.size.height} (${info.sizes
        .map((s) => `${s.width}x${s.height}`)
        .join(", ")})`,
    );
  }
  const refs = req.referenceImages?.length ?? 0;
  if (refs > info.maxReferenceImages) {
    throw invalid(
      info.maxReferenceImages === 0
        ? `${req.model} takes no reference images`
        : `${req.model} takes at most ${info.maxReferenceImages} reference images, got ${refs}`,
    );
  }
  return info;
}

/** The parameters both shapes share. `n` is always sent: wan defaults to 4. */
const parametersOf = (req: ImageGenerateRequest) => ({
  size: `${req.size.width}*${req.size.height}`,
  n: req.n,
  // Qwen-Image and wan2.6 default to false, older wan models to their own default: always off
  watermark: false,
});

async function generateSync(
  t: Target,
  req: ImageGenerateRequest,
  signal: AbortSignal,
): Promise<{ urls: unknown[]; revisedPrompt?: string }> {
  const content = [
    ...(req.referenceImages ?? []).map((r) => ({ image: `data:${r.mediaType};base64,${r.data}` })),
    { text: req.prompt },
  ];
  const res = await requestJson<MultimodalResponse>(t, MULTIMODAL_PATH, {
    method: "POST",
    body: {
      model: req.model,
      input: { messages: [{ role: "user", content }] },
      parameters: parametersOf(req),
    },
    signal,
    errors: ERRORS,
  });
  // One choice with n content items (live, n = 1); several choices are read the same way
  const urls = (res.output?.choices ?? []).flatMap((c) =>
    (c.message?.content ?? []).flatMap((p) => (p.image !== undefined ? [p.image] : [])),
  );
  return { urls };
}

/**
 * Waits `ms` inside this call, or rejects at once when `signal` aborts. No timer of the plugin's own
 * (`AbortSignal.timeout`, as example-board's in-request sleep): nothing is left to stop when the
 * call ends.
 */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const s = AbortSignal.any([signal, AbortSignal.timeout(ms)]);
    const done = () =>
      signal.aborted ? reject(new ModelError("aborted", "Request aborted")) : resolve();
    if (s.aborted) done();
    else s.addEventListener("abort", done, { once: true });
  });
}

async function generateTask(
  t: Target,
  req: ImageGenerateRequest,
  opts: ImageCallOptions,
): Promise<{ urls: unknown[]; revisedPrompt?: string }> {
  const submitted = await requestJson<TaskResponse>(t, TEXT2IMAGE_PATH, {
    method: "POST",
    body: { model: req.model, input: { prompt: req.prompt }, parameters: parametersOf(req) },
    headers: { "X-DashScope-Async": "enable" },
    signal: opts.signal,
    errors: ERRORS,
  });
  const id = submitted.output?.task_id;
  if (typeof id !== "string" || id === "") throw server("the task submit returned no task id");
  let wait = opts.poll.initialMs;
  // Bounded only by the call's signal (the kernel's timeout): a task normally ends in seconds
  for (;;) {
    await sleep(wait, opts.signal);
    wait = Math.min(wait * 2, opts.poll.maxMs);
    const res = await requestJson<TaskResponse>(t, `/api/v1/tasks/${encodeURIComponent(id)}`, {
      method: "GET",
      signal: opts.signal,
      errors: ERRORS,
    });
    const out = res.output ?? {};
    switch (out.task_status) {
      case "PENDING":
      case "RUNNING":
        continue;
      case "SUCCEEDED": {
        const results = out.results ?? [];
        const failed = results.filter((r) => typeof r.url !== "string");
        if (failed.length > 0) {
          // A partial failure leaves fewer than n images (already billed); never topped up
          const moderated = failed.find((r) => isModerationCode(r.code));
          throw errorFromBody(undefined, moderated ?? failed[0] ?? {}, undefined, ERRORS);
        }
        const revised = results
          .map((r) => r.actual_prompt)
          .find((p): p is string => typeof p === "string" && p !== "");
        return { urls: results.map((r) => r.url), ...(revised ? { revisedPrompt: revised } : {}) };
      }
      case "FAILED":
        throw errorFromBody(
          undefined,
          { code: out.code ?? null, message: out.message ?? "the image task failed" },
          undefined,
          ERRORS,
        );
      default:
        // CANCELED, UNKNOWN (no such task or expired) or a status this plugin does not know
        throw server(`the image task ended with status ${String(out.task_status)}`);
    }
  }
}

/** The image type from the bytes' signature. */
function sniff(b: Uint8Array): ImageMediaType | undefined {
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return "image/gif";
  const ascii = (from: number, to: number) => String.fromCharCode(...b.subarray(from, to));
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
  return undefined;
}

/**
 * Downloads one result image. Only https hosts under `aliyuncs.com` (the OSS result buckets, live:
 * `dashscope-*.oss-cn-beijing.aliyuncs.com`, `dashscope-*.oss-accelerate.aliyuncs.com`) are
 * fetched, without the API key and without following redirects, so a response cannot point the
 * plugin at another address.
 */
async function download(
  raw: unknown,
  info: ImageModelInfo,
  opts: ImageCallOptions,
): Promise<{ mediaType: ImageMediaType; data: string }> {
  let url: URL;
  try {
    url = new URL(String(raw));
  } catch {
    throw server("a result image URL is not a URL");
  }
  const vendor = url.protocol === "https:" && url.hostname.endsWith(".aliyuncs.com");
  if (!vendor && !opts.downloadOrigins.includes(url.origin)) {
    throw server(`a result image is on an unexpected host (${url.hostname})`);
  }
  const res = await fetch(url, { signal: opts.signal, redirect: "error" });
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    throw server(`downloading a result image failed with HTTP ${res.status}`);
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  const mediaType = sniff(bytes);
  if (mediaType === undefined) throw server("a result image is not a PNG, JPEG, GIF or WebP");
  if (!info.outputMediaTypes.includes(mediaType)) {
    throw server(`a result image is ${mediaType}, which this model does not declare`);
  }
  return { mediaType, data: Buffer.from(bytes).toString("base64") };
}

/** One `generateImage` call: exactly `req.n` images as base64, or a ModelError. */
export async function generateBailianImage(
  t: Target,
  req: ImageGenerateRequest,
  opts: ImageCallOptions,
): Promise<ImageGenerateResult> {
  const info = check(req);
  const { urls, revisedPrompt } =
    info.api === "multimodal"
      ? await generateSync(t, req, opts.signal)
      : await generateTask(t, req, opts);
  if (urls.length !== req.n) {
    throw server(`expected ${req.n} images, the API returned ${urls.length}`);
  }
  const images: ImageGenerateResult["images"] = [];
  for (const u of urls) images.push(await download(u, info, opts));
  return {
    images,
    ...(revisedPrompt !== undefined ? { revisedPrompt } : {}),
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outputImages: images.length,
    },
  };
}
