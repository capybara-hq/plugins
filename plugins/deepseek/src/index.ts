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
import { toModelError } from "./errors.js";
import { listDeepSeekModels } from "./list.js";
import { streamChat } from "./map-stream.js";

const DEFAULT_BASE_URL = "https://api.deepseek.com";

/**
 * Deployment config. Both fields are org-overridable, so the platform's copy may lack the key:
 * the key is required per call (not at load), and read from the per-call `opts.config`.
 */
const DeploymentConfig = z.object({
  apiKey: orgAccess(
    ui(secret(z.string().min(1).optional()), { label: { zh: "API 密钥", en: "API key" } }),
    "override",
  ),
  baseUrl: orgAccess(
    ui(z.string().url().default(DEFAULT_BASE_URL), {
      label: { zh: "接口地址", en: "API URL" },
    }),
    "override",
  ),
});

export interface DeepSeekDefaults {
  apiKey?: string | undefined;
  baseUrl?: string | undefined;
  /** Warnings (a malformed list entry skipped); `ctx.log` in the extension. */
  log?: Pick<Logger, "warn"> | undefined;
}

/**
 * The key and endpoint of this call: the org's effective config (`opts.config`) when given, else
 * the defaults the provider was built with. No key anywhere is `auth`, before any request.
 */
function resolve(defaults: DeepSeekDefaults, config: unknown): { apiKey: string; baseUrl: string } {
  // The setup defaults serve only a call without a per-call config. An org's copy comes without the
  // platform's secrets: mixing the two would send the platform key to the org's endpoint.
  if (config === undefined) {
    if (defaults.apiKey === undefined || defaults.apiKey === "") {
      throw new ModelError("auth", "DeepSeek: no API key is configured");
    }
    return { apiKey: defaults.apiKey, baseUrl: defaults.baseUrl ?? DEFAULT_BASE_URL };
  }
  const parsed = DeploymentConfig.safeParse(config);
  if (!parsed.success) {
    throw new ModelError("invalid_request", "DeepSeek: the extension config is invalid");
  }
  const { apiKey, baseUrl } = parsed.data;
  if (apiKey === undefined || apiKey === "") {
    throw new ModelError("auth", "DeepSeek: no API key is configured");
  }
  return { apiKey, baseUrl };
}

/**
 * model-provider@2 for DeepSeek on the official `openai` SDK's Chat Completions. No process state:
 * the client is built per call because the key and endpoint can differ per organization.
 */
export function createDeepSeekProvider(defaults: DeepSeekDefaults): ModelProvider {
  return {
    async listModels(opts) {
      const { apiKey, baseUrl } = resolve(defaults, opts?.config);
      return listDeepSeekModels(baseUrl, apiKey, defaults.log);
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
  };
}

/** DeepSeek model provider plugin: native Chat Completions, thinking mode, `/models` listing. */
export default defineExtension({
  name: "deepseek",
  version: "0.1.0-rc.0",
  sdk: "^0.1.0-rc.4",
  provides: [MODEL_PROVIDER_EXTENSION_POINT_V2],
  // Default host; a changed baseUrl is display-only here, the platform does not intercept
  permissions: { network: ["api.deepseek.com"] },
  config: { deployment: DeploymentConfig },
  setup(ctx) {
    // Lenient: the platform's config may lack the (overridable) key
    const cfg = DeploymentConfig.safeParse(ctx.config ?? {});
    ctx.provide(
      MODEL_PROVIDER_EXTENSION_POINT_V2,
      createDeepSeekProvider({
        apiKey: cfg.success ? cfg.data.apiKey : undefined,
        baseUrl: cfg.success ? cfg.data.baseUrl : undefined,
        log: ctx.log,
      }),
    );
  },
});
