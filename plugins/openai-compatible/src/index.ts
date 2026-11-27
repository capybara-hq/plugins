import {
  configUrlFetch,
  defineExtension,
  type ExtensionNet,
  MODEL_PROVIDER_EXTENSION_POINT_V2,
  ModelError,
  type ModelInfo,
  type ModelProvider,
  type ModelStreamEvent,
  secret,
  ui,
} from "@capybara-hq/plugin-sdk";
import type OpenAI from "openai";
import { z } from "zod";
import { DIALECTS, type Dialect, PROVIDER } from "./dialects.js";
import { streamChat } from "./map-stream.js";
import { isolatedOpenAI } from "./openai-client.js";

const EndpointModelSchema = z.object({
  /** 端点上的原始模型 id（可含 `/`，如 vLLM 的 `Qwen/Qwen3-8B`）。 */
  id: ui(z.string().min(1), { label: { zh: "模型 ID", en: "Model ID" } }),
  contextWindow: ui(z.number().int().positive(), {
    label: { zh: "上下文窗口", en: "Context window" },
  }),
  maxOutputTokens: ui(z.number().int().positive(), {
    label: { zh: "最大输出", en: "Max output tokens" },
  }),
  /** 是否接受图片（`image_url`）；缺省 false。各方言的出处见 `dialects.ts`。 */
  vision: ui(z.boolean().optional(), { label: { zh: "图片输入", en: "Image input" } }),
  /**
   * 是否接受 PDF（`file` 内容）；缺省 false。只有 `pdfInput` 的方言（generic、qwen）能开启，其余方言配置校验拒绝。
   * 开启后内核也把 `text/*` 附件作为文档块发来，插件解码成文本片段。
   */
  documents: ui(z.boolean().optional(), { label: { zh: "PDF 输入", en: "PDF input" } }),
  reasoning: ui(z.boolean().optional(), { label: { zh: "推理", en: "Reasoning" } }),
  /** 未给时取方言默认（服务是否有自动前缀缓存）。 */
  caching: ui(z.boolean().optional(), { label: { zh: "提示缓存", en: "Prompt caching" } }),
  streamIdleTimeoutMs: ui(z.number().int().positive().optional(), {
    label: { zh: "流空闲超时", en: "Stream idle timeout" },
  }),
});

// strictObject：密钥不在端点里（见 apiKeys），误写的 `apiKey` 直接报错，而不是被静默丢掉后发出不带凭据的请求
const EndpointSchema = z.strictObject({
  /** 端点名：对外模型 id 为 `<端点名>/<模型 id>`，所以不能含 `/`。 */
  name: ui(
    z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, "endpoint name must match [A-Za-z0-9][A-Za-z0-9._-]*"),
    { label: { zh: "端点名", en: "Name" } },
  ),
  baseUrl: ui(z.string().url(), { label: { zh: "接口地址", en: "API URL" } }),
  dialect: ui(z.enum(["generic", "deepseek", "qwen", "ark"]), {
    label: { zh: "方言", en: "Dialect" },
  }),
  /** 中途 system 是否以原位置的 system 消息发送；未给时取方言默认。 */
  midConversationSystem: ui(z.boolean().optional(), {
    label: { zh: "原位置 system 消息", en: "In-place system messages" },
  }),
  models: ui(
    z
      .array(EndpointModelSchema)
      .min(1)
      .refine((ms) => new Set(ms.map((m) => m.id)).size === ms.length, "duplicate model id"),
    { label: { zh: "模型", en: "Models" } },
  ),
});

export type EndpointModelConfig = z.infer<typeof EndpointModelSchema>;
export type EndpointConfig = z.input<typeof EndpointSchema>;

const DeploymentShape = z.object({
  endpoints: ui(
    z
      .array(EndpointSchema)
      .min(1)
      .refine((es) => new Set(es.map((e) => e.name)).size === es.length, "duplicate endpoint name"),
    { label: { zh: "端点", en: "Endpoints" } },
  ),
  /**
   * Endpoint name -> API key; an endpoint without a key (an internal vLLM) has no entry and its
   * requests carry no Authorization header. An org copy starts as `{}`: the platform's keys never
   * reach it, so a kept platform endpoint is called without a key unless the org enters one.
   */
  apiKeys: ui(secret(z.record(z.string(), z.string().min(1))), {
    label: { zh: "API 密钥（按端点名）", en: "API keys (by endpoint name)" },
  }).default({}),
});

/** PDF input only on dialects that take it; every `apiKeys` key names a configured endpoint. */
function checkConfig(
  cfg: { endpoints?: EndpointConfig[] | undefined; apiKeys: Record<string, string> },
  ctx: z.RefinementCtx,
): void {
  const endpoints = cfg.endpoints ?? [];
  endpoints.forEach((e, i) => {
    if (DIALECTS[e.dialect].pdfInput) return;
    e.models.forEach((m, j) => {
      if (m.documents !== true) return;
      ctx.addIssue({
        code: "custom",
        path: ["endpoints", i, "models", j, "documents"],
        message: `dialect "${e.dialect}" does not accept PDF documents; documents must be false`,
      });
    });
  });
  const names = new Set(endpoints.map((e) => e.name));
  for (const key of Object.keys(cfg.apiKeys)) {
    if (!names.has(key)) {
      ctx.addIssue({
        code: "custom",
        path: ["apiKeys", key],
        message: `apiKeys["${key}"] does not match any endpoint name`,
      });
    }
  }
}

/**
 * Deployment config; both fields are org-overridable. The keys live in the top-level `apiKeys`
 * (endpoint name -> key): the kernel only recognizes `secret()` on object field paths, so a key
 * inside an `endpoints[]` element could be neither redacted nor stored encrypted.
 */
const DeploymentConfig = DeploymentShape.superRefine(checkConfig);

/**
 * A config as a call or setup reads it: the platform may leave the (required, overridable)
 * endpoints empty, leaving them to the orgs (the kernel's load gate relaxes the field).
 */
const CallConfig = DeploymentShape.partial({ endpoints: true }).superRefine(checkConfig);

export interface OpenAICompatibleProviderOptions {
  /** The platform's endpoints: used for calls without a per-call config. */
  endpoints?: EndpointConfig[] | undefined;
  /** Endpoint name -> API key, with `endpoints`. */
  apiKeys?: Record<string, string> | undefined;
  /**
   * The kernel's guarded client (`ctx.net`): an endpoint URL an org set (not one of the platform's
   * endpoint URLs) goes through it with the org's id. Without it such a URL is refused.
   */
  net?: Pick<ExtensionNet, "fetch"> | undefined;
  /**
   * The platform's config at the time of the call (`ctx.config` read when used); replaces
   * `endpoints` / `apiKeys` when given. It serves calls without a per-call config, and its endpoint
   * URLs are the platform's: an endpoint at one of them was set by the super admin and keeps the
   * global `fetch`.
   */
  platform?: (() => PlatformDefaults) | undefined;
}

interface PlatformDefaults {
  endpoints?: EndpointConfig[] | undefined;
  apiKeys?: Record<string, string> | undefined;
}

/** The platform's endpoints and keys now: live from `platform` when given, else the fixed options. */
function platformDefaults(opts: OpenAICompatibleProviderOptions): PlatformDefaults {
  return opts.platform?.() ?? { endpoints: opts.endpoints, apiKeys: opts.apiKeys };
}

interface Endpoint {
  cfg: EndpointConfig;
  dialect: Dialect;
  midConversationSystem: boolean;
}

interface Resolved {
  endpoints: Endpoint[];
  apiKeys: Record<string, string>;
}

/** Without `net`, an org-set URL is refused rather than fetched unguarded. */
const NO_NET: Pick<ExtensionNet, "fetch"> = {
  fetch: async () => {
    throw new ModelError(
      "invalid_request",
      "OpenAI-compatible: an organization's own endpoint needs the platform's network client",
    );
  },
};

function toEndpoint(cfg: EndpointConfig): Endpoint {
  const dialect = DIALECTS[cfg.dialect];
  return {
    cfg,
    dialect,
    midConversationSystem: cfg.midConversationSystem ?? dialect.midConversationSystem,
  };
}

/**
 * The endpoints and keys of this call: the org's effective config (`config`) as a whole when
 * given, else the platform defaults. Never mixes the two: a platform key must not reach an org
 * copy (it would be sent to whatever endpoint the org names).
 */
function resolve(opts: OpenAICompatibleProviderOptions, config: unknown): Resolved {
  if (config === undefined) {
    const d = platformDefaults(opts);
    return { endpoints: (d.endpoints ?? []).map(toEndpoint), apiKeys: d.apiKeys ?? {} };
  }
  const parsed = CallConfig.safeParse(config);
  if (!parsed.success) {
    throw new ModelError("invalid_request", "OpenAI-compatible: the extension config is invalid");
  }
  return {
    endpoints: (parsed.data.endpoints ?? []).map(toEndpoint),
    apiKeys: parsed.data.apiKeys,
  };
}

function makeClient(
  opts: OpenAICompatibleProviderOptions,
  cfg: EndpointConfig,
  apiKey: string | undefined,
  orgId: string | undefined,
): OpenAI {
  const platform = (platformDefaults(opts).endpoints ?? []).map((e) => e.baseUrl);
  // No OPENAI_* env var is read (isolatedOpenAI): never send a host value to another service
  return isolatedOpenAI({
    baseURL: cfg.baseUrl,
    // The SDK requires a credential: a keyless endpoint (an internal vLLM) gets a placeholder and
    // the Authorization header is removed below
    apiKey: apiKey ?? "unused",
    // A platform endpoint URL keeps the global fetch; an org-set one goes through ctx.net
    fetch: configUrlFetch(opts.net ?? NO_NET, { url: cfg.baseUrl, platform, orgId }),
    ...(apiKey === undefined ? { defaultHeaders: { Authorization: null } } : {}),
    // Retries belong to the kernel's degradation ladder
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
      // Config validation already refuses it on dialects without PDF input; a direct
      // construction is guarded here too
      documents: (m.documents ?? false) && ep.dialect.pdfInput,
      reasoning,
      midConversationSystem: ep.midConversationSystem,
    },
    ...(m.streamIdleTimeoutMs !== undefined ? { streamIdleTimeoutMs: m.streamIdleTimeoutMs } : {}),
    parameters: ep.dialect.parameters({ reasoning, maxOutputTokens: m.maxOutputTokens }),
  };
}

/**
 * model-provider@2 on the official `openai` SDK's `chat.completions`. No process state: the
 * endpoints and keys can differ per organization, so the client is built per call.
 */
export function createOpenAICompatibleProvider(
  opts: OpenAICompatibleProviderOptions,
): ModelProvider {
  return {
    async listModels(call) {
      const { endpoints } = resolve(opts, call?.config);
      return endpoints.flatMap((ep) => ep.cfg.models.map((m) => modelInfo(ep, m)));
    },
    async *stream(req, call): AsyncGenerator<ModelStreamEvent> {
      const { endpoints, apiKeys } = resolve(opts, call.config);
      const slash = req.model.indexOf("/");
      const ep =
        slash < 0 ? undefined : endpoints.find((e) => e.cfg.name === req.model.slice(0, slash));
      const upstreamModel = req.model.slice(slash + 1);
      const m = ep?.cfg.models.find((x) => x.id === upstreamModel);
      if (ep === undefined || m === undefined) {
        throw new ModelError("invalid_request", `Model "${req.model}" is not configured`);
      }
      const client = makeClient(opts, ep.cfg, apiKeys[ep.cfg.name], call.orgId);
      yield* streamChat(client, req, {
        signal: call.signal,
        target: {
          upstreamModel,
          dialect: ep.dialect,
          midConversationSystem: ep.midConversationSystem,
          model: { reasoning: m.reasoning ?? false, maxOutputTokens: m.maxOutputTokens },
          ...(call.orgId !== undefined ? { orgId: call.orgId } : {}),
        },
      });
    },
  };
}

/** A platform config read leniently; nothing when it is invalid. */
function platformOf(config: unknown): PlatformDefaults {
  const parsed = CallConfig.safeParse(config ?? {});
  return parsed.success ? parsed.data : {};
}

/** OpenAI-compatible (Chat Completions) provider plugin: vLLM, DeepSeek, Qwen, ...; dialects stay in this plugin. */
export default defineExtension({
  name: PROVIDER,
  version: "0.1.0-rc.14",
  sdk: "^0.1.0-rc.64",
  provides: [MODEL_PROVIDER_EXTENSION_POINT_V2],
  // No network permission: every endpoint comes from config, there is no fixed host. Org-set
  // endpoint URLs go through ctx.net
  config: { deployment: DeploymentConfig },
  setup(ctx) {
    ctx.provide(
      MODEL_PROVIDER_EXTENSION_POINT_V2,
      createOpenAICompatibleProvider({
        net: ctx.net,
        // ctx.config is read leniently (the platform may leave the endpoints to the orgs) and when
        // used: a hot platform change applies at once to both the defaults and the platform URLs
        platform: () => platformOf(ctx.config),
      }),
    );
  },
});
