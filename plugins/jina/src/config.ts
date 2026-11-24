import { type ExtensionNet, secret, ui, WebProviderError } from "@capybara-hq/plugin-sdk";
import { z } from "zod";

/**
 * Deployment config. Every field is org-overridable: the platform may hold a shared API key, or leave
 * it empty so each org saves its own; an org may also point at its own endpoints (a proxy).
 */
export const JinaDeployment = z.object({
  apiKey: ui(
    secret(
      z
        .string()
        .trim()
        .regex(/^[\x21-\x7e]+$/, "must be printable ASCII without spaces")
        .optional(),
    ),
    {
      label: { zh: "API 密钥", en: "API key" },
      help: {
        zh: "在 jina.ai 的 API 控制台创建。",
        en: "Create one in the Jina API dashboard at jina.ai.",
      },
    },
  ),
  searchUrl: ui(z.string().url().default("https://s.jina.ai"), {
    label: { zh: "搜索接口地址", en: "Search API URL" },
    advanced: true,
  }),
  readerUrl: ui(z.string().url().default("https://r.jina.ai"), {
    label: { zh: "读取接口地址", en: "Reader API URL" },
    advanced: true,
  }),
});

export type JinaConfig = { apiKey?: string | undefined; searchUrl: string; readerUrl: string };

/** Every field optional: a platform that leaves the key empty must still parse. */
const CallConfig = JinaDeployment.partial();

/** The call's effective config (a missing endpoint takes its default), or undefined when invalid. */
export function parseJinaConfig(config: unknown): JinaConfig | undefined {
  const parsed = CallConfig.safeParse(config ?? {});
  if (!parsed.success) return undefined;
  const { apiKey, searchUrl, readerUrl } = parsed.data;
  return {
    apiKey: apiKey === "" ? undefined : apiKey,
    searchUrl: searchUrl ?? "https://s.jina.ai",
    readerUrl: readerUrl ?? "https://r.jina.ai",
  };
}

/** True when the effective config holds an API key. */
export function jinaConfigured(config: unknown): boolean {
  const apiKey = parseJinaConfig(config)?.apiKey;
  return apiKey !== undefined && apiKey !== "";
}

/** The effective config's API key; throws an `auth` error when none is configured. */
export function apiKeyOf(config: unknown): string {
  const apiKey = parseJinaConfig(config)?.apiKey;
  if (apiKey === undefined || apiKey === "") {
    throw new WebProviderError("Jina is not configured for this organization", { kind: "auth" });
  }
  return apiKey;
}

/** What a provider needs from its extension: the guarded client and the platform's own config. */
export type JinaEnv = {
  net: Pick<ExtensionNet, "fetch">;
  /** The platform's config (`ctx.config`), read at call time. */
  platform: () => unknown;
};

export const DEFAULTS = { searchUrl: "https://s.jina.ai", readerUrl: "https://r.jina.ai" };
