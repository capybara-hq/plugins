import {
  configUrlFetch,
  defineExtension,
  type ExtensionNet,
  type Logger,
  MODEL_PROVIDER_EXTENSION_POINT_V2,
  ModelError,
  type ModelProvider,
  secret,
  ui,
} from "@capybara-hq/plugin-sdk";
import type OpenAI from "openai";
import { z } from "zod";
import { toModelError } from "./errors.js";
import { listDeepSeekModels } from "./list.js";
import { streamChat } from "./map-stream.js";
import { isolatedOpenAI } from "./openai-client.js";

const DEFAULT_BASE_URL = "https://api.deepseek.com";

/**
 * Deployment config. Both fields are overridable by an org (the default).
 * The key is required, so a deployment without one shows the provider as needing configuration
 * rather than as failing to list its models. The platform may leave it empty (the kernel's load
 * gate makes required overridable fields optional for the platform's copy): orgs following the
 * platform then need configuration and are never called, and an org copy brings its own key.
 */
const DeploymentConfig = z.object({
  apiKey: ui(secret(z.string().min(1)), { label: { zh: "API 密钥", en: "API key" } }),
  baseUrl: ui(z.string().url().default(DEFAULT_BASE_URL), {
    label: { zh: "接口地址", en: "API URL" },
  }),
});

/** A call's config: the key may be absent (left to the orgs), `auth` before any request. */
const CallConfig = DeploymentConfig.partial({ apiKey: true });

/** `ctx.net.fetch`: the kernel's guarded client. */
export type NetFetch = ExtensionNet["fetch"];

export interface DeepSeekDefaults {
  apiKey?: string | undefined;
  baseUrl?: string | undefined;
  /** Warnings (a malformed list entry skipped); `ctx.log` in the extension. */
  log?: Pick<Logger, "warn"> | undefined;
  /**
   * The guarded fetch an org's own base URL goes through (`ctx.net.fetch`, with the org's id), so
   * an org admin cannot point the provider at an internal address the super admin did not allow
   * for the org. Unit tests inject one.
   */
  netFetch: NetFetch;
  /**
   * The platform's base URL at the time of the call (`ctx.config` read when used); defaults to
   * `baseUrl`. A per-call `baseUrl` equal to it is the platform's (set by the super admin) and
   * keeps the global `fetch`.
   */
  platformBaseUrl?: (() => string | undefined) | undefined;
}

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

interface Resolved {
  apiKey: string;
  baseUrl: string;
  /** The global `fetch` for the platform's base URL, `ctx.net.fetch` for an org's own one. */
  fetch: FetchLike;
}

/**
 * The key, endpoint and fetch of this call: the org's effective config (`opts.config`) when given,
 * else the defaults the provider was built with. No key anywhere is `auth`, before any request.
 */
function resolve(
  defaults: DeepSeekDefaults,
  opts: { config?: unknown; orgId?: string } | undefined,
): Resolved {
  const config = opts?.config;
  // The setup defaults serve only a call without a per-call config. An org's copy comes without the
  // platform's secrets: mixing the two would send the platform key to the org's endpoint.
  if (config === undefined) {
    if (defaults.apiKey === undefined || defaults.apiKey === "") {
      throw new ModelError("auth", "DeepSeek: no API key is configured");
    }
    return {
      apiKey: defaults.apiKey,
      baseUrl: defaults.baseUrl ?? DEFAULT_BASE_URL,
      fetch: (url, init) => fetch(url, init),
    };
  }
  const parsed = CallConfig.safeParse(config);
  if (!parsed.success) {
    throw new ModelError("invalid_request", "DeepSeek: the extension config is invalid");
  }
  const { apiKey, baseUrl } = parsed.data;
  if (apiKey === undefined || apiKey === "") {
    throw new ModelError("auth", "DeepSeek: no API key is configured");
  }
  // The platform's base URL keeps the global fetch; an org's own one goes through the kernel's
  // network rules for that org (`ctx.net.fetch`).
  const platform = (defaults.platformBaseUrl ?? (() => defaults.baseUrl))() ?? DEFAULT_BASE_URL;
  const guarded = configUrlFetch(
    { fetch: defaults.netFetch },
    { url: baseUrl, platform, orgId: opts?.orgId },
  );
  return { apiKey, baseUrl, fetch: (url, init) => guarded(url, init) };
}

/** The OpenAI SDK's fetch signature over a resolved fetch. */
const sdkFetch =
  (f: FetchLike) =>
  (input: string | URL | Request, init?: RequestInit): Promise<Response> =>
    f(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
      init ?? {},
    );

/**
 * model-provider@2 for DeepSeek on the official `openai` SDK's Chat Completions. No process state:
 * the client is built per call because the key and endpoint can differ per organization.
 */
export function createDeepSeekProvider(defaults: DeepSeekDefaults): ModelProvider {
  return {
    async listModels(opts) {
      const { apiKey, baseUrl, fetch: f } = resolve(defaults, opts);
      return listDeepSeekModels(baseUrl, apiKey, defaults.log, f);
    },
    async *stream(req, opts) {
      let client: OpenAI;
      try {
        const { apiKey, baseUrl, fetch: f } = resolve(defaults, opts);
        // No OPENAI_* env var is read (isolatedOpenAI): never send a host value to another service
        client = isolatedOpenAI({
          baseURL: baseUrl,
          apiKey,
          fetch: sdkFetch(f),
          // Retries belong to the kernel's degradation ladder
          maxRetries: 0,
        });
      } catch (e) {
        throw toModelError(e, opts.signal);
      }
      yield* streamChat(client, req, opts.signal);
    },
  };
}

/** DeepSeek model provider plugin: native Chat Completions, thinking mode, `/models` listing. */
export default defineExtension({
  name: "deepseek",
  version: "0.1.0-rc.14",
  sdk: "^0.1.0-rc.64",
  provides: [MODEL_PROVIDER_EXTENSION_POINT_V2],
  // Default host; a changed baseUrl is display-only here, the platform does not intercept
  permissions: { network: ["api.deepseek.com"] },
  config: { deployment: DeploymentConfig },
  setup(ctx) {
    // Lenient: the platform's config may lack the (overridable) key
    const cfg = CallConfig.safeParse(ctx.config ?? {});
    ctx.provide(
      MODEL_PROVIDER_EXTENSION_POINT_V2,
      createDeepSeekProvider({
        apiKey: cfg.success ? cfg.data.apiKey : undefined,
        baseUrl: cfg.success ? cfg.data.baseUrl : undefined,
        log: ctx.log,
        netFetch: (url, init, opts) => ctx.net.fetch(url, init, opts),
        // ctx.config is read when used: a hot platform change applies at once
        platformBaseUrl: () => {
          const now = CallConfig.safeParse(ctx.config ?? {});
          return now.success ? now.data.baseUrl : undefined;
        },
      }),
    );
  },
});
