import {
  type ImageGenerateRequest,
  type ImageGenerateResult,
  isModelError,
  isValidImageGenerationInfo,
  validateImageGenerateResult,
} from "@capybara-hq/plugin-sdk";
import {
  type FakeModelServer,
  type FakeRequest,
  type FakeResponse,
  redPngBase64,
  startFakeModelServer,
} from "@capybara-hq/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type BailianDeps, createBailianProvider } from "../src/index.js";
import { IMAGE_MODELS } from "../src/tables.js";
import {
  errorJson,
  fixtureModels,
  IMAGE_PNG,
  type ImageServer,
  listResponse,
  MULTIMODAL_PATH,
  multimodalImages,
  startImageServer,
  TEXT2IMAGE_PATH,
  taskStatus,
  taskSubmitted,
} from "./fixtures.js";

let server: FakeModelServer | undefined;
let images: ImageServer;

beforeEach(async () => {
  images = await startImageServer();
});
afterEach(async () => {
  await server?.stop();
  server = undefined;
  await images.stop();
});

const FAST_POLL: BailianDeps = { imagePoll: { initialMs: 1, maxMs: 4 } };

async function providerWith(routes: (r: FakeRequest) => FakeResponse, deps = FAST_POLL) {
  server = await startFakeModelServer(routes);
  return createBailianProvider(
    { apiKey: "sk-fixture", baseUrl: server.url, downloadOrigins: [images.url] },
    deps,
  );
}

const qwenReq = (over: Partial<ImageGenerateRequest> = {}): ImageGenerateRequest => ({
  model: "qwen-image-2.0",
  prompt: "a small red square",
  size: { width: 1024, height: 1024 },
  n: 1,
  params: {},
  ...over,
});

const wanxReq = (over: Partial<ImageGenerateRequest> = {}): ImageGenerateRequest =>
  qwenReq({ model: "wanx2.0-t2i-turbo", ...over });

async function generate(
  provider: Awaited<ReturnType<typeof providerWith>>,
  req: ImageGenerateRequest,
  signal: AbortSignal = new AbortController().signal,
): Promise<{ res?: ImageGenerateResult; error?: unknown }> {
  try {
    const gen = provider.generateImage;
    if (!gen) throw new Error("no generateImage");
    return { res: await gen(req, { signal }) };
  } catch (error) {
    return { error };
  }
}

const kindOf = (e: unknown) => (isModelError(e) ? e.kind : `not a ModelError: ${String(e)}`);
const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));
const generationRequests = () =>
  (server?.requests ?? []).filter((r) => !r.path.startsWith("/api/v1/models"));

describe("image models in the list", () => {
  it("bundled IG models carry valid imageGeneration; unknown IG models stay list-only", async () => {
    const provider = await providerWith((r) => listResponse(r.path, fixtureModels()));
    const list = await provider.listModels();
    const qwen = list.find((m) => m.id === "qwen-image-2.0");
    expect(qwen?.kind).toBe("image_generation");
    expect(isValidImageGenerationInfo(qwen?.imageGeneration)).toBe(true);
    expect(qwen?.imageGeneration).toMatchObject({
      defaultSize: { width: 2048, height: 2048 },
      maxImages: 6,
      maxReferenceImages: 3,
      outputMediaTypes: ["image/png"],
    });
    expect(qwen?.imageGeneration).not.toHaveProperty("api");
    const wanx = list.find((m) => m.id === "wanx2.0-t2i-turbo");
    expect(wanx?.imageGeneration).toMatchObject({ maxImages: 4, maxReferenceImages: 0 });
    const unknown = list.find((m) => m.id === "wan2.7-t2i");
    expect(unknown?.kind).toBe("image_generation");
    expect(unknown?.imageGeneration).toBeUndefined();
  });

  it("every bundled image model is valid and its sizes fit the vendor rules", () => {
    for (const [id, info] of Object.entries(IMAGE_MODELS)) {
      expect(isValidImageGenerationInfo(info), id).toBe(true);
      for (const s of info.sizes) {
        // the API snaps to multiples of 16 (qwen) or requires multiples of 8 (wan)
        expect(s.width % 16 === 0 && s.height % 16 === 0, `${id} ${s.width}x${s.height}`).toBe(
          true,
        );
      }
    }
  });
});

describe("generateImage: sync multimodal-generation", () => {
  it("maps prompt, size, n and reference images, downloads the URLs and returns bytes", async () => {
    const provider = await providerWith((r) =>
      r.path === MULTIMODAL_PATH
        ? multimodalImages([`${images.url}/img/a.png`, `${images.url}/img/b.png`])
        : errorJson(404, "InvalidParameter", "no route"),
    );
    const ref = redPngBase64();
    const req = qwenReq({ n: 2, referenceImages: [{ mediaType: "image/png", data: ref }] });
    const { res, error } = await generate(provider, req);
    expect(error).toBeUndefined();
    const sent = generationRequests();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.path).toBe(MULTIMODAL_PATH);
    expect(sent[0]?.headers.authorization).toBe("Bearer sk-fixture");
    expect(sent[0]?.headers["x-dashscope-async"]).toBeUndefined();
    expect(sent[0]?.body).toEqual({
      model: "qwen-image-2.0",
      input: {
        messages: [
          {
            role: "user",
            content: [{ image: `data:image/png;base64,${ref}` }, { text: "a small red square" }],
          },
        ],
      },
      parameters: { size: "1024*1024", n: 2, watermark: false },
    });
    expect(images.hits).toEqual(["/img/a.png", "/img/b.png"]);
    // the signed URL needs no key, and the key never goes to the download host
    for (const h of images.headers) expect(h.authorization).toBeUndefined();
    expect(res?.images).toEqual([
      { mediaType: "image/png", data: IMAGE_PNG.toString("base64") },
      { mediaType: "image/png", data: IMAGE_PNG.toString("base64") },
    ]);
    expect(res?.revisedPrompt).toBeUndefined();
    expect(res?.usage).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outputImages: 2,
    });
    const info = IMAGE_MODELS["qwen-image-2.0"];
    expect(info && validateImageGenerateResult(req, info, res)).toBeNull();
  });

  it("reads images spread over several choices", async () => {
    const provider = await providerWith(() => ({
      status: 200,
      json: {
        output: {
          choices: [`${images.url}/img/a.png`, `${images.url}/img/b.png`].map((image) => ({
            finish_reason: "stop",
            message: { role: "assistant", content: [{ type: "image", image }] },
          })),
        },
        usage: { image_count: 2 },
      },
    }));
    const { res } = await generate(
      provider,
      qwenReq({ model: "wan2.6-t2i", n: 2, size: { width: 1280, height: 1280 } }),
    );
    expect(res?.images).toHaveLength(2);
    expect((generationRequests()[0]?.body as { input?: unknown } | undefined)?.input).toEqual({
      messages: [{ role: "user", content: [{ text: "a small red square" }] }],
    });
  });

  it("fewer images than n is server", async () => {
    const provider = await providerWith(() => multimodalImages([`${images.url}/img/a.png`]));
    const { error } = await generate(provider, qwenReq({ n: 2 }));
    expect(kindOf(error)).toBe("server");
    expect(images.hits).toHaveLength(0);
  });
});

describe("generateImage: async text2image task", () => {
  it("submits with the async header, polls the task and returns the bytes and actual prompt", async () => {
    let polls = 0;
    const provider = await providerWith((r) => {
      if (r.path === TEXT2IMAGE_PATH) return taskSubmitted("t-1");
      if (r.path === "/api/v1/tasks/t-1") {
        polls++;
        if (polls === 1) return taskStatus("t-1", "PENDING");
        if (polls === 2) return taskStatus("t-1", "RUNNING");
        return taskStatus("t-1", "SUCCEEDED", {
          results: [
            {
              orig_prompt: "a small red square",
              actual_prompt: "best quality, a small red square",
              url: `${images.url}/img/t.png`,
            },
          ],
        });
      }
      return errorJson(404, "InvalidParameter", "no route");
    });
    const req = wanxReq();
    const { res, error } = await generate(provider, req);
    expect(error).toBeUndefined();
    const sent = generationRequests();
    expect(sent[0]?.path).toBe(TEXT2IMAGE_PATH);
    expect(sent[0]?.headers["x-dashscope-async"]).toBe("enable");
    expect(sent[0]?.body).toEqual({
      model: "wanx2.0-t2i-turbo",
      input: { prompt: "a small red square" },
      parameters: { size: "1024*1024", n: 1, watermark: false },
    });
    expect(sent.slice(1).map((r) => r.path)).toEqual([
      "/api/v1/tasks/t-1",
      "/api/v1/tasks/t-1",
      "/api/v1/tasks/t-1",
    ]);
    expect(res?.revisedPrompt).toBe("best quality, a small red square");
    expect(res?.usage.outputImages).toBe(1);
    const info = IMAGE_MODELS["wanx2.0-t2i-turbo"];
    expect(info && validateImageGenerateResult(req, info, res)).toBeNull();
  });

  it("accepts a JPEG from a model that declares it", async () => {
    const provider = await providerWith((r) =>
      r.path === TEXT2IMAGE_PATH
        ? taskSubmitted("t-2")
        : taskStatus("t-2", "SUCCEEDED", { results: [{ url: `${images.url}/img/t.jpg` }] }),
    );
    const { res } = await generate(provider, wanxReq());
    expect(res?.images[0]?.mediaType).toBe("image/jpeg");
  });

  it.each<[string, Record<string, unknown>, string]>([
    [
      "DataInspectionFailed",
      { code: "DataInspectionFailed", message: "Output data may contain inappropriate content." },
      "refusal",
    ],
    [
      "IPInfringementSuspect",
      {
        code: "IPInfringementSuspect",
        message: "Input data is suspected of being involved in IP infringement.",
      },
      "refusal",
    ],
    [
      "InvalidParameter",
      { code: "InvalidParameter", message: "The height and width should be divided by 8" },
      "invalid_request",
    ],
    ["InternalError", { code: "InternalError", message: "oops" }, "server"],
  ])("a FAILED task with %s is %s", async (_c, failure, kind) => {
    const provider = await providerWith((r) =>
      r.path === TEXT2IMAGE_PATH
        ? taskSubmitted("t-3")
        : taskStatus("t-3", "FAILED", failure as { code: string; message: string }),
    );
    const { error } = await generate(provider, wanxReq());
    expect(kindOf(error)).toBe(kind);
    expect(messageOf(error)).toContain(String(failure.message));
  });

  it("a partly failed task is refusal when a result was moderated, else server", async () => {
    for (const [code, kind] of [
      ["DataInspectionFailed", "refusal"],
      ["InternalError.Timeout", "server"],
    ] as const) {
      const provider = await providerWith((r) =>
        r.path === TEXT2IMAGE_PATH
          ? taskSubmitted("t-4")
          : taskStatus("t-4", "SUCCEEDED", {
              results: [{ url: `${images.url}/img/ok.png` }, { code, message: "image 2 failed" }],
            }),
      );
      const { error } = await generate(provider, wanxReq({ n: 2 }));
      expect(kindOf(error)).toBe(kind);
      await server?.stop();
      server = undefined;
    }
  });

  it.each(["UNKNOWN", "CANCELED"] as const)("a %s task is server", async (status) => {
    const provider = await providerWith((r) =>
      r.path === TEXT2IMAGE_PATH ? taskSubmitted("t-5") : taskStatus("t-5", status),
    );
    const { error } = await generate(provider, wanxReq());
    expect(kindOf(error)).toBe("server");
  });

  it("a submit answer without a task id is server", async () => {
    const provider = await providerWith(() => ({ status: 200, json: { output: {} } }));
    const { error } = await generate(provider, wanxReq());
    expect(kindOf(error)).toBe("server");
  });
});

describe("generateImage: errors", () => {
  it.each<[string, FakeResponse, string]>([
    [
      "400 DataInspectionFailed",
      errorJson(400, "DataInspectionFailed", "Input data may contain inappropriate content."),
      "refusal",
    ],
    [
      "400 InvalidParameter",
      errorJson(400, "InvalidParameter", "Image area must be between 262144 and 4194304 pixels."),
      "invalid_request",
    ],
    ["401", errorJson(401, "InvalidApiKey", "Invalid API-key provided."), "auth"],
    [
      "429",
      errorJson(429, "Throttling.RateQuota", "Requests rate limit exceeded", {
        "retry-after": "3",
      }),
      "rate_limited",
    ],
    ["500", errorJson(500, "InternalError", "oops"), "server"],
    ["503", errorJson(503, "ServiceUnavailable", "busy"), "overloaded"],
  ])("HTTP %s is %s", async (_n, response, kind) => {
    const provider = await providerWith(() => response);
    const { error } = await generate(provider, qwenReq());
    expect(kindOf(error)).toBe(kind);
    if (kind === "rate_limited" && isModelError(error)) expect(error.retryAfterMs).toBe(3000);
    if (kind === "refusal") expect(messageOf(error)).toContain("inappropriate content");
    // never retried inside the plugin
    expect(generationRequests()).toHaveLength(1);
  });

  it.each([
    ["a 404 download", "/missing/a.png"],
    ["a download that is not an image", "/text/a.png"],
  ])("%s is server", async (_label, path) => {
    const provider = await providerWith(() => multimodalImages([`${images.url}${path}`]));
    const { error } = await generate(provider, qwenReq());
    expect(kindOf(error)).toBe("server");
  });

  it("a JPEG from a PNG-only model is server", async () => {
    const provider = await providerWith(() => multimodalImages([`${images.url}/img/a.jpg`]));
    const { error } = await generate(provider, qwenReq());
    expect(kindOf(error)).toBe("server");
  });

  it("refuses to download a URL outside the vendor's hosts", async () => {
    for (const url of [
      "http://169.254.169.254/latest/meta-data",
      "http://oss.aliyuncs.com/a.png",
      "https://evil.example/a.png",
    ]) {
      const provider = await providerWith(() => multimodalImages([url]));
      const { error } = await generate(provider, qwenReq());
      expect(kindOf(error)).toBe("server");
      expect(messageOf(error)).not.toContain(url);
      await server?.stop();
      server = undefined;
    }
  });

  it.each<[string, Partial<ImageGenerateRequest>]>([
    ["an unknown model", { model: "wan2.7-t2i" }],
    ["too many images", { n: 7 }],
    ["an undeclared size", { size: { width: 512, height: 512 } }],
    [
      "reference images on a text-only model",
      {
        model: "wanx2.0-t2i-turbo",
        referenceImages: [{ mediaType: "image/png", data: redPngBase64() }],
      },
    ],
  ])("%s is invalid_request before any request", async (_label, over) => {
    const provider = await providerWith(() => multimodalImages([]));
    const { error } = await generate(provider, qwenReq(over));
    expect(kindOf(error)).toBe("invalid_request");
    expect(generationRequests()).toHaveLength(0);
  });

  it("no key is auth before any request", async () => {
    server = await startFakeModelServer(() => multimodalImages([]));
    const provider = createBailianProvider({ baseUrl: server.url });
    const { error } = await generate(provider, qwenReq());
    expect(kindOf(error)).toBe("auth");
    expect(server.requests).toHaveLength(0);
  });
});

describe("generateImage: abort", () => {
  it("an aborted signal sends nothing", async () => {
    const provider = await providerWith(() => multimodalImages([]));
    const ac = new AbortController();
    ac.abort();
    const { error } = await generate(provider, qwenReq(), ac.signal);
    expect(kindOf(error)).toBe("aborted");
    expect(generationRequests()).toHaveLength(0);
  });

  it("aborting while waiting between polls ends the call at once", async () => {
    const ac = new AbortController();
    const provider = await providerWith(
      (r) => {
        // after the submit the call waits a minute before its first poll: abort during the wait
        if (r.path === TEXT2IMAGE_PATH) {
          setTimeout(() => ac.abort(), 50);
          return taskSubmitted("t-6");
        }
        return taskStatus("t-6", "RUNNING");
      },
      { imagePoll: { initialMs: 60_000, maxMs: 60_000 } },
    );
    const { error } = await generate(provider, wanxReq(), ac.signal);
    expect(kindOf(error)).toBe("aborted");
    expect(generationRequests().map((r) => r.path)).toEqual([TEXT2IMAGE_PATH]);
  });

  it("aborting a stalled download is aborted", async () => {
    const ac = new AbortController();
    const provider = await providerWith(() => {
      setTimeout(() => ac.abort(), 20);
      return multimodalImages([`${images.url}/stall/a.png`]);
    });
    const { error } = await generate(provider, qwenReq(), ac.signal);
    expect(kindOf(error)).toBe("aborted");
  });
});
