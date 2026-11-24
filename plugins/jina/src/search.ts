import {
  configUrlFetch,
  WebProviderError,
  type WebSearchProvider,
  type WebSearchResult,
} from "@capybara-hq/plugin-sdk";
import { apiKeyOf, DEFAULTS, type JinaEnv, jinaConfigured, parseJinaConfig } from "./config.js";
import { jinaRequest, joinUrl } from "./http.js";
import { httpUrl, text } from "./util.js";

function validDate(v: unknown): string | undefined {
  return typeof v === "string" && !Number.isNaN(Date.parse(v)) ? v : undefined;
}

function toResult(item: unknown): WebSearchResult | undefined {
  if (typeof item !== "object" || item === null) return undefined;
  const r = item as Record<string, unknown>;
  const url = httpUrl(r.url);
  if (url === undefined) return undefined;
  const out: WebSearchResult = { title: text(r.title) ?? url, url };
  const snippet = text(r.description);
  if (snippet !== undefined) out.snippet = snippet;
  const publishedAt = validDate(r.publishedTime) ?? validDate(r.date);
  if (publishedAt !== undefined) out.publishedAt = publishedAt;
  return out;
}

/** `web-search@1` over Jina's search API (`s.jina.ai`), snippets only. */
export function createJinaSearch(env: JinaEnv): WebSearchProvider {
  return {
    configured: jinaConfigured,
    async search({ query, allowedDomains, maxResults, config, orgId, signal }) {
      const apiKey = apiKeyOf(config);
      const { searchUrl } = parseJinaConfig(config) ?? DEFAULTS;
      const fetch = configUrlFetch(env.net, {
        url: searchUrl,
        platform: parseJinaConfig(env.platform())?.searchUrl,
        orgId,
      });
      const headers: Record<string, string> = { "X-Respond-With": "no-content" };
      const site = allowedDomains?.length === 1 ? allowedDomains[0] : undefined;
      if (site !== undefined && /^[\x21-\x7e]+$/.test(site)) headers["X-Site"] = `https://${site}`;
      const body = await jinaRequest(
        "search",
        joinUrl(searchUrl, `/?q=${encodeURIComponent(query)}`),
        { apiKey, fetch, method: "GET", headers, signal },
      );
      const data = (body as { data?: unknown } | null)?.data;
      if (!Array.isArray(data)) {
        throw new WebProviderError("Jina search returned an unexpected response", {
          kind: "unavailable",
        });
      }
      const results: WebSearchResult[] = [];
      for (const item of data) {
        if (results.length >= maxResults) break;
        const r = toResult(item);
        if (r) results.push(r);
      }
      return { results };
    },
  };
}
