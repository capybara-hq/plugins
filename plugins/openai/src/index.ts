import {
  definePlugin,
  MODEL_PROVIDER_CAPABILITY,
  ModelError,
  type ModelInfoV1,
  type ModelProviderV1,
  type ModelStreamEvent,
  secret,
} from "@capybara-hq/plugin-sdk";
import OpenAI from "openai";
import { z } from "zod";
import { streamResponses } from "./map-stream.js";

const ModelConfigSchema = z.object({
  id: z.string().min(1),
  contextWindow: z.number().int().positive(),
  maxOutputTokens: z.number().int().positive(),
  reasoning: z.boolean(),
  vision: z.boolean(),
  streamIdleTimeoutMs: z.number().int().positive().optional(),
});

export type ModelConfig = z.infer<typeof ModelConfigSchema>;

export interface OpenAIProviderOptions {
  apiKey: string;
  baseUrl?: string | undefined;
  organization?: string | undefined;
  /** 至少 1 个；listModels 直接由它生成。 */
  models: ModelConfig[];
  /** "off" 时不请求推理摘要；默认 "auto"。 */
  reasoningSummary?: "auto" | "off" | undefined;
}

function modelInfo(m: ModelConfig): ModelInfoV1 {
  return {
    id: m.id,
    displayName: m.id,
    contextWindow: m.contextWindow,
    maxOutputTokens: m.maxOutputTokens,
    capabilities: {
      tools: true,
      vision: m.vision,
      reasoning: m.reasoning,
      // 前缀缓存是自动的
      caching: true,
      // 中途 system 以 developer 输入项实现
      midConversationSystem: true,
      effort: m.reasoning,
    },
    ...(m.streamIdleTimeoutMs !== undefined ? { streamIdleTimeoutMs: m.streamIdleTimeoutMs } : {}),
  };
}

/** 基于官方 SDK 与原生 Responses API 的 model-provider@1 实现。无进程内可变状态。 */
export function createOpenAIProvider(opts: OpenAIProviderOptions): ModelProviderV1 {
  const client = new OpenAI({
    apiKey: opts.apiKey,
    ...(opts.baseUrl !== undefined ? { baseURL: opts.baseUrl } : {}),
    ...(opts.organization !== undefined ? { organization: opts.organization } : {}),
    // 重试由内核的降级梯子统一处理
    maxRetries: 0,
  });
  const models = opts.models;
  const reasoningSummary = opts.reasoningSummary ?? "auto";

  return {
    listModels: async () => models.map(modelInfo),
    async *stream(req, { signal }): AsyncGenerator<ModelStreamEvent> {
      const m = models.find((x) => x.id === req.model);
      if (m === undefined) {
        throw new ModelError("invalid_request", `Model "${req.model}" is not configured`);
      }
      yield* streamResponses(client, req, {
        signal,
        traits: { reasoning: m.reasoning, reasoningSummary },
      });
    },
  };
}

/** 部署级配置。 */
const DeploymentConfig = z.object({
  apiKey: secret(z.string().min(1)),
  baseUrl: z.string().url().optional(),
  organization: z.string().min(1).optional(),
  models: z.array(ModelConfigSchema).min(1),
  /** 推理摘要："off" 时不发 reasoning.summary（未完成组织验证的账号请求摘要会被拒绝）。 */
  reasoningSummary: z.enum(["auto", "off"]).default("auto"),
});

/** OpenAI 供应商插件：官方 SDK + 原生 Responses API。 */
export default definePlugin({
  name: "openai",
  version: "0.1.0",
  sdk: "^0.1.0",
  provides: [MODEL_PROVIDER_CAPABILITY],
  config: { deployment: DeploymentConfig },
  setup(ctx) {
    const cfg = DeploymentConfig.parse(ctx.config ?? {});
    ctx.provide(
      MODEL_PROVIDER_CAPABILITY,
      createOpenAIProvider({
        apiKey: cfg.apiKey,
        baseUrl: cfg.baseUrl,
        organization: cfg.organization,
        models: cfg.models,
        reasoningSummary: cfg.reasoningSummary,
      }),
    );
  },
});
