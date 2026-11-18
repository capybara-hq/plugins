import {
  defineExtension,
  type Logger,
  MODEL_PROVIDER_EXTENSION_POINT_V2,
  ModelError,
  type ModelProvider,
} from "@capybara-hq/plugin-sdk";
import {
  type BailianDefaults,
  CallConfig,
  DeploymentConfig,
  resolveTarget,
  type Target,
} from "./config.js";
import { embedTexts } from "./embed.js";
import { toModelError } from "./errors.js";
import { generateBailianImage, type PollTiming } from "./image.js";
import { type Endpoint, endpointOf, findModel, listBailianModels } from "./list.js";
import { streamGeneration } from "./map-stream.js";
import { ENDPOINT_CACHE_TTL_SECONDS, IMAGE_POLL_INITIAL_MS, IMAGE_POLL_MAX_MS } from "./tables.js";

export { type BailianDefaults, baseUrlFor } from "./config.js";

/** The ctx.kv subset the provider uses. */
export interface Kv {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, opts: { ttlSeconds: number }): Promise<void>;
}

export interface BailianDeps {
  /** Caches each model's generation endpoint (optional: without it every call looks it up). */
  kv?: Kv | undefined;
  /** listModels warns about embedding models missing from the bundled table. */
  log?: Pick<Logger, "warn"> | undefined;
  /** Image task polling (tests shorten it); defaults 1 s doubling to 5 s. */
  imagePoll?: PollTiming | undefined;
}

/**
 * The native endpoint of a model (vision → multimodal-generation, else text-generation), from its
 * list entry; cached per origin and model in kv. A model the list does not know is invalid_request.
 */
async function endpointFor(
  t: Target,
  model: string,
  deps: BailianDeps,
  signal: AbortSignal,
): Promise<Endpoint> {
  const key = `endpoint:v1:${t.baseUrl}:${model}`;
  // kv is only a cache: a failing kv (Redis trouble) counts as a miss and never fails the call
  let warned = false;
  const kvFailed = (op: string, e: unknown) => {
    if (warned) return;
    warned = true;
    deps.log?.warn("bailian: endpoint cache unavailable, looking the model up", {
      op,
      error: e instanceof Error ? e.message : String(e),
    });
  };
  let cached: string | null | undefined;
  try {
    cached = await deps.kv?.get(key);
  } catch (e) {
    kvFailed("get", e);
  }
  if (cached === "text" || cached === "multimodal") return cached;
  const raw = await findModel(t, model, signal);
  if (raw === null) {
    throw new ModelError("invalid_request", `Bailian: model "${model}" is not in the model list`);
  }
  const endpoint = endpointOf(raw);
  try {
    await deps.kv?.set(key, endpoint, { ttlSeconds: ENDPOINT_CACHE_TTL_SECONDS });
  } catch (e) {
    kvFailed("set", e);
  }
  return endpoint;
}

/**
 * model-provider@2 for Alibaba Cloud Model Studio on DashScope's native API (fetch, no vendor SDK,
 * no retries). No process state: the key and origin are resolved per call because they can differ
 * per organization.
 */
export function createBailianProvider(
  defaults: BailianDefaults,
  deps: BailianDeps = {},
): ModelProvider {
  return {
    async listModels(opts) {
      const t = resolveTarget(defaults, opts?.config);
      try {
        return await listBailianModels(t, deps.log);
      } catch (e) {
        throw toModelError(e);
      }
    },
    async *stream(req, opts) {
      let t: Target;
      let endpoint: Endpoint;
      try {
        if (opts.signal.aborted) throw new ModelError("aborted", "Request aborted");
        t = resolveTarget(defaults, opts.config);
        endpoint = await endpointFor(t, req.model, deps, opts.signal);
      } catch (e) {
        throw toModelError(e, opts.signal);
      }
      yield* streamGeneration(t, req, endpoint, opts.signal);
    },
    async embed(req, opts) {
      try {
        if (opts.signal.aborted) throw new ModelError("aborted", "Request aborted");
        return await embedTexts(resolveTarget(defaults, opts.config), req, opts.signal);
      } catch (e) {
        throw toModelError(e, opts.signal);
      }
    },
    async generateImage(req, opts) {
      try {
        if (opts.signal.aborted) throw new ModelError("aborted", "Request aborted");
        return await generateBailianImage(resolveTarget(defaults, opts.config), req, {
          signal: opts.signal,
          poll: deps.imagePoll ?? { initialMs: IMAGE_POLL_INITIAL_MS, maxMs: IMAGE_POLL_MAX_MS },
          downloadOrigins: defaults.downloadOrigins ?? [],
        });
      } catch (e) {
        throw toModelError(e, opts.signal);
      }
    },
  };
}

/** Alibaba Cloud Model Studio (Bailian) model provider plugin. */
export default defineExtension({
  name: "bailian",
  version: "0.1.0-rc.9",
  sdk: "^0.1.0-rc.4",
  provides: [MODEL_PROVIDER_EXTENSION_POINT_V2],
  permissions: {
    // Display only (the platform does not intercept). Workspace hosts
    // ({workspaceId}.{region}.maas.aliyuncs.com) cannot be listed exactly (no wildcards): the
    // regional parents and the shared domains stand for them.
    network: [
      "dashscope.aliyuncs.com",
      "dashscope-us.aliyuncs.com",
      "cn-beijing.maas.aliyuncs.com",
      "ap-southeast-1.maas.aliyuncs.com",
      "cn-hongkong.maas.aliyuncs.com",
      "ap-northeast-1.maas.aliyuncs.com",
      "eu-central-1.maas.aliyuncs.com",
      // Result images of image generation: signed links on the OSS result buckets
      // ({bucket}.oss-{region}.aliyuncs.com, live: dashscope-*.oss-cn-beijing.aliyuncs.com,
      // dashscope-*.oss-accelerate.aliyuncs.com). The code downloads from any https host under
      // aliyuncs.com (no redirects); the OSS endpoints of the supported regions stand for them.
      "oss-cn-beijing.aliyuncs.com",
      "oss-us-east-1.aliyuncs.com",
      "oss-ap-southeast-1.aliyuncs.com",
      "oss-cn-hongkong.aliyuncs.com",
      "oss-ap-northeast-1.aliyuncs.com",
      "oss-eu-central-1.aliyuncs.com",
      "oss-accelerate.aliyuncs.com",
    ],
  },
  config: { deployment: DeploymentConfig },
  setup(ctx) {
    // Lenient: the platform's config may lack the (overridable) key
    const cfg = CallConfig.safeParse(ctx.config ?? {});
    ctx.provide(
      MODEL_PROVIDER_EXTENSION_POINT_V2,
      createBailianProvider(
        cfg.success
          ? { apiKey: cfg.data.apiKey, region: cfg.data.region, workspaceId: cfg.data.workspaceId }
          : {},
        { kv: ctx.kv, log: ctx.log },
      ),
    );
  },
});
