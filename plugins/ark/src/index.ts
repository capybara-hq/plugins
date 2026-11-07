import {
  defineExtension,
  MODEL_PROVIDER_EXTENSION_POINT_V2,
  ModelError,
  type ModelProvider,
  orgAccess,
  secret,
  ui,
} from "@capybara-hq/plugin-sdk";
import OpenAI from "openai";
import { z } from "zod";
import { embedTexts } from "./embed.js";
import { toModelError } from "./errors.js";
import { listArkModels } from "./list.js";
import { streamChat } from "./map-stream.js";

// capybara:allow-module-state a read-only list of region names
const REGIONS = ["cn-beijing", "cn-shanghai"] as const;
type Region = (typeof REGIONS)[number];
const DEFAULT_REGION: Region = "cn-beijing";

/** Ark's data plane of a region. */
const dataPlane = (region: Region) => `https://ark.${region}.volces.com/api/v3`;

/**
 * Deployment config. Both fields are org-overridable, so the platform's copy may lack the key:
 * the key is required per call (not at load), and read from the per-call `opts.config`.
 *
 * No AK/SK `management` field: the inference key lists the models itself (`GET /api/v3/models`,
 * live 2026-11-08), so the control plane is not needed (design B §6.3: "if it does, AK/SK is
 * dropped").
 */
const DeploymentConfig = z.object({
  apiKey: orgAccess(
    ui(secret(z.string().min(1).optional()), { label: { zh: "API 密钥", en: "API key" } }),
    "override",
  ),
  region: orgAccess(
    ui(z.enum(REGIONS).default(DEFAULT_REGION), { label: { zh: "地域", en: "Region" } }),
    "override",
  ),
});

export interface ArkDefaults {
  apiKey?: string | undefined;
  region?: Region | undefined;
  /** The data plane base URL instead of the region's (tests: a fake server). Never from config. */
  baseUrl?: string | undefined;
}

/**
 * The key and data plane of this call. The config is resolved as a whole: with a per-call config
 * (the kernel always passes the org's effective one) only its values count, so a missing key is
 * `auth` before any request and the setup key is never sent for an org; the setup defaults serve
 * only a call without one (the conformance suite).
 */
function resolve(defaults: ArkDefaults, config: unknown): { apiKey: string; baseUrl: string } {
  let apiKey: string | undefined;
  let region: Region;
  if (config === undefined) {
    apiKey = defaults.apiKey;
    region = defaults.region ?? DEFAULT_REGION;
  } else {
    const parsed = DeploymentConfig.safeParse(config);
    if (!parsed.success) {
      throw new ModelError("invalid_request", "Ark: the extension config is invalid");
    }
    apiKey = parsed.data.apiKey;
    region = parsed.data.region;
  }
  if (apiKey === undefined || apiKey === "") {
    throw new ModelError("auth", "Ark: no API key is configured");
  }
  return { apiKey, baseUrl: (defaults.baseUrl ?? dataPlane(region)).replace(/\/+$/, "") };
}

/**
 * model-provider@2 for Volcengine Ark: the list from the data plane's `/models`, chat on its Chat
 * Completions API (the official `openai` SDK), text embeddings on `/embeddings/multimodal`. No
 * process state: everything is built per call because the key and region can differ per org.
 */
export function createArkProvider(defaults: ArkDefaults): ModelProvider {
  return {
    async listModels(opts) {
      const { apiKey, baseUrl } = resolve(defaults, opts?.config);
      return listArkModels(baseUrl, apiKey);
    },
    async *stream(req, opts) {
      let client: OpenAI;
      try {
        const { apiKey, baseUrl } = resolve(defaults, opts.config);
        client = new OpenAI({
          baseURL: baseUrl,
          apiKey,
          // Do not read OPENAI_* env vars: never send OpenAI headers to another service
          organization: null,
          project: null,
          adminAPIKey: null,
          // Retries belong to the kernel's degradation ladder
          maxRetries: 0,
        });
      } catch (e) {
        throw toModelError(e, opts.signal);
      }
      yield* streamChat(client, req, opts.signal);
    },
    async embed(req, opts) {
      const { apiKey, baseUrl } = resolve(defaults, opts.config);
      return embedTexts(baseUrl, apiKey, req, opts.signal);
    },
  };
}

/** Volcengine Ark model provider plugin: chat (thinking, encrypted replay) and embeddings. */
export default defineExtension({
  name: "ark",
  version: "0.1.0-rc.0",
  sdk: "^0.1.0-rc.4",
  provides: [MODEL_PROVIDER_EXTENSION_POINT_V2],
  // The two regions' data planes (display only, the platform does not intercept)
  permissions: { network: ["ark.cn-beijing.volces.com", "ark.cn-shanghai.volces.com"] },
  config: { deployment: DeploymentConfig },
  setup(ctx) {
    // Lenient: the platform's config may lack the (overridable) key
    const cfg = DeploymentConfig.safeParse(ctx.config ?? {});
    ctx.provide(
      MODEL_PROVIDER_EXTENSION_POINT_V2,
      createArkProvider({
        apiKey: cfg.success ? cfg.data.apiKey : undefined,
        region: cfg.success ? cfg.data.region : undefined,
      }),
    );
  },
});
