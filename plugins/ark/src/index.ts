import {
  defineExtension,
  type Logger,
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
import { listEndpoints, type Management } from "./endpoints.js";
import { toModelError } from "./errors.js";
import { listArkModels, withEndpoints } from "./list.js";
import { streamChat } from "./map-stream.js";

// capybara:allow-module-state a read-only list of region names
const REGIONS = ["cn-beijing", "cn-shanghai"] as const;
type Region = (typeof REGIONS)[number];
const DEFAULT_REGION: Region = "cn-beijing";

/** Ark's data plane of a region. */
const dataPlane = (region: Region) => `https://ark.${region}.volces.com/api/v3`;
/** Ark's control plane (OpenAPI, AK/SK) of a region. */
const controlPlane = (region: Region) => `https://ark.${region}.volcengineapi.com`;

/**
 * Deployment config. Every field is org-overridable, so the platform's copy may lack the key:
 * the key is required per call (not at load), and read from the per-call `opts.config`.
 *
 * The inference key lists the models itself (`GET /api/v3/models`, live 2026-11-08). The optional
 * `management` AK/SK only adds the account's inference endpoints (`ep-…`, control-plane
 * ListEndpoints; ArkReadOnlyAccess is enough). It moves with `region` and `apiKey` as one org
 * override, so a platform AK/SK never signs a request for an org's config.
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
  management: orgAccess(
    ui(
      z
        .object({
          // secret too: a new org copy then starts without either field (the kernel removes the
          // secret leaves of a copy), not with the platform's AK and no SK
          accessKeyId: ui(secret(z.string().min(1)), {
            label: { zh: "Access Key ID", en: "Access key ID" },
          }),
          secretAccessKey: ui(secret(z.string().min(1)), {
            label: { zh: "Secret Access Key", en: "Secret access key" },
          }),
        })
        .optional(),
      {
        label: {
          zh: "管理密钥（可选，用于列出推理接入点）",
          en: "Management keys (optional, lists inference endpoints)",
        },
        advanced: true,
      },
    ),
    "override",
  ),
});

export interface ArkDefaults {
  apiKey?: string | undefined;
  region?: Region | undefined;
  management?: Management | undefined;
  /** The data plane base URL instead of the region's (tests: a fake server). Never from config. */
  baseUrl?: string | undefined;
  /** The control plane URL instead of the region's (tests: a fake server). Never from config. */
  controlPlaneUrl?: string | undefined;
  /** Warnings (an endpoint skipped, ListEndpoints failed); `ctx.log` in the extension. */
  log?: Pick<Logger, "warn"> | undefined;
  /** The signing clock (tests). */
  now?: () => Date;
}

interface Resolved {
  apiKey: string;
  baseUrl: string;
  region: Region;
  management: Management | undefined;
}

/**
 * The key and data plane of this call. The config is resolved as a whole: with a per-call config
 * (the kernel always passes the org's effective one) only its values count, so a missing key is
 * `auth` before any request and the setup key is never sent for an org; the setup defaults serve
 * only a call without one (the conformance suite).
 */
function resolve(defaults: ArkDefaults, config: unknown): Resolved {
  let apiKey: string | undefined;
  let region: Region;
  let management: Management | undefined;
  if (config === undefined) {
    apiKey = defaults.apiKey;
    region = defaults.region ?? DEFAULT_REGION;
    management = defaults.management;
  } else {
    const parsed = DeploymentConfig.safeParse(config);
    if (!parsed.success) {
      throw new ModelError("invalid_request", "Ark: the extension config is invalid");
    }
    apiKey = parsed.data.apiKey;
    region = parsed.data.region;
    management = parsed.data.management;
  }
  if (apiKey === undefined || apiKey === "") {
    throw new ModelError("auth", "Ark: no API key is configured");
  }
  return {
    apiKey,
    baseUrl: (defaults.baseUrl ?? dataPlane(region)).replace(/\/+$/, ""),
    region,
    management,
  };
}

/**
 * model-provider@2 for Volcengine Ark: the list from the data plane's `/models`, chat on its Chat
 * Completions API (the official `openai` SDK), text embeddings on `/embeddings/multimodal`. No
 * process state: everything is built per call because the key and region can differ per org.
 */
export function createArkProvider(defaults: ArkDefaults): ModelProvider {
  return {
    async listModels(opts) {
      const { apiKey, baseUrl, region, management } = resolve(defaults, opts?.config);
      const catalog = await listArkModels(baseUrl, apiKey);
      if (management === undefined) return catalog.models;
      const warn = (msg: string, fields?: Record<string, unknown>) =>
        defaults.log?.warn(msg, { ...fields, ...(opts?.orgId ? { orgId: opts.orgId } : {}) });
      try {
        const endpoints = await listEndpoints(
          defaults.controlPlaneUrl ?? controlPlane(region),
          region,
          management,
          defaults.now,
        );
        return withEndpoints(catalog, endpoints, warn);
      } catch (e) {
        // The models stay usable without the endpoints
        warn("ark: listing inference endpoints failed; listing the models only", {
          error: e instanceof Error ? e.message : String(e),
        });
        return catalog.models;
      }
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
      yield* streamChat(client, req, opts.signal, (msg, fields) => defaults.log?.warn(msg, fields));
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
  version: "0.1.0-rc.3",
  sdk: "^0.1.0-rc.4",
  provides: [MODEL_PROVIDER_EXTENSION_POINT_V2],
  // The two regions' data and control planes (display only, the platform does not intercept)
  permissions: {
    network: [
      "ark.cn-beijing.volces.com",
      "ark.cn-shanghai.volces.com",
      "ark.cn-beijing.volcengineapi.com",
      "ark.cn-shanghai.volcengineapi.com",
    ],
  },
  config: { deployment: DeploymentConfig },
  setup(ctx) {
    // Lenient: the platform's config may lack the (overridable) key
    const cfg = DeploymentConfig.safeParse(ctx.config ?? {});
    ctx.provide(
      MODEL_PROVIDER_EXTENSION_POINT_V2,
      createArkProvider({
        apiKey: cfg.success ? cfg.data.apiKey : undefined,
        region: cfg.success ? cfg.data.region : undefined,
        management: cfg.success ? cfg.data.management : undefined,
        log: ctx.log,
      }),
    );
  },
});
