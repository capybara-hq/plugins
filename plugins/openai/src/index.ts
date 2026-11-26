import {
  configUrlFetch,
  defineExtension,
  EFFORT_VALUES,
  type Effort,
  type ExtensionNet,
  MODEL_PROVIDER_EXTENSION_POINT_V2,
  ModelError,
  type ModelInfo,
  type ModelParameter,
  type ModelProvider,
  type ModelStreamEvent,
  secret,
  ui,
} from "@capybara-hq/plugin-sdk";
import type OpenAI from "openai";
import { z } from "zod";
import { generateOpenAIImage, imageModelInfo, KNOWN_IMAGE_MODEL_IDS } from "./image.js";
import { streamResponses } from "./map-stream.js";
import { isolatedOpenAI } from "./openai-client.js";

const DEFAULT_BASE_URL = "https://api.openai.com/v1";

/** `ctx.net.fetch`: the kernel's guarded client. */
export type NetFetch = ExtensionNet["fetch"];

const EffortLevel = z.enum(EFFORT_VALUES as [Effort, ...Effort[]], {
  error: `effort level must be one of ${EFFORT_VALUES.join(", ")}`,
});

const ModelConfigSchema = z.object({
  id: ui(z.string().min(1), { label: { zh: "模型 ID", en: "Model ID" } }),
  contextWindow: ui(z.number().int().positive(), {
    label: { zh: "上下文窗口", en: "Context window" },
  }),
  maxOutputTokens: ui(z.number().int().positive(), {
    label: { zh: "最大输出", en: "Max output tokens" },
  }),
  reasoning: ui(z.boolean(), { label: { zh: "推理", en: "Reasoning" } }),
  vision: ui(z.boolean(), { label: { zh: "图片输入", en: "Image input" } }),
  /**
   * 是否接受 PDF（`input_file`）。缺省 false：由部署按模型开启。文档未列出逐模型清单，PDF 的页面图像需要
   * 支持视觉的模型（gpt-4o 及以后；https://developers.openai.com/api/docs/guides/pdf-files ，2026-10-21 核实）。
   */
  documents: ui(z.boolean().optional(), { label: { zh: "PDF 输入", en: "PDF input" } }),
  streamIdleTimeoutMs: ui(z.number().int().positive().optional(), {
    label: { zh: "流空闲超时", en: "Stream idle timeout" },
  }),
  /**
   * 该模型接受的 effort 档位（按给定顺序声明）；档位因模型而异（如 gpt-5-nano 不接受 max），
   * 未给时用 low / medium / high。
   */
  effortLevels: ui(z.array(EffortLevel).min(1).optional(), {
    label: { zh: "思考深度档位", en: "Effort levels" },
  }),
});

export type ModelConfig = z.infer<typeof ModelConfigSchema>;

export interface OpenAIProviderOptions {
  /**
   * Defaults for a call made without a per-call config (a conformance run); an org's call carries
   * its whole effective config and never mixes these in.
   */
  apiKey?: string | undefined;
  baseUrl?: string | undefined;
  organization?: string | undefined;
  /** listModels is generated from it. */
  models?: ModelConfig[] | undefined;
  /** 部署级默认值："off" 时不请求推理摘要；默认 "auto"。agent 的 thinking 参数可覆盖。 */
  reasoningSummary?: "auto" | "off" | undefined;
  /**
   * Image generation model ids; ids without facts in the plugin's table are ignored with one
   * warning. None by default.
   */
  imageModels?: string[] | undefined;
  /** Receives the warning about ignored image model ids. */
  log?: { warn(message: string): void } | undefined;
  /**
   * The guarded fetch an org's own base URL goes through (`ctx.net.fetch`), so an org admin cannot
   * point the provider at an internal address the super admin did not allow for the org.
   */
  netFetch: NetFetch;
  /**
   * The platform's base URL at the time of the call (`ctx.config` read when used); defaults to
   * `baseUrl`. A per-call `baseUrl` equal to it is the platform's and keeps the global `fetch`.
   */
  platformBaseUrl?: (() => string | undefined) | undefined;
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

interface Resolved {
  client: OpenAI;
  models: ModelConfig[];
  reasoningSummary: "auto" | "off";
  imageModels: string[];
}

/**
 * 基于官方 SDK 与原生 Responses API 的 model-provider@2 实现。无进程内可变状态：key、端点与模型表
 * 可因组织而异，客户端按调用构造。
 */
export function createOpenAIProvider(opts: OpenAIProviderOptions): ModelProvider {
  /** The key, endpoint, models and client of this call: the org's whole effective config. */
  function resolve(call: { config?: unknown; orgId?: string } | undefined): Resolved {
    let cfg: CallConfigValue;
    if (call?.config === undefined) {
      // The setup defaults serve only a call without a per-call config
      cfg = {
        apiKey: opts.apiKey,
        baseUrl: opts.baseUrl,
        organization: opts.organization,
        models: opts.models,
        reasoningSummary: opts.reasoningSummary ?? "auto",
        imageModels: opts.imageModels,
      };
    } else {
      const parsed = CallConfig.safeParse(call.config);
      if (!parsed.success) {
        throw new ModelError("invalid_request", "OpenAI: the extension config is invalid");
      }
      cfg = parsed.data;
    }
    if (cfg.apiKey === undefined || cfg.apiKey === "") {
      throw new ModelError("auth", "OpenAI: no API key is configured");
    }
    const baseURL = cfg.baseUrl ?? DEFAULT_BASE_URL;
    const platform = (opts.platformBaseUrl ?? (() => opts.baseUrl))();
    // No OPENAI_* env var is read (isolatedOpenAI): an organization header only when configured
    const client = isolatedOpenAI({
      apiKey: cfg.apiKey,
      baseURL,
      organization: cfg.organization ?? null,
      // The platform's endpoint keeps the global fetch, an org's own one is guarded
      fetch: configUrlFetch(
        { fetch: opts.netFetch },
        {
          url: cfg.baseUrl ?? DEFAULT_BASE_URL,
          platform: platform === undefined ? DEFAULT_BASE_URL : [platform, DEFAULT_BASE_URL],
          orgId: call?.orgId,
        },
      ),
      // 重试由内核的降级梯子统一处理
      maxRetries: 0,
    });
    const configuredImageModels = cfg.imageModels ?? [];
    // An id without facts (a retired or misspelled model) is skipped, never a broken provider
    const unknown = configuredImageModels.filter((id) => !KNOWN_IMAGE_MODEL_IDS.includes(id));
    if (unknown.length > 0) {
      opts.log?.warn(
        `openai: ignoring unknown image model(s) ${unknown.join(", ")}; known: ${KNOWN_IMAGE_MODEL_IDS.join(", ")}`,
      );
    }
    return {
      client,
      models: cfg.models ?? [],
      reasoningSummary: cfg.reasoningSummary ?? "auto",
      imageModels: configuredImageModels.filter((id) => KNOWN_IMAGE_MODEL_IDS.includes(id)),
    };
  }

  return {
    listModels: async (call) => {
      const { models, reasoningSummary, imageModels } = resolve(call);
      return [
        ...models.map((m) => modelInfo(m, reasoningSummary)),
        ...imageModels.map((id) => imageModelInfo(id)),
      ];
    },
    async generateImage(req, call) {
      const { client, imageModels } = resolve(call);
      if (!imageModels.includes(req.model)) {
        throw new ModelError("invalid_request", `Image model "${req.model}" is not configured`);
      }
      return generateOpenAIImage(client, req, call.signal);
    },
    async *stream(req, call): AsyncGenerator<ModelStreamEvent> {
      const { client, models, reasoningSummary } = resolve(call);
      const m = models.find((x) => x.id === req.model);
      if (m === undefined) {
        throw new ModelError("invalid_request", `Model "${req.model}" is not configured`);
      }
      yield* streamResponses(client, req, {
        signal: call.signal,
        traits: { reasoning: m.reasoning, reasoningSummary },
      });
    },
  };
}

/** 部署级配置。Every field is org-overridable. */
const DeploymentConfig = z.object({
  apiKey: ui(secret(z.string().min(1)), { label: { zh: "API 密钥", en: "API key" } }),
  baseUrl: ui(z.string().url().optional(), { label: { zh: "接口地址", en: "API URL" } }),
  organization: ui(z.string().min(1).optional(), { label: { zh: "组织 ID", en: "Organization" } }),
  models: ui(z.array(ModelConfigSchema).min(1), { label: { zh: "模型", en: "Models" } }),
  /**
   * 推理摘要的部署级默认值："off" 时不发 reasoning.summary（未完成组织验证的账号请求摘要会被拒绝）。
   * agent 设置了 thinking 参数时以参数为准。
   */
  reasoningSummary: ui(z.enum(["auto", "off"]).default("auto"), {
    label: { zh: "推理摘要", en: "Reasoning summary" },
  }),
  /**
   * Image generation model ids to offer. Any string is accepted (a retired id never breaks the
   * config); ids without facts in the plugin's table are ignored with a warning.
   */
  imageModels: ui(z.array(z.string().min(1)).optional(), {
    label: { zh: "图像生成模型", en: "Image generation models" },
  }),
});

/** A call's config: the platform may leave the key and models to the orgs. */
const CallConfig = DeploymentConfig.partial({ apiKey: true, models: true });
type CallConfigValue = Partial<z.infer<typeof CallConfig>>;

/** OpenAI 供应商插件：官方 SDK + 原生 Responses API。 */
export default defineExtension({
  name: "openai",
  version: "0.1.0-rc.13",
  sdk: "^0.1.0-rc.64",
  provides: [MODEL_PROVIDER_EXTENSION_POINT_V2],
  // 默认端点；部署配置 baseUrl 可改指向代理（只展示，平台不拦截）
  permissions: { network: ["api.openai.com"] },
  config: { deployment: DeploymentConfig },
  setup(ctx) {
    // Lenient: the platform may leave the overridable key and models empty
    const cfg = CallConfig.safeParse(ctx.config ?? {});
    const d = cfg.success ? cfg.data : undefined;
    ctx.provide(
      MODEL_PROVIDER_EXTENSION_POINT_V2,
      createOpenAIProvider({
        apiKey: d?.apiKey,
        baseUrl: d?.baseUrl,
        organization: d?.organization,
        models: d?.models,
        reasoningSummary: d?.reasoningSummary,
        imageModels: d?.imageModels,
        log: ctx.log,
        netFetch: (url, init, o) => ctx.net.fetch(url, init, o),
        // ctx.config is read when used: a hot platform change applies at once
        platformBaseUrl: () => {
          const now = CallConfig.safeParse(ctx.config ?? {});
          return now.success ? now.data.baseUrl : undefined;
        },
      }),
    );
  },
});
