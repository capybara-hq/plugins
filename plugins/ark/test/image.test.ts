import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
  type ImageGenerateRequest,
  isModelError,
  isValidImageGenerationInfo,
  type ModelInfo,
  validateImageGenerateResult,
} from "@capybara-hq/plugin-sdk";
import {
  describeModelProviderConformance,
  FAKE_PNG_BASE64,
  type FakeModelServer,
  type FakeRequest,
  type FakeResponse,
  startFakeModelServer,
} from "@capybara-hq/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createArkProvider } from "../src/index.js";
import {
  arkRoutes,
  errorJson,
  FAKE_JPEG_BASE64,
  imageOk,
  SEED,
  SEEDREAM,
  SEEDREAM_4,
} from "./fixtures.js";

describeModelProviderConformance("ark (fixtures, image generation)", async () => {
  const server = await startFakeModelServer(arkRoutes());
  return {
    plugin: "ark",
    provider: createArkProvider({ apiKey: "ark-fixture", baseUrl: `${server.url}/api/v3` }),
    model: SEED,
    expect: { thinking: true, caching: false, imageGeneration: { model: SEEDREAM } },
    teardown: () => server.stop(),
  };
});

const kindOf = (e: unknown) => (isModelError(e) ? e.kind : `not a ModelError: ${String(e)}`);

describe("ark: image generation", () => {
  let server: FakeModelServer;
  let route: (req: FakeRequest) => FakeResponse;
  const fixtures = arkRoutes();
  beforeAll(async () => {
    server = await startFakeModelServer((r) => route(r));
  });
  afterAll(async () => {
    await server?.stop();
  });
  const provider = () =>
    createArkProvider({ apiKey: "ark-fixture", baseUrl: `${server.url}/api/v3` });
  const req = (over: Partial<ImageGenerateRequest> = {}): ImageGenerateRequest => ({
    model: SEEDREAM,
    prompt: "a small red square",
    size: { width: 2048, height: 2048 },
    n: 1,
    params: {},
    ...over,
  });
  const signal = () => new AbortController().signal;
  const imageRequests = () => server.requests.filter((r) => r.path.endsWith("/images/generations"));
  const sentImage = () => (imageRequests().at(-1)?.body as { image?: unknown } | undefined)?.image;
  const listed = async (id: string): Promise<ModelInfo | undefined> => {
    route = fixtures;
    return (await provider().listModels()).find((m) => m.id === id);
  };
  const failure = async (r: ImageGenerateRequest, opts: { signal?: AbortSignal } = {}) => {
    try {
      await provider().generateImage?.(r, { signal: opts.signal ?? signal() });
    } catch (e) {
      return e;
    }
    throw new Error("expected generateImage to throw");
  };

  it("lists Seedream models with their image facts (one image per call, pixel sizes)", async () => {
    const flash = await listed(SEEDREAM);
    expect(flash).toMatchObject({ kind: "image_generation", contextWindow: 0, parameters: [] });
    const info = flash?.imageGeneration;
    expect(isValidImageGenerationInfo(info)).toBe(true);
    expect(info).toMatchObject({
      defaultSize: { width: 2048, height: 2048 },
      maxImages: 1,
      maxReferenceImages: 10,
      outputMediaTypes: ["image/jpeg", "image/png"],
    });
    expect(info?.sizes).toContainEqual({ width: 1024, height: 1024 });
    expect(info?.sizes).toContainEqual({ width: 2816, height: 1584 });
    // every declared size is inside the family's pixel range (live 2026-11-18)
    for (const s of info?.sizes ?? []) {
      expect(s.width * s.height).toBeGreaterThanOrEqual(921_600);
      expect(s.width * s.height).toBeLessThanOrEqual(4_624_220);
    }

    // the live 4.0 entry has no modalities; the family table still gives its facts
    const v4 = (await listed(SEEDREAM_4))?.imageGeneration;
    expect(isValidImageGenerationInfo(v4)).toBe(true);
    expect(v4?.maxReferenceImages).toBe(14);

    // an image model without bundled facts stays listed but carries none (not callable)
    const edit = await listed("doubao-seededit-3-0-i2i-250628");
    expect(edit?.kind).toBe("image_generation");
    expect(edit?.imageGeneration).toBeUndefined();
  });

  it("4.5 and 5.0 lite sizes stay above their 3.69 MP minimum", async () => {
    route = () => ({
      status: 200,
      json: {
        data: [
          { domain: "ImageGeneration", id: "doubao-seedream-4-5-251128", status: "Retiring" },
          { domain: "ImageGeneration", id: "doubao-seedream-5-0-260128", status: "Retiring" },
        ],
      },
    });
    const models = await provider().listModels();
    expect(models).toHaveLength(2);
    for (const m of models) {
      expect(isValidImageGenerationInfo(m.imageGeneration)).toBe(true);
      for (const s of m.imageGeneration?.sizes ?? []) {
        expect(s.width * s.height).toBeGreaterThanOrEqual(3_686_400);
      }
    }
  });

  it("maps the request: pixel size, b64_json, no watermark, no n; returns the bytes", async () => {
    route = fixtures;
    const info = (await listed(SEEDREAM))?.imageGeneration;
    if (info === undefined) throw new Error("no image facts");
    const r = req({ size: { width: 2816, height: 1584 } });
    const res = await provider().generateImage?.(r, { signal: signal() });
    const sent = imageRequests().at(-1);
    expect(sent?.headers.authorization).toBe("Bearer ark-fixture");
    expect(sent?.body).toEqual({
      model: SEEDREAM,
      prompt: "a small red square",
      size: "2816x1584",
      response_format: "b64_json",
      watermark: false,
    });
    expect(res).toEqual({
      images: [{ mediaType: "image/jpeg", data: FAKE_JPEG_BASE64 }],
      usage: {
        inputTokens: 0,
        outputTokens: (2816 * 1584) / 256,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        outputImages: 1,
      },
    });
    expect(validateImageGenerateResult(r, info, res)).toBeNull();
  });

  it("sends reference images as data URLs: one as a string, several as an array", async () => {
    route = fixtures;
    const png = { mediaType: "image/png" as const, data: FAKE_PNG_BASE64 };
    await provider().generateImage?.(req({ referenceImages: [png] }), { signal: signal() });
    expect(sentImage()).toBe(`data:image/png;base64,${FAKE_PNG_BASE64}`);
    const jpeg = { mediaType: "image/jpeg" as const, data: FAKE_JPEG_BASE64 };
    await provider().generateImage?.(req({ referenceImages: [png, jpeg] }), { signal: signal() });
    expect(sentImage()).toEqual([
      `data:image/png;base64,${FAKE_PNG_BASE64}`,
      `data:image/jpeg;base64,${FAKE_JPEG_BASE64}`,
    ]);
  });

  it("n > maxImages (1) is invalid_request naming maxImages, with no request", async () => {
    route = fixtures;
    const before = imageRequests().length;
    const e = await failure(req({ n: 2 }));
    expect(kindOf(e)).toBe("invalid_request");
    expect((e as Error).message).toContain("at most 1 image(s) per call (maxImages)");
    expect(imageRequests().length).toBe(before);
  });

  it("sniffs the media type from the bytes (a PNG comes back as image/png)", async () => {
    route = () => imageOk({ size: "2048x2048", b64: FAKE_PNG_BASE64, format: "png" });
    const res = await provider().generateImage?.(req(), { signal: signal() });
    expect(res?.images[0]?.mediaType).toBe("image/png");
  });

  it("an item without b64_json (a URL only) -> server, nothing downloaded", async () => {
    let downloaded = 0;
    const tos = createServer((_req, res) => {
      downloaded++;
      res
        .writeHead(200, { "content-type": "image/jpeg" })
        .end(Buffer.from(FAKE_JPEG_BASE64, "base64"));
    });
    await new Promise<void>((resolve) => tos.listen(0, "127.0.0.1", resolve));
    try {
      const { port } = tos.address() as AddressInfo;
      route = () => ({
        status: 200,
        json: {
          data: [{ size: "2048x2048", url: `http://127.0.0.1:${port}/img.jpeg` }],
          usage: { generated_images: 1, output_tokens: 16384, total_tokens: 16384 },
        },
      });
      const e = await failure(req());
      expect(kindOf(e)).toBe("server");
      expect((e as Error).message).toBe("Ark: the image response carries no image");
      expect(downloaded).toBe(0);
    } finally {
      await new Promise((resolve) => tos.close(resolve));
    }
  });

  it("content moderation -> refusal with the vendor's reason", async () => {
    route = fixtures;
    const e = await failure(req({ prompt: "something forbidden" }));
    expect(kindOf(e)).toBe("refusal");
    expect((e as Error).message).toContain("OutputImageSensitiveContentDetected");
    expect((e as Error).message).toContain("sensitive information");

    route = () =>
      errorJson(400, {
        code: "InputTextSensitiveContentDetected",
        message: "The input text may contain sensitive information.",
      });
    expect(kindOf(await failure(req()))).toBe("refusal");

    // a per-image error in a 200 body
    route = () => ({
      status: 200,
      json: {
        data: [
          {
            error: {
              code: "OutputImageSensitiveContentDetected",
              message: "The output image may contain sensitive information.",
            },
          },
        ],
        usage: { generated_images: 0, output_tokens: 0, total_tokens: 0 },
      },
    });
    const perImage = await failure(req());
    expect(kindOf(perImage)).toBe("refusal");
    expect((perImage as Error).message).toContain("output image");
  });

  it("maps HTTP errors by status and code", async () => {
    const cases: [FakeResponse, string][] = [
      [errorJson(401, { code: "AuthenticationError", message: "bad key" }), "auth"],
      [errorJson(403, { code: "OperationDenied.ServiceNotOpen", message: "not open" }), "auth"],
      [
        errorJson(
          429,
          { code: "ModelAccountIpmRateLimitExceeded", message: "images per minute" },
          { "retry-after": "3" },
        ),
        "rate_limited",
      ],
      [errorJson(400, { code: "InvalidParameter", message: "size" }), "invalid_request"],
      [errorJson(500, { code: "InternalServiceError", message: "boom" }), "server"],
      [errorJson(503, { code: "ModelLoading", message: "loading" }), "overloaded"],
    ];
    for (const [res, kind] of cases) {
      route = () => res;
      const e = await failure(req());
      expect(kindOf(e)).toBe(kind);
      if (kind === "rate_limited") expect((e as { retryAfterMs?: number }).retryAfterMs).toBe(3000);
    }
    route = fixtures;
    const notActivated = await failure(req({ model: "doubao-seedream-5-5-261028" }));
    expect(kindOf(notActivated)).toBe("invalid_request");
    expect((notActivated as Error).message).toContain("activated");
  });

  it("a 200 without an image, or with bytes that are no image, is server", async () => {
    route = () => ({ status: 200, json: { data: [], usage: { generated_images: 0 } } });
    expect(kindOf(await failure(req()))).toBe("server");
    route = () => imageOk({ size: "2048x2048", b64: Buffer.from("hello").toString("base64") });
    expect(kindOf(await failure(req()))).toBe("server");
    route = () => ({ status: 200, json: "not an object" });
    expect(kindOf(await failure(req()))).toBe("server");
  });

  it("refuses a model without image facts before any request", async () => {
    route = fixtures;
    const before = imageRequests().length;
    expect(kindOf(await failure(req({ model: "doubao-seededit-3-0-i2i-250628" })))).toBe(
      "invalid_request",
    );
    expect(kindOf(await failure(req({ model: SEED })))).toBe("invalid_request");
    expect(imageRequests().length).toBe(before);
  });

  it("an org config without a key is auth with no request", async () => {
    route = fixtures;
    const before = server.requests.length;
    const p = createArkProvider({ apiKey: "setup-key", baseUrl: `${server.url}/api/v3` });
    try {
      await p.generateImage?.(req(), { signal: signal(), config: { region: "cn-beijing" } });
      throw new Error("expected auth");
    } catch (e) {
      expect(kindOf(e)).toBe("auth");
    }
    expect(server.requests.length).toBe(before);
  });

  it("abort: an aborted signal and an abort mid-request both end as aborted", async () => {
    route = fixtures;
    const ac = new AbortController();
    ac.abort();
    expect(kindOf(await failure(req(), { signal: ac.signal }))).toBe("aborted");

    route = () => ({ stall: true });
    const mid = new AbortController();
    const seen = imageRequests().length;
    const pending = failure(req(), { signal: mid.signal });
    await new Promise<void>((resolve) => {
      const check = () => (imageRequests().length > seen ? resolve() : setImmediate(check));
      check();
    });
    mid.abort();
    expect(kindOf(await pending)).toBe("aborted");
  });
});

// ---- live mode ----
// One small image on the cheapest activated Seedream model (CAPYBARA_TEST_ARK_IMAGE_MODEL picks
// one). The list is catalog-wide, so a not-activated model (404 with the activation hint) moves on
// to the next candidate; no activated model skips with the reasons.
const LIVE_KEY = process.env.CAPYBARA_TEST_ARK_API_KEY;
const LIVE_REGION = process.env.CAPYBARA_TEST_ARK_REGION;
if (!LIVE_KEY)
  console.info("[plugin-ark] CAPYBARA_TEST_ARK_API_KEY not set: live image test skipped");

describe.skipIf(!LIVE_KEY)("live", { timeout: 180_000 }, () => {
  it("live: generates one small image on an activated Seedream model", async (ctx) => {
    const provider = createArkProvider({
      apiKey: LIVE_KEY ?? "",
      ...(LIVE_REGION === "cn-beijing" || LIVE_REGION === "cn-shanghai"
        ? { region: LIVE_REGION }
        : {}),
    });
    const models = await provider.listModels();
    const want = process.env.CAPYBARA_TEST_ARK_IMAGE_MODEL;
    const images = models.filter((m) => m.imageGeneration !== undefined);
    expect(images.length).toBeGreaterThan(0);
    // flash first: the cheapest family
    const ordered = want
      ? images.filter((m) => m.id === want)
      : [
          ...images.filter((m) => m.id.includes("-flash-")),
          ...images.filter((m) => !m.id.includes("-flash-")),
        ];
    const reasons: string[] = [];
    for (const m of ordered.slice(0, 4)) {
      const info = m.imageGeneration;
      if (info === undefined) continue;
      // the smallest declared size keeps the cost and the payload down
      const size = [...info.sizes].sort((a, b) => a.width * a.height - b.width * b.height)[0];
      if (size === undefined) continue;
      const r: ImageGenerateRequest = {
        model: m.id,
        prompt: "a small red square on a white background",
        size,
        n: 1,
        params: {},
      };
      try {
        const res = await provider.generateImage?.(r, { signal: AbortSignal.timeout(170_000) });
        expect(validateImageGenerateResult(r, info, res)).toBeNull();
        console.info(
          `[plugin-ark] live image ${m.id} ${size.width}x${size.height}: ${res?.images[0]?.mediaType}, ${res?.images[0]?.data.length} base64 chars, usage ${JSON.stringify(res?.usage)}`,
        );
        return;
      } catch (e) {
        const notActivated =
          isModelError(e) && e.kind === "invalid_request" && e.message.includes("activated");
        if (!notActivated) throw e;
        reasons.push(`${m.id}: ${(e as Error).message}`);
      }
    }
    console.info(`[plugin-ark] live: no activated image model (${reasons.join("; ")})`);
    ctx.skip();
  });
});
