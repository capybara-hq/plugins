import {
  isModelError,
  type ModelInfo,
  type ModelProvider,
  validateImageGenerateResult,
} from "@capybara-hq/plugin-sdk";
import { describeModelProviderConformance } from "@capybara-hq/testing";
import { describe, expect, it } from "vitest";
import { type BailianDefaults, createBailianProvider } from "../../src/index.js";

/**
 * Live conformance against Alibaba Cloud Model Studio. Gated by CAPYBARA_TEST_BAILIAN_API_KEY
 * (+ _REGION, _WORKSPACE_ID). Models come from `_CHAT_MODEL` / `_EMBED_MODEL` when set, else from
 * the live list: the first chat model of each endpoint (vision → multimodal-generation, text-only
 * → text-generation) and the first embedding model; a candidate failing with an access /
 * not-activated error (`auth` / `invalid_request`) moves to the next, at most 5, then the case is
 * skipped with one printed reason. Image generation makes ONE image with `_IMAGE_MODEL` (default
 * `wanx2.0-t2i-turbo`, the cheapest bundled model; its async task covers polling and the download).
 */
const KEY = process.env.CAPYBARA_TEST_BAILIAN_API_KEY;
const PLUGIN = "bailian";
const MAX_CANDIDATES = 5;

/**
 * The list is memoized here as the kernel caches it (600 s): the suite asks for it in many cases,
 * and the list route is rate limited (429 `Throttling.RateQuota`, live 2026-11-08).
 */
function memoizedList(p: ModelProvider): ModelProvider {
  let list: Promise<ModelInfo[]> | undefined;
  return {
    listModels: (opts) => {
      list ??= p.listModels(opts);
      return list;
    },
    stream: (req, opts) => p.stream(req, opts),
    embed: (req, opts) => (p.embed as NonNullable<ModelProvider["embed"]>)(req, opts),
    generateImage: (req, opts) =>
      (p.generateImage as NonNullable<ModelProvider["generateImage"]>)(req, opts),
  };
}

const provider: ModelProvider | undefined = KEY
  ? memoizedList(
      createBailianProvider({
        apiKey: KEY,
        region: process.env.CAPYBARA_TEST_BAILIAN_REGION as BailianDefaults["region"],
        workspaceId: process.env.CAPYBARA_TEST_BAILIAN_WORKSPACE_ID,
      }),
    )
  : undefined;

const skipped = (what: string, why: string) =>
  console.info(`[plugin-bailian] live ${what} skipped: ${why}`);

const usable = (e: unknown) =>
  !(isModelError(e) && (e.kind === "auth" || e.kind === "invalid_request"));

async function chatWorks(p: ModelProvider, id: string): Promise<boolean> {
  try {
    for await (const _ of p.stream(
      {
        model: id,
        system: [],
        messages: [{ role: "user", content: [{ type: "text", text: "Say OK." }] }],
        tools: [],
        maxOutputTokens: 16,
        params: {},
      },
      { signal: AbortSignal.timeout(60_000) },
    )) {
      // drain
    }
    return true;
  } catch (e) {
    if (usable(e)) throw e;
    return false;
  }
}

async function embedWorks(p: ModelProvider, m: ModelInfo): Promise<boolean> {
  try {
    await p.embed?.({ model: m.id, input: ["ok"] }, { signal: AbortSignal.timeout(60_000) });
    return true;
  } catch (e) {
    if (usable(e)) throw e;
    return false;
  }
}

async function pick<T extends ModelInfo>(
  candidates: T[],
  works: (m: T) => Promise<boolean>,
): Promise<T | undefined> {
  for (const m of candidates.slice(0, MAX_CANDIDATES)) {
    if (await works(m)) return m;
  }
  return undefined;
}

let models: ModelInfo[] = [];
if (!provider) {
  skipped("conformance", "CAPYBARA_TEST_BAILIAN_API_KEY not set");
} else {
  models = await provider.listModels();
}

const chats = models.filter((m) => (m.kind ?? "chat") === "chat" && m.capabilities.tools);
const named = (env: string | undefined, list: ModelInfo[]) =>
  env ? list.filter((m) => m.id === env) : list;

const vision =
  provider &&
  (await pick(
    named(process.env.CAPYBARA_TEST_BAILIAN_CHAT_MODEL, chats).filter((m) => m.capabilities.vision),
    (m) => chatWorks(provider, m.id),
  ));
const textOnly =
  provider &&
  (await pick(
    named(process.env.CAPYBARA_TEST_BAILIAN_CHAT_MODEL, chats).filter(
      (m) => !m.capabilities.vision,
    ),
    (m) => chatWorks(provider, m.id),
  ));
const embedding =
  provider &&
  (await pick(
    named(
      process.env.CAPYBARA_TEST_BAILIAN_EMBED_MODEL,
      models.filter((m) => m.kind === "embedding"),
    ),
    (m) => embedWorks(provider, m),
  ));

if (provider) {
  if (!vision) skipped("vision chat", "no usable vision chat model among the first candidates");
  if (!textOnly) skipped("text chat", "no usable text-only chat model among the first candidates");
  if (!embedding) skipped("embedding", "no usable embedding model among the first candidates");
}

for (const [label, model] of [
  ["multimodal-generation", vision],
  ["text-generation", textOnly],
] as const) {
  describe.skipIf(!provider || !model)(`live ${label}`, { timeout: 180_000 }, () => {
    describeModelProviderConformance(`bailian (live, ${model?.id})`, async () => ({
      plugin: PLUGIN,
      provider: provider as ModelProvider,
      model: model?.id ?? "",
      expect: {
        thinking: model?.capabilities.reasoning ?? false,
        caching: model?.capabilities.caching ?? false,
        ...(embedding?.embedding
          ? {
              embedding: { model: embedding.id, dimensions: embedding.embedding.defaultDimensions },
            }
          : {}),
      },
      cachePrefixTokens: 2000,
      teardown: async () => {},
    }));
  });
}

const IMAGE_MODEL = process.env.CAPYBARA_TEST_BAILIAN_IMAGE_MODEL ?? "wanx2.0-t2i-turbo";
const imageModel = models.find((m) => m.id === IMAGE_MODEL && m.imageGeneration !== undefined);
if (provider && !imageModel) {
  skipped("image generation", `${IMAGE_MODEL} is not listed with imageGeneration for this key`);
}

describe.skipIf(!provider || !imageModel)("live image generation", { timeout: 180_000 }, () => {
  it(`generates one image with ${IMAGE_MODEL} as bytes`, async () => {
    const info = imageModel?.imageGeneration;
    if (!provider?.generateImage || !info) throw new Error("unreachable");
    const req = {
      model: IMAGE_MODEL,
      prompt: "a small red square on a white background",
      size: info.defaultSize,
      n: 1,
      params: {},
    };
    const res = await provider.generateImage(req, { signal: AbortSignal.timeout(170_000) });
    expect(validateImageGenerateResult(req, info, res)).toBeNull();
    expect(res.usage.outputImages).toBe(1);
    console.info(
      `[plugin-bailian] live image: ${res.images[0]?.mediaType}, ${res.images[0]?.data.length} base64 chars, revised prompt ${res.revisedPrompt ? "yes" : "no"}`,
    );
  });
});
