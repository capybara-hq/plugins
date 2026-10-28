import {
  defineExtension,
  EFFORT_VALUES,
  type Effort,
  MODEL_PROVIDER_EXTENSION_POINT_V2,
  ModelError,
  type ModelInfo,
  type ModelParameter,
  type ModelProvider,
  type ModelStreamEvent,
  secret,
} from "@capybara-hq/plugin-sdk";
import OpenAI from "openai";
import { z } from "zod";
import { streamResponses } from "./map-stream.js";

const EffortLevel = z.enum(EFFORT_VALUES as [Effort, ...Effort[]], {
  error: `effort level must be one of ${EFFORT_VALUES.join(", ")}`,
});

const ModelConfigSchema = z.object({
  id: z.string().min(1),
  contextWindow: z.number().int().positive(),
  maxOutputTokens: z.number().int().positive(),
  reasoning: z.boolean(),
  vision: z.boolean(),
  /**
   * 是否接受 PDF（`input_file`）。缺省 false：由部署按模型开启。文档未列出逐模型清单，PDF 的页面图像需要
   * 支持视觉的模型（gpt-4o 及以后；https://developers.openai.com/api/docs/guides/pdf-files ，2026-10-21 核实）。
   */
  documents: z.boolean().optional(),
  streamIdleTimeoutMs: z.number().int().positive().optional(),
  /**
   * 该模型接受的 effort 档位（按给定顺序声明）；档位因模型而异（如 gpt-5-nano 不接受 max），
   * 未给时用 low / medium / high。
   */
  effortLevels: z.array(EffortLevel).min(1).optional(),
});

export type ModelConfig = z.infer<typeof ModelConfigSchema>;

export interface OpenAIProviderOptions {
  apiKey: string;
  baseUrl?: string | undefined;
  organization?: string | undefined;
  /** 至少 1 个；listModels 直接由它生成。 */
  models: ModelConfig[];
  /** 部署级默认值："off" 时不请求推理摘要；默认 "auto"。agent 的 thinking 参数可覆盖。 */
  reasoningSummary?: "auto" | "off" | undefined;
}

/**
 * 推理模型声明的参数（非推理模型为空）：
 * - `effort`：档位取模型配置的 `effortLevels`（未给时 low / medium / high），原样映射为 `reasoning.effort`；
 *   不给默认值（API 默认值因模型而异），未设置时不发送；
 * - `thinking`：`on|summarized`，映射为是否带 `reasoning.summary`；不给默认值，未设置时请求摘要
 *   （部署默认）。部署配置 `reasoningSummary` 为 "off" 时不声明：未完成组织验证的账号请求摘要会被拒绝（不可重试），
 *   不能让 agent 选到。
 */
function reasoningParameters(m: ModelConfig, reasoningSummary: "auto" | "off"): ModelParameter[] {
  const effort: ModelParameter = {
    key: "effort",
    standard: "effort",
    // 未配置时用 low / medium / high：所有 OpenAI 推理模型都接受
    schema: { type: "string", enum: [...(m.effortLevels ?? ["low", "medium", "high"])] },
    label: { zh: "思考深度", en: "Effort" },
    description: {
      zh: "越高思考越充分，耗时与用量越多；未设置时用模型默认值",
      en: "Higher means more thorough reasoning, more time and tokens; unset uses the model default",
    },
  };
  if (reasoningSummary === "off") return [effort];
  return [
    effort,
    {
      key: "thinking",
      standard: "thinking",
      schema: { type: "string", enum: ["on", "summarized"] },
      label: { zh: "思考模式", en: "Thinking" },
      description: {
        zh: "summarized 返回推理摘要供界面展示，on 不返回；未设置时返回",
        en: "summarized streams a reasoning summary, on does not; unset streams it",
      },
    },
  ];
}

function modelInfo(m: ModelConfig, reasoningSummary: "auto" | "off"): ModelInfo {
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
      documents: m.documents ?? false,
    },
    ...(m.streamIdleTimeoutMs !== undefined ? { streamIdleTimeoutMs: m.streamIdleTimeoutMs } : {}),
    parameters: m.reasoning ? reasoningParameters(m, reasoningSummary) : [],
  };
}

/** 基于官方 SDK 与原生 Responses API 的 model-provider@2 实现。无进程内可变状态。 */
export function createOpenAIProvider(opts: OpenAIProviderOptions): ModelProvider {
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
    listModels: async () => models.map((m) => modelInfo(m, reasoningSummary)),
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
  /**
   * 推理摘要的部署级默认值："off" 时不发 reasoning.summary（未完成组织验证的账号请求摘要会被拒绝）。
   * agent 设置了 thinking 参数时以参数为准。
   */
  reasoningSummary: z.enum(["auto", "off"]).default("auto"),
});

/** OpenAI 供应商插件：官方 SDK + 原生 Responses API。 */
export default defineExtension({
  name: "openai",
  version: "0.1.0-rc.0",
  sdk: "^0.1.0",
  provides: [MODEL_PROVIDER_EXTENSION_POINT_V2],
  // 默认端点；部署配置 baseUrl 可改指向代理（只展示，平台不拦截）
  permissions: { network: ["api.openai.com"] },
  config: { deployment: DeploymentConfig },
  setup(ctx) {
    const cfg = DeploymentConfig.parse(ctx.config ?? {});
    ctx.provide(
      MODEL_PROVIDER_EXTENSION_POINT_V2,
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
