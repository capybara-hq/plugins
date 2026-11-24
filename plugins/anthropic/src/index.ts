import { createHash } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import {
  configUrlFetch,
  defineExtension,
  EFFORT_VALUES,
  type Effort,
  type ExtensionNet,
  type Logger,
  MODEL_PROVIDER_EXTENSION_POINT_V2,
  type ModelCallOptions,
  ModelError,
  type ModelInfo,
  type ModelParameter,
  type ModelProvider,
  type ModelRequest,
  type ModelStreamEvent,
  platformOnly,
  secret,
  ui,
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

const ANTHROPIC_DEFAULT_BASE_URL = "https://api.anthropic.com";
/** A fresh list each time: no shared mutable module state. */
const defaultModels = () => ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"];

/**
 * The provider's defaults (the platform's config) and services. The key, endpoint and models of a
 * call with a per-call config (`opts.config`, an org's effective config) come from that config as
 * a whole; these defaults serve only calls without one.
 */
export interface AnthropicProviderOptions {
  kv: Kv;
  apiKey?: string | undefined;
  baseUrl?: string | undefined;
  /** 允许的模型 id。 */
  models?: string[] | undefined;
  /** Platform-only: a value, or a getter reading `ctx.config` at call time. */
  serverFallbacks: ServerFallbacks | (() => ServerFallbacks);
  /**
   * The guarded client an org's own base URL goes through (`ctx.net`), so an org admin cannot point
   * the provider at an address the platform does not allow for the org. Unit tests inject one.
   */
  net: Pick<ExtensionNet, "fetch">;
  /**
   * The platform's base URL at the time of the call (`ctx.config` read when used); defaults to
   * `baseUrl`. A per-call base URL equal to it keeps the global `fetch`.
   */
  platformBaseUrl?: (() => string | undefined) | undefined;
  /** listModels 跳过取不到的模型时记 warn。 */
  log?: Pick<Logger, "warn"> | undefined;
}

const MODEL_CACHE_TTL_SECONDS = 3600;
const trimSlashes = (url: string) => url.replace(/\/+$/, "");

/**
 * The kv key of a cached model. The cache holds the mapped ModelInfo; the version in the key goes up
 * whenever its shape changes, so an upgrade never reads a shape an older version wrote (old keys
 * expire by TTL). v3: `capabilities.documents`. v4: keyed by the endpoint too (sha256 of the base
 * URL, trailing slashes ignored): `ctx.kv` is extension-wide, so an org's own endpoint must not
 * write entries other orgs read. Keyed by endpoint, not by API key: entries hold capability
 * metadata only, never anything a key grants.
 */
const modelCacheKey = (baseUrl: string, id: string) =>
  `models:v4:${createHash("sha256").update(trimSlashes(baseUrl)).digest("hex")}:${id}`;
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
 * Models API → ModelInfo。`vision` / `documents` 取 `capabilities.image_input` / `pdf_input`（SDK 0.135
 * `ModelCapabilities`：是否接受 image / PDF 内容块；https://platform.claude.com/docs/en/build-with-claude/pdf-support
 * 写明所有在售模型都支持 PDF，2026-10-21 核实）。reasoning 取「支持 adaptive 思考」（插件只发 adaptive）；
 * 没有 capabilities 时按不支持处理（不声明 effort / thinking，请求里不发 thinking 与 effort）。
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
      // PDF 文档块（纯文本文档块所有模型都收，但内核按 documents 一并把关）
      documents: caps?.pdf_input?.supported === true,
      reasoning: adaptive,
      caching: true,
      // 中途 system 一律转成 "[system]" user 文本，不用原生 role: "system"（R38）
      midConversationSystem: false,
    },
    streamIdleTimeoutMs: STREAM_IDLE_TIMEOUT_MS,
    parameters: parametersOf(effortLevels(caps?.effort), adaptive),
  };
}

/** Deployment config. Key, endpoint and models are org-overridable; `serverFallbacks` is not. */
const DeploymentConfig = z.object({
  apiKey: ui(secret(z.string().min(1)), { label: { zh: "API 密钥", en: "API key" } }),
  baseUrl: ui(z.url().default(ANTHROPIC_DEFAULT_BASE_URL), {
    label: { zh: "接口地址", en: "API URL" },
  }),
  models: ui(z.array(z.string().min(1)).default(defaultModels), {
    label: { zh: "可用模型", en: "Models" },
  }),
  // Platform operational switch: whether requests opt into the server-side fallback beta
  serverFallbacks: platformOnly(
    ui(z.enum(["default", "off"]).default("default"), {
      label: { zh: "服务端回退", en: "Server fallbacks" },
    }),
  ),
});

/**
 * A call's config: the key may be absent (the platform may leave it to the orgs); no key is `auth`
 * before any request.
 */
const CallConfig = DeploymentConfig.partial({ apiKey: true });

/**
 * `ANTHROPIC_CUSTOM_HEADERS` (host env) names, each mapped to `null`. The SDK merges that variable
 * into every request's headers, an org's own endpoint included; a `null` default header removes
 * it. Parsed exactly as the SDK does (lines, name before the first `:`). Capybara never sets it.
 */
function blockedEnvHeaders(): Record<string, null> {
  const out: Record<string, null> = {};
  const env = process.env.ANTHROPIC_CUSTOM_HEADERS;
  if (!env) return out;
  for (const line of env.split("\n")) {
    const colon = line.indexOf(":");
    if (colon >= 0) out[line.substring(0, colon).trim()] = null;
  }
  return out;
}

interface Resolved {
  client: Anthropic;
  baseUrl: string;
  models: string[];
}

/**
 * The client of this call: the org's effective config (`opts.config`) as a whole when given, else
 * the defaults. Never mixes a platform key into an org config (an org copy comes without the
 * platform's secrets; mixing would send the platform key to the org's endpoint).
 */
function resolve(defaults: AnthropicProviderOptions, opts: ModelCallOptions | undefined): Resolved {
  let apiKey: string | undefined;
  let baseUrl: string;
  let models: string[];
  if (opts?.config === undefined) {
    apiKey = defaults.apiKey;
    baseUrl = defaults.baseUrl ?? ANTHROPIC_DEFAULT_BASE_URL;
    models = defaults.models ?? defaultModels();
  } else {
    const parsed = CallConfig.safeParse(opts.config);
    if (!parsed.success) {
      throw new ModelError("invalid_request", "Anthropic: the extension config is invalid");
    }
    ({ apiKey, baseUrl, models } = parsed.data);
  }
  if (apiKey === undefined || apiKey === "") {
    throw new ModelError("auth", "Anthropic: no API key is configured");
  }
  const platform =
    (defaults.platformBaseUrl ?? (() => defaults.baseUrl))() ?? ANTHROPIC_DEFAULT_BASE_URL;
  const client = new Anthropic({
    apiKey,
    // Never read ANTHROPIC_AUTH_TOKEN: no bearer token of the host goes to another endpoint
    authToken: null,
    // Never send host-configured custom headers to any endpoint
    defaultHeaders: blockedEnvHeaders(),
    baseURL: baseUrl,
    // The platform's endpoint keeps the global fetch; an org's own one goes through ctx.net
    fetch: configUrlFetch(defaults.net, { url: baseUrl, platform, orgId: opts?.orgId }),
    // 重试由内核的降级梯子统一处理
    maxRetries: 0,
  });
  return { client, baseUrl, models };
}

/**
 * model-provider@2 on the official SDK and the native Messages API. No process state: model info is
 * cached in kv, and the client is built per call because the key and endpoint can differ per org.
 */
export function createAnthropicProvider(opts: AnthropicProviderOptions): ModelProvider {
  const serverFallbacks = (): ServerFallbacks =>
    typeof opts.serverFallbacks === "function" ? opts.serverFallbacks() : opts.serverFallbacks;

  async function getModel(r: Resolved, id: string): Promise<ModelInfo> {
    const key = modelCacheKey(r.baseUrl, id);
    const cached = await opts.kv.get(key);
    if (cached !== null) return JSON.parse(cached) as ModelInfo;
    let info: ModelInfo;
    try {
      info = mapModelInfo(await r.client.models.retrieve(id));
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
  async function listModels(call?: ModelCallOptions): Promise<ModelInfo[]> {
    const resolved = resolve(opts, call);
    const ids = resolved.models;
    const settled = await Promise.allSettled(ids.map((id) => getModel(resolved, id)));
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
      opts.log?.warn("cannot load anthropic model; skipping", { model: ids[i], err: e });
    });
    if (retryable !== undefined) throw retryable;
    if (out.length === 0 && firstError !== undefined) throw firstError;
    return out;
  }

  /**
   * 先取模型信息（kv 缓存），只对支持 adaptive 思考的模型发 thinking；参数只保留该模型声明过的键
   * （内核已按声明处理，这里再兜一层，避免向不支持的模型发 effort 被 400）。
   */
  async function* stream(
    req: ModelRequest,
    signal: AbortSignal,
    call: ModelCallOptions,
  ): AsyncGenerator<ModelStreamEvent> {
    const r = resolve(opts, call);
    const info = await getModel(r, req.model);
    const declared = new Set(info.parameters.map((d) => d.key));
    const params = Object.fromEntries(Object.entries(req.params).filter(([k]) => declared.has(k)));
    yield* streamMessages(
      r.client,
      { ...req, params },
      { signal, serverFallbacks: serverFallbacks(), thinking: info.capabilities.reasoning },
    );
  }

  return {
    listModels,
    stream: (req, { signal, ...call }) => stream(req, signal, call),
  };
}

/** Anthropic 供应商插件：官方 SDK + 原生 Messages API（不经 OpenAI 兼容层）。 */
export default defineExtension({
  name: "anthropic",
  version: "0.1.0-rc.10",
  sdk: "^0.1.0-rc.64",
  provides: [MODEL_PROVIDER_EXTENSION_POINT_V2],
  // Default host; the platform's baseUrl is display-only here, an org's own one goes through ctx.net
  permissions: { network: ["api.anthropic.com"] },
  config: { deployment: DeploymentConfig },
  setup(ctx) {
    // Lenient: the platform's config may lack the (overridable) key. ctx.config is read when used,
    // so a hot platform change applies at once.
    const platform = () => {
      const now = CallConfig.safeParse(ctx.config ?? {});
      return now.success ? now.data : undefined;
    };
    const cfg = platform();
    ctx.provide(
      MODEL_PROVIDER_EXTENSION_POINT_V2,
      createAnthropicProvider({
        kv: ctx.kv,
        apiKey: cfg?.apiKey,
        baseUrl: cfg?.baseUrl,
        models: cfg?.models,
        serverFallbacks: () => platform()?.serverFallbacks ?? "default",
        net: ctx.net,
        platformBaseUrl: () => platform()?.baseUrl,
        log: ctx.log,
      }),
    );
  },
});
