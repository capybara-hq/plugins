import { secret, ui, WebProviderError } from "@capybara-hq/plugin-sdk";
import { z } from "zod";

/** Deployment config: the two Jina endpoints (overridable for a proxy or tests). */
export const JinaDeployment = z.object({
  searchUrl: ui(z.string().url().default("https://s.jina.ai"), {
    label: { zh: "搜索接口地址", en: "Search API URL" },
    advanced: true,
  }),
  readerUrl: ui(z.string().url().default("https://r.jina.ai"), {
    label: { zh: "读取接口地址", en: "Reader API URL" },
    advanced: true,
  }),
});

/** Org config: the organization's Jina API key. */
export const JinaOrgConfig = z.object({
  apiKey: ui(
    secret(
      z
        .string()
        .trim()
        .regex(/^[\x21-\x7e]+$/, "must be printable ASCII without spaces"),
    ),
    {
      label: { zh: "API 密钥", en: "API key" },
      help: {
        zh: "在 jina.ai 的 API 控制台创建。",
        en: "Create one in the Jina API dashboard at jina.ai.",
      },
    },
  ),
});

export type JinaEndpoints = { searchUrl: string; readerUrl: string };

/** True when the org config holds an API key. */
export function jinaConfigured(orgConfig: unknown): boolean {
  return JinaOrgConfig.safeParse(orgConfig).success;
}

/** The org's API key; throws an `auth` error when the org has not configured one. */
export function apiKeyOf(orgConfig: unknown): string {
  const parsed = JinaOrgConfig.safeParse(orgConfig);
  if (!parsed.success) {
    throw new WebProviderError("Jina is not configured for this organization", { kind: "auth" });
  }
  return parsed.data.apiKey;
}
