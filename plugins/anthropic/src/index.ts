import Anthropic from "@anthropic-ai/sdk";
import {
  definePlugin,
  type Logger,
  MODEL_PROVIDER_CAPABILITY,
  type ModelError,
  type ModelInfoV1,
  type ModelProviderV1,
  type ModelRequestV1,
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
/** 思考阶段可能长时间不发事件。 */
const STREAM_IDLE_TIMEOUT_MS = 300_000;
const FALLBACK_CONTEXT_WINDOW = 200_000;
const FALLBACK_MAX_OUTPUT = 32_000;

/**
 * Models API → ModelInfoV1。reasoning 取「支持 adaptive 思考」（插件只发 adaptive），effort 取 `effort.supported`；
 * 没有 capabilities 时两者都按不支持处理（请求里不发 thinking、内核不传 effort）。
 */
function mapModelInfo(m: Anthropic.ModelInfo): ModelInfoV1 {
  const caps = m.capabilities;
  return {
    id: m.id,
    displayName: m.display_name,
    contextWindow: m.max_input_tokens ?? FALLBACK_CONTEXT_WINDOW,
    maxOutputTokens: m.max_tokens ?? FALLBACK_MAX_OUTPUT,
    capabilities: {
      tools: true,
      vision: caps?.image_input?.supported === true,
      reasoning:
        caps?.thinking?.supported === true && caps.thinking.types?.adaptive?.supported === true,
      caching: true,
      // 中途 system 一律转成 "[system]" user 文本，不用原生 role: "system"（R38）
      midConversationSystem: false,
      effort: caps?.effort?.supported === true,
    },
    streamIdleTimeoutMs: STREAM_IDLE_TIMEOUT_MS,
  };
}

/** 基于官方 SDK 与原生 Messages API 的 model-provider@1 实现。无进程内状态：模型信息缓存在 kv。 */
export function createAnthropicProvider(opts: AnthropicProviderOptions): ModelProviderV1 {
  const client = new Anthropic({
    apiKey: opts.apiKey,
    ...(opts.baseUrl !== undefined ? { baseURL: opts.baseUrl } : {}),
    // 重试由内核的降级梯子统一处理
    maxRetries: 0,
  });

  async function getModel(id: string): Promise<ModelInfoV1> {
    const key = `models:${id}`;
    const cached = await opts.kv.get(key);
    if (cached !== null) return JSON.parse(cached) as ModelInfoV1;
    let info: ModelInfoV1;
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
  async function listModels(): Promise<ModelInfoV1[]> {
    const settled = await Promise.allSettled(opts.models.map(getModel));
    const out: ModelInfoV1[] = [];
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

  /** 先取模型能力（kv 缓存），只对支持 adaptive 思考的模型发 thinking；不支持 effort 的模型丢弃 effort。 */
  async function* stream(
    req: ModelRequestV1,
    signal: AbortSignal,
  ): AsyncGenerator<ModelStreamEvent> {
    const caps = (await getModel(req.model)).capabilities;
    const { effort: _effort, ...rest } = req;
    yield* streamMessages(client, caps.effort ? req : rest, {
      signal,
      serverFallbacks: opts.serverFallbacks,
      thinking: caps.reasoning,
    });
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
        log: ctx.log,
      }),
    );
  },
});
