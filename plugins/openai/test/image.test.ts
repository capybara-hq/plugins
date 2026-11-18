import {
  type ImageGenerateRequest,
  isModelError,
  isValidImageGenerationInfo,
  type ModelProvider,
  validateImageGenerateResult,
} from "@capybara-hq/plugin-sdk";
import {
  type FakeModelServer,
  type FakeResponse,
  isPngBase64,
  startFakeModelServer,
} from "@capybara-hq/testing";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { z } from "zod";
import plugin, { createOpenAIProvider } from "../src/index.js";
import { errorJson, imageResponse, PNG_BASE64 } from "./fixtures.js";

let server: FakeModelServer;
let next: (path: string) => FakeResponse = () => imageResponse(1);

beforeAll(async () => {
  server = await startFakeModelServer((req) => next(req.path));
});
afterAll(() => server.stop());

const provider = (
  imageModels = ["gpt-image-1-mini"],
  log?: { warn: (msg: string, meta?: Record<string, unknown>) => void },
): ModelProvider =>
  createOpenAIProvider({
    ...(log ? { log } : {}),
    apiKey: "sk-fixture",
    baseUrl: `${server.url}/v1`,
    models: [
      {
        id: "gpt-5.5",
        contextWindow: 400_000,
        maxOutputTokens: 128_000,
        reasoning: true,
        vision: true,
      },
    ],
    imageModels,
  });

const request = (over: Partial<ImageGenerateRequest> = {}): ImageGenerateRequest => ({
  model: "gpt-image-1-mini",
  prompt: "a red square",
  size: { width: 1024, height: 1024 },
  n: 1,
  params: {},
  ...over,
});
const call = (p: ModelProvider, r: ImageGenerateRequest, signal = new AbortController().signal) => {
  if (p.generateImage === undefined) throw new Error("no generateImage");
  return p.generateImage(r, { signal });
};
const rejection = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (e) {
    return e;
  }
  throw new Error("expected a rejection");
};

describe("image models listing", () => {
  it("lists image models with kind and imageGeneration, beside the chat models", async () => {
    const models = await provider(["gpt-image-1.5", "gpt-image-2"]).listModels();
    expect(models.map((m) => m.id)).toEqual(["gpt-5.5", "gpt-image-1.5", "gpt-image-2"]);
    const classic = models.find((m) => m.id === "gpt-image-1.5");
    expect(classic?.kind).toBe("image_generation");
    expect(classic?.imageGeneration).toEqual({
      sizes: [
        { width: 1024, height: 1024 },
        { width: 1536, height: 1024 },
        { width: 1024, height: 1536 },
      ],
      defaultSize: { width: 1024, height: 1024 },
      maxImages: 10,
      maxReferenceImages: 16,
      outputMediaTypes: ["image/png"],
    });
    const two = models.find((m) => m.id === "gpt-image-2")?.imageGeneration;
    expect(two?.sizes.length).toBeGreaterThan(3);
    expect(models.find((m) => m.id === "gpt-5.5")?.kind).toBeUndefined();
  });

  it("declares valid facts for every known model", async () => {
    const all = await provider(["gpt-image-1.5", "gpt-image-1-mini", "gpt-image-2"]).listModels();
    for (const m of all.filter((x) => x.kind === "image_generation")) {
      expect(isValidImageGenerationInfo(m.imageGeneration)).toBe(true);
    }
  });

  it("ignores an image model id the plugin has no facts for, with one warning", async () => {
    const warn = vi.fn();
    const p = provider(["gpt-image-1", "gpt-image-2", "gpt-image-0"], { warn });
    const ids = (await p.listModels()).map((m) => m.id);
    expect(ids).toEqual(["gpt-5.5", "gpt-image-2"]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toMatch(/gpt-image-1, gpt-image-0/);
    const e = await rejection(call(p, request({ model: "gpt-image-1" })));
    expect((e as { kind: string }).kind).toBe("invalid_request");
  });

  it("the deployment config accepts a retired image model id", () => {
    const schema = plugin.config?.deployment as z.ZodObject;
    const parsed = schema.safeParse({
      apiKey: "sk-x",
      models: [
        { id: "gpt-5.5", contextWindow: 1000, maxOutputTokens: 100, reasoning: true, vision: true },
      ],
      imageModels: ["gpt-image-1", "gpt-image-2"],
    });
    expect(parsed.success).toBe(true);
  });

  it("returns a copy of the facts, not the shared table", async () => {
    const first = (await provider(["gpt-image-2"]).listModels()).find(
      (m) => m.id === "gpt-image-2",
    );
    first?.imageGeneration?.sizes.push({ width: 16, height: 16 });
    if (first?.imageGeneration) first.imageGeneration.maxImages = 99;
    const again = (await provider(["gpt-image-2"]).listModels()).find(
      (m) => m.id === "gpt-image-2",
    );
    expect(again?.imageGeneration?.maxImages).toBe(10);
    expect(again?.imageGeneration?.sizes).not.toContainEqual({ width: 16, height: 16 });
  });

  it("gpt-image-2 / 2.5 sizes follow the documented rule (/16, ratio <= 3:1, <= 2560x1440 pixels)", async () => {
    const ids = ["gpt-image-2", "gpt-image-2.5-sunburst", "gpt-image-2.5-flare"];
    for (const m of await provider(ids).listModels()) {
      if (m.kind !== "image_generation") continue;
      for (const s of m.imageGeneration?.sizes ?? []) {
        const label = `${m.id} ${s.width}x${s.height}`;
        expect(s.width % 16 === 0 && s.height % 16 === 0, label).toBe(true);
        expect(
          Math.max(s.width, s.height) / Math.min(s.width, s.height),
          label,
        ).toBeLessThanOrEqual(3);
        expect(s.width * s.height, label).toBeLessThanOrEqual(2560 * 1440);
      }
      expect(m.imageGeneration?.sizes).not.toContainEqual({ width: 2048, height: 2048 });
    }
  });
});

describe("generate (no references)", () => {
  it("posts /v1/images/generations with b64 output and maps tokens to usage", async () => {
    next = () => imageResponse(2);
    server.requests.length = 0;
    const res = await call(provider(), request({ n: 2, size: { width: 1536, height: 1024 } }));
    const sent = server.requests.at(-1);
    expect(sent?.path).toBe("/v1/images/generations");
    expect(sent?.headers.authorization).toBe("Bearer sk-fixture");
    expect(sent?.body).toEqual({
      model: "gpt-image-1-mini",
      prompt: "a red square",
      n: 2,
      size: "1536x1024",
      output_format: "png",
    });
    expect(res.images).toHaveLength(2);
    const info = (await provider().listModels()).find((m) => m.id === "gpt-image-1-mini");
    expect(
      validateImageGenerateResult(
        request({ n: 2, size: { width: 1536, height: 1024 } }),
        info?.imageGeneration as never,
        res,
      ),
    ).toBeNull();
    expect(res.images[0]?.mediaType).toBe("image/png");
    expect(isPngBase64(res.images[0]?.data ?? "")).toBe(true);
    expect(res.revisedPrompt).toBeUndefined();
    expect(res.usage).toEqual({
      inputTokens: 20,
      outputTokens: 2112,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outputImages: 2,
    });
  });
});

describe("generate with reference images", () => {
  it("posts multipart /v1/images/edits with image[] parts", async () => {
    next = () => imageResponse(1);
    server.requests.length = 0;
    const res = await call(
      provider(),
      request({
        referenceImages: [
          { mediaType: "image/png", data: PNG_BASE64 },
          { mediaType: "image/jpeg", data: PNG_BASE64 },
        ],
      }),
    );
    const sent = server.requests.at(-1);
    expect(sent?.path).toBe("/v1/images/edits");
    expect(sent?.headers["content-type"]).toMatch(/^multipart\/form-data/);
    const body = String(sent?.body);
    expect(body.match(/name="image\[\]"/g)).toHaveLength(2);
    expect(body).toMatch(/name="model"\r\n\r\ngpt-image-1-mini/);
    expect(body).toMatch(/name="prompt"\r\n\r\na red square/);
    expect(body).toMatch(/name="size"\r\n\r\n1024x1024/);
    expect(body).toMatch(/name="n"\r\n\r\n1/);
    expect(body).toMatch(/name="output_format"\r\n\r\npng/);
    expect(body).toMatch(/Content-Type: image\/jpeg/);
    expect(body).toMatch(/filename="reference-0\.png"/);
    expect(body).toMatch(/filename="reference-1\.jpeg"/);
    expect(res.images).toHaveLength(1);
    expect(res.usage.outputImages).toBe(1);
  });
});

describe("errors", () => {
  it.each([
    ["fewer b64_json items than n", 2, () => imageResponse(1)],
    [
      "an item without b64_json",
      1,
      (): FakeResponse => ({
        status: 200,
        json: { data: [{ url: "https://example.invalid/a.png" }], usage: { input_tokens: 1 } },
      }),
    ],
  ])("%s -> server", async (_label, n, response) => {
    next = response;
    const e = await rejection(call(provider(), request({ n })));
    expect((e as { kind: string }).kind).toBe("server");
    expect((e as Error).message).toMatch(/OpenAI: the image response carries/);
  });

  it("a reference image of another type is invalid_request before any request", async () => {
    next = () => imageResponse(1);
    server.requests.length = 0;
    const e = await rejection(
      call(
        provider(),
        request({ referenceImages: [{ mediaType: "image/gif", data: PNG_BASE64 }] }),
      ),
    );
    expect((e as { kind: string }).kind).toBe("invalid_request");
    expect((e as Error).message).toMatch(/image\/gif/);
    expect(server.requests).toHaveLength(0);
  });

  it("moderation 400 -> refusal with the vendor reason", async () => {
    next = () =>
      errorJson(400, {
        message: "Your request was rejected by the safety system.",
        type: "image_generation_user_error",
        code: "moderation_blocked",
      });
    const e = await rejection(call(provider(), request()));
    expect(isModelError(e)).toBe(true);
    expect((e as { kind: string }).kind).toBe("refusal");
    expect((e as Error).message).toMatch(/safety system/);
  });

  it.each([
    [400, "invalid_request_error", "invalid_request"],
    [401, "invalid_request_error", "auth"],
    [403, "invalid_request_error", "auth"],
    [429, "rate_limit_exceeded", "rate_limited"],
    [500, "server_error", "server"],
  ])("HTTP %i -> %s", async (status, type, kind) => {
    next = () => errorJson(status, { message: "boom", type });
    const e = await rejection(call(provider(), request()));
    expect((e as { kind: string }).kind).toBe(kind);
    expect((e as Error).message).not.toMatch(/sk-fixture/);
  });

  it("an unknown model is invalid_request", async () => {
    const e = await rejection(call(provider(), request({ model: "gpt-image-2" })));
    expect((e as { kind: string }).kind).toBe("invalid_request");
  });

  it("abort -> aborted", async () => {
    next = () => ({ stall: true });
    const ac = new AbortController();
    const pending = rejection(call(provider(), request(), ac.signal));
    ac.abort();
    expect(((await pending) as { kind: string }).kind).toBe("aborted");
  });
});

// ---- live (one small image with the cheapest model) ----
const LIVE_KEY = process.env.CAPYBARA_TEST_OPENAI_API_KEY;
const LIVE_IMAGE_MODEL = process.env.CAPYBARA_TEST_OPENAI_IMAGE_MODEL;
if (!LIVE_KEY || !LIVE_IMAGE_MODEL) {
  console.info(
    "[plugin-openai] CAPYBARA_TEST_OPENAI_API_KEY / CAPYBARA_TEST_OPENAI_IMAGE_MODEL not set: live image case skipped",
  );
}
describe.skipIf(!LIVE_KEY || !LIVE_IMAGE_MODEL)(
  "live image generation",
  { timeout: 180_000 },
  () => {
    it("generates one 1024x1024 image", async () => {
      const p = createOpenAIProvider({
        apiKey: LIVE_KEY ?? "",
        models: [
          {
            id: "gpt-5.5",
            contextWindow: 400_000,
            maxOutputTokens: 128_000,
            reasoning: true,
            vision: true,
          },
        ],
        imageModels: [LIVE_IMAGE_MODEL ?? ""],
      });
      const res = await call(
        p,
        request({ model: LIVE_IMAGE_MODEL ?? "", prompt: "a small red square" }),
      );
      expect(res.images).toHaveLength(1);
      expect(isPngBase64(res.images[0]?.data ?? "")).toBe(true);
      expect(res.usage.outputImages).toBe(1);
    });
  },
);
