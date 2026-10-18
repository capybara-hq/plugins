import {
  definePlugin,
  MODEL_PROVIDER_CAPABILITY_V2,
  ModelError,
  type ModelInfo,
  type ModelProvider,
  type ModelStreamEvent,
  secret,
} from "@capybara-hq/plugin-sdk";
import OpenAI from "openai";
import { z } from "zod";
import { DIALECTS, type Dialect, PROVIDER } from "./dialects.js";
import { streamChat } from "./map-stream.js";

const EndpointModelSchema = z.object({
  /** 端点上的原始模型 id（可含 `/`，如 vLLM 的 `Qwen/Qwen3-8B`）。 */
  id: z.string().min(1),
  contextWindow: z.number().int().positive(),
  maxOutputTokens: z.number().int().positive(),
  vision: z.boolean().optional(),
  reasoning: z.boolean().optional(),
  /** 未给时取方言默认（服务是否有自动前缀缓存）。 */
  caching: z.boolean().optional(),
  streamIdleTimeoutMs: z.number().int().positive().optional(),
});

// strictObject：密钥不在端点里（见 apiKeys），误写的 `apiKey` 直接报错，而不是被静默丢掉后发出不带凭据的请求
const EndpointSchema = z.strictObject({
  /** 端点名：对外模型 id 为 `<端点名>/<模型 id>`，所以不能含 `/`。 */
  name: z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, "endpoint name must match [A-Za-z0-9][A-Za-z0-9._-]*"),
  baseUrl: z.string().url(),
  dialect: z.enum(["generic", "deepseek", "qwen"]),
  /** 中途 system 是否以原位置的 system 消息发送；未给时取方言默认。 */
  midConversationSystem: z.boolean().optional(),
  models: z
    .array(EndpointModelSchema)
    .min(1)
    .refine((ms) => new Set(ms.map((m) => m.id)).size === ms.length, "duplicate model id"),
});

export type EndpointModelConfig = z.infer<typeof EndpointModelSchema>;
export type EndpointConfig = z.input<typeof EndpointSchema>;

/**
 * 部署级配置。密钥放在顶层的 `apiKeys`（端点名 → 密钥）：内核只认对象字段路径上的 `secret()`，
 * 标在 `endpoints[]` 数组元素里的密钥既无法打码也无法加密存储，插件会被拒绝加载。
 */
const DeploymentConfig = z
  .object({
    endpoints: z
      .array(EndpointSchema)
      .min(1)
      .refine((es) => new Set(es.map((e) => e.name)).size === es.length, "duplicate endpoint name"),
    /** 端点名 → API 密钥；没有密钥的端点（如内网 vLLM）不填，请求不带 Authorization 头。 */
    apiKeys: secret(z.record(z.string(), z.string().min(1))).default({}),
  })
  .superRefine((cfg, ctx) => {
    const names = new Set(cfg.endpoints.map((e) => e.name));
    for (const key of Object.keys(cfg.apiKeys)) {
      if (!names.has(key)) {
        ctx.addIssue({
          code: "custom",
          path: ["apiKeys", key],
          message: `apiKeys["${key}"] does not match any endpoint name`,
        });
      }
    }
  });

export interface OpenAICompatibleProviderOptions {
  endpoints: EndpointConfig[];
  /** 端点名 → API 密钥。 */
  apiKeys?: Record<string, string> | undefined;
}

interface Endpoint {
  cfg: EndpointConfig;
  dialect: Dialect;
  midConversationSystem: boolean;
  client: OpenAI;
}

function makeClient(cfg: EndpointConfig, apiKey: string | undefined): OpenAI {
  return new OpenAI({
    baseURL: cfg.baseUrl,
    // SDK 缺少凭据时会报错：无密钥的端点（如内网 vLLM）给占位值，并在下面去掉 Authorization 头
    apiKey: apiKey ?? "unused",
    // 不读取 OPENAI_ORG_ID / OPENAI_PROJECT_ID / OPENAI_ADMIN_KEY 等环境变量，避免把 OpenAI 的头发给别家服务
    organization: null,
    project: null,
    adminAPIKey: null,
    ...(apiKey === undefined ? { defaultHeaders: { Authorization: null } } : {}),
    // 重试由内核的降级梯子统一处理
    maxRetries: 0,
  });
}

function modelInfo(ep: Endpoint, m: EndpointModelConfig): ModelInfo {
  const reasoning = m.reasoning ?? false;
  return {
    id: `${ep.cfg.name}/${m.id}`,
    displayName: `${ep.cfg.name}/${m.id}`,
    contextWindow: m.contextWindow,
    maxOutputTokens: m.maxOutputTokens,
    capabilities: {
      tools: true,
      vision: m.vision ?? false,
      reasoning,
      caching: m.caching ?? ep.dialect.caching,
      midConversationSystem: ep.midConversationSystem,
    },
    ...(m.streamIdleTimeoutMs !== undefined ? { streamIdleTimeoutMs: m.streamIdleTimeoutMs } : {}),
    parameters: ep.dialect.parameters({ reasoning, maxOutputTokens: m.maxOutputTokens }),
  };
}

/**
 * 基于官方 `openai` SDK 的 `chat.completions` 的 model-provider@2 实现：每个端点一个客户端（构造后不变），
 * 无进程内可变状态。
 */
export function createOpenAICompatibleProvider(
  opts: OpenAICompatibleProviderOptions,
): ModelProvider {
  const endpoints: Endpoint[] = opts.endpoints.map((cfg) => {
    const dialect = DIALECTS[cfg.dialect];
    return {
      cfg,
      dialect,
      midConversationSystem: cfg.midConversationSystem ?? dialect.midConversationSystem,
      client: makeClient(cfg, opts.apiKeys?.[cfg.name]),
    };
  });

  return {
    listModels: async () => endpoints.flatMap((ep) => ep.cfg.models.map((m) => modelInfo(ep, m))),
    async *stream(req, { signal }): AsyncGenerator<ModelStreamEvent> {
      const slash = req.model.indexOf("/");
      const ep =
        slash < 0 ? undefined : endpoints.find((e) => e.cfg.name === req.model.slice(0, slash));
      const upstreamModel = req.model.slice(slash + 1);
      const m = ep?.cfg.models.find((x) => x.id === upstreamModel);
      if (ep === undefined || m === undefined) {
        throw new ModelError("invalid_request", `Model "${req.model}" is not configured`);
      }
      yield* streamChat(ep.client, req, {
        signal,
        target: {
          upstreamModel,
          dialect: ep.dialect,
          midConversationSystem: ep.midConversationSystem,
        },
      });
    },
  };
}

/** OpenAI 兼容（Chat Completions）供应商插件：vLLM、DeepSeek、Qwen 等，方言差异只在本插件内。 */
export default definePlugin({
  name: PROVIDER,
  version: "0.1.0",
  sdk: "^0.1.0",
  provides: [MODEL_PROVIDER_CAPABILITY_V2],
  config: { deployment: DeploymentConfig },
  setup(ctx) {
    const cfg = DeploymentConfig.parse(ctx.config ?? {});
    ctx.provide(MODEL_PROVIDER_CAPABILITY_V2, createOpenAICompatibleProvider(cfg));
  },
});
