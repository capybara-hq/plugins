import Anthropic from "@anthropic-ai/sdk";
import {
  definePlugin,
  MODEL_PROVIDER_CAPABILITY,
  type ModelInfo,
  type ModelProvider,
  secret,
} from "@capybara-hq/plugin-sdk";
import { z } from "zod";
import { toModelError } from "./errors.js";
import { type ServerFallbacks, supportsMidConversationSystem } from "./map-request.js";
import { streamMessages } from "./map-stream.js";

/** 插件用到的 ctx.kv 子集。 */
export interface Kv {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, opts: { ttlSeconds: number }): Promise<void>;
}

export interface AnthropicProviderOptions {
  kv: Kv;
  apiKey: string;
  baseUrl?: string | undefined;
  /** 允许的模型 id。 */
  models: string[];
  serverFallbacks: ServerFallbacks;
}

const MODEL_CACHE_TTL_SECONDS = 3600;
/** 思考阶段可能长时间不发事件。 */
const STREAM_IDLE_TIMEOUT_MS = 300_000;
const FALLBACK_CONTEXT_WINDOW = 200_000;
const FALLBACK_MAX_OUTPUT = 32_000;

function mapModelInfo(m: Anthropic.ModelInfo): ModelInfo {
  const caps = m.capabilities;
  return {
    id: m.id,
    displayName: m.display_name,
    contextWindow: m.max_input_tokens ?? FALLBACK_CONTEXT_WINDOW,
    maxOutputTokens: m.max_tokens ?? FALLBACK_MAX_OUTPUT,
    capabilities: {
      tools: true,
      vision: caps?.image_input?.supported === true,
      reasoning: caps?.thinking?.supported === true,
      caching: true,
      midConversationSystem: supportsMidConversationSystem(m.id),
      effort: true,
    },
    streamIdleTimeoutMs: STREAM_IDLE_TIMEOUT_MS,
  };
}

/** 基于官方 SDK 与原生 Messages API 的 model-provider@1 实现。无进程内状态：模型信息缓存在 kv。 */
export function createAnthropicProvider(opts: AnthropicProviderOptions): ModelProvider {
  const client = new Anthropic({
    apiKey: opts.apiKey,
    ...(opts.baseUrl !== undefined ? { baseURL: opts.baseUrl } : {}),
    // 重试由内核的降级梯子统一处理
    maxRetries: 0,
  });

  async function getModel(id: string): Promise<ModelInfo> {
    const key = `models:${id}`;
    const cached = await opts.kv.get(key);
    if (cached !== null) return JSON.parse(cached) as ModelInfo;
    let info: ModelInfo;
    try {
      info = mapModelInfo(await client.models.retrieve(id));
    } catch (e) {
      throw toModelError(e);
    }
    await opts.kv.set(key, JSON.stringify(info), { ttlSeconds: MODEL_CACHE_TTL_SECONDS });
    return info;
  }

  return {
    listModels: () => Promise.all(opts.models.map(getModel)),
    stream: (req, { signal }) =>
      streamMessages(client, req, { signal, serverFallbacks: opts.serverFallbacks }),
  };
}

/** 部署级配置。 */
const DeploymentConfig = z.object({
  apiKey: secret(z.string().min(1)),
  baseUrl: z.string().url().optional(),
  models: z
    .array(z.string().min(1))
    .default(["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"]),
  serverFallbacks: z.enum(["default", "off"]).default("default"),
});

/** Anthropic 供应商插件：官方 SDK + 原生 Messages API（不经 OpenAI 兼容层）。 */
export default definePlugin({
  name: "anthropic",
  version: "0.1.0",
  sdk: "^0.1.0",
  provides: [MODEL_PROVIDER_CAPABILITY],
  config: { deployment: DeploymentConfig },
  setup(ctx) {
    const cfg = DeploymentConfig.parse(ctx.config ?? {});
    ctx.provide(
      MODEL_PROVIDER_CAPABILITY,
      createAnthropicProvider({
        kv: ctx.kv,
        apiKey: cfg.apiKey,
        baseUrl: cfg.baseUrl,
        models: cfg.models,
        serverFallbacks: cfg.serverFallbacks,
      }),
    );
  },
});
