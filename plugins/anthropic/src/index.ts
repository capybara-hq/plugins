import Anthropic from "@anthropic-ai/sdk";
import {
  definePlugin,
  EFFORT_VALUES,
  type Effort,
  type Logger,
  MODEL_PROVIDER_CAPABILITY_V2,
  type ModelError,
  type ModelInfo,
  type ModelParameter,
  type ModelProvider,
  type ModelRequest,
  type ModelStreamEvent,
  secret,
} from "@capybara-hq/plugin-sdk";
import { z } from "zod";
import { toModelError } from "./errors.js";
import type { ServerFallbacks } from "./map-request.js";
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
  /** listModels 跳过取不到的模型时记 warn。 */
  log?: Pick<Logger, "warn"> | undefined;
}

const MODEL_CACHE_TTL_SECONDS = 3600;
/**
 * kv 里模型信息缓存的键。缓存的是映射后的 ModelInfo，形状随契约变化，所以键带契约主版本：
 * 升级后不会读到旧版本写入的 `@1` 形状（旧键按 TTL 自然过期）。
 */
const modelCacheKey = (id: string) => `models:v2:${id}`;
/** 思考阶段可能长时间不发事件。 */
const STREAM_IDLE_TIMEOUT_MS = 300_000;
const FALLBACK_CONTEXT_WINDOW = 200_000;
const FALLBACK_MAX_OUTPUT = 32_000;

/**
 * effort 档位：取 Models API 中逐档的 `supported`；只要出现任一档的字段（含显式 null）就按逐档信息处理，
 * 各档字段都缺失时才用五档。不支持 effort（或一档都不支持）时返回 null。
 */
function effortLevels(e: Anthropic.EffortCapability | undefined): Effort[] | null {
  if (e?.supported !== true) return null;
  if (!EFFORT_VALUES.some((v) => v in e)) return [...EFFORT_VALUES];
  const levels = EFFORT_VALUES.filter((v) => e[v]?.supported === true);
  return levels.length > 0 ? levels : null;
}

/**
 * 模型声明的参数（不声明 temperature：当前模型不接受非默认值）：
 * - `effort`：仅在 Models API 的 `effort.supported` 为真时声明；默认 high（即 API 自身的默认值），
 *   high 不在档位里时不给默认值；
 * - `thinking`：仅在支持 adaptive 思考时声明，取值 `on|summarized`（当前模型不能关闭思考，不提供 off）。
 *   默认 summarized：adaptive 思考必须显式请求，插件一直发 `display: "summarized"`，默认值保持原行为
 *   （A5「默认值只取 API 默认」的有意例外）；`on` 映射为 API 默认的 `display: "omitted"`。
 */
function parametersOf(levels: Effort[] | null, adaptive: boolean): ModelParameter[] {
  const out: ModelParameter[] = [];
  if (levels !== null) {
    out.push({
      key: "effort",
      standard: "effort",
      schema: { type: "string", enum: levels },
      ...(levels.includes("high") ? { default: "high" } : {}),
      label: { zh: "思考深度", en: "Effort" },
      description: {
        zh: "越高思考越充分，耗时与用量越多",
        en: "Higher means more thorough reasoning, more time and tokens",
      },
    });
  }
  if (adaptive) {
    out.push({
      key: "thinking",
      standard: "thinking",
      schema: { type: "string", enum: ["on", "summarized"] },
      default: "summarized",
      label: { zh: "思考模式", en: "Thinking" },
      description: {
        zh: "summarized 返回思考摘要供界面展示；on 只思考、不返回思考文本",
        en: "summarized streams a reasoning summary; on thinks without returning thinking text",
      },
    });
  }
  return out;
}

/**
 * Models API → ModelInfo。reasoning 取「支持 adaptive 思考」（插件只发 adaptive）；没有 capabilities 时
 * 按不支持处理（不声明 effort / thinking，请求里不发 thinking 与 effort）。
 */
function mapModelInfo(m: Anthropic.ModelInfo): ModelInfo {
  const caps = m.capabilities;
  const adaptive =
    caps?.thinking?.supported === true && caps.thinking.types?.adaptive?.supported === true;
  return {
    id: m.id,
    displayName: m.display_name,
    contextWindow: m.max_input_tokens ?? FALLBACK_CONTEXT_WINDOW,
    maxOutputTokens: m.max_tokens ?? FALLBACK_MAX_OUTPUT,
    capabilities: {
      tools: true,
      vision: caps?.image_input?.supported === true,
      reasoning: adaptive,
      caching: true,
      // 中途 system 一律转成 "[system]" user 文本，不用原生 role: "system"（R38）
      midConversationSystem: false,
    },
    streamIdleTimeoutMs: STREAM_IDLE_TIMEOUT_MS,
    parameters: parametersOf(effortLevels(caps?.effort), adaptive),
  };
}

/** 基于官方 SDK 与原生 Messages API 的 model-provider@2 实现。无进程内状态：模型信息缓存在 kv。 */
export function createAnthropicProvider(opts: AnthropicProviderOptions): ModelProvider {
  const client = new Anthropic({
    apiKey: opts.apiKey,
    ...(opts.baseUrl !== undefined ? { baseURL: opts.baseUrl } : {}),
    // 重试由内核的降级梯子统一处理
    maxRetries: 0,
  });

  async function getModel(id: string): Promise<ModelInfo> {
    const key = modelCacheKey(id);
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

  /**
   * 部署配置里的模型逐个取。仅跳过「不可重试」的模型错误（例如 id 写错、账号无权访问）并记 warn；
   * 只要有可重试的失败（网络、5xx、429、过载），或一个 id 都没取到，就抛出，避免内核把残缺结果缓存下来。
   */
  async function listModels(): Promise<ModelInfo[]> {
    const settled = await Promise.allSettled(opts.models.map(getModel));
    const out: ModelInfo[] = [];
    let retryable: ModelError | undefined;
    let firstError: ModelError | undefined;
    settled.forEach((r, i) => {
      if (r.status === "fulfilled") {
        out.push(r.value);
        return;
      }
      const e = toModelError(r.reason);
      firstError ??= e;
      if (e.retryable) {
        retryable ??= e;
        return;
      }
      opts.log?.warn("cannot load anthropic model; skipping", { model: opts.models[i], err: e });
    });
    if (retryable !== undefined) throw retryable;
    if (out.length === 0 && firstError !== undefined) throw firstError;
    return out;
  }

  /**
   * 先取模型信息（kv 缓存），只对支持 adaptive 思考的模型发 thinking；参数只保留该模型声明过的键
   * （内核已按声明处理，这里再兜一层，避免向不支持的模型发 effort 被 400）。
   */
  async function* stream(req: ModelRequest, signal: AbortSignal): AsyncGenerator<ModelStreamEvent> {
    const info = await getModel(req.model);
    const declared = new Set(info.parameters.map((d) => d.key));
    const params = Object.fromEntries(Object.entries(req.params).filter(([k]) => declared.has(k)));
    yield* streamMessages(
      client,
      { ...req, params },
      { signal, serverFallbacks: opts.serverFallbacks, thinking: info.capabilities.reasoning },
    );
  }

  return {
    listModels,
    stream: (req, { signal }) => stream(req, signal),
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
  provides: [MODEL_PROVIDER_CAPABILITY_V2],
  config: { deployment: DeploymentConfig },
  setup(ctx) {
    const cfg = DeploymentConfig.parse(ctx.config ?? {});
    ctx.provide(
      MODEL_PROVIDER_CAPABILITY_V2,
      createAnthropicProvider({
        kv: ctx.kv,
        apiKey: cfg.apiKey,
        baseUrl: cfg.baseUrl,
        models: cfg.models,
        serverFallbacks: cfg.serverFallbacks,
        log: ctx.log,
      }),
    );
  },
});
