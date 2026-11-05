import {
  WebProviderError,
  type WebSearchProvider,
  type WebSearchResult,
} from "@capybara-hq/plugin-sdk";
import { apiKeyOf, type JinaEndpoints, jinaConfigured } from "./config.js";
import { jinaRequest, joinUrl } from "./http.js";

function text(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t === "" ? undefined : t;
}

function validDate(v: unknown): string | undefined {
  return typeof v === "string" && !Number.isNaN(Date.parse(v)) ? v : undefined;
}

function httpUrl(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  try {
    const u = new URL(v);
    return u.protocol === "http:" || u.protocol === "https:" ? v : undefined;
  } catch {
    return undefined;
  }
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
export function createJinaSearch(endpoints: Pick<JinaEndpoints, "searchUrl">): WebSearchProvider {
  return {
    configured: jinaConfigured,
    async search({ query, allowedDomains, maxResults, orgConfig, signal }) {
      const apiKey = apiKeyOf(orgConfig);
      const headers: Record<string, string> = { "X-Respond-With": "no-content" };
      if (allowedDomains?.length === 1) headers["X-Site"] = `https://${allowedDomains[0]}`;
      const body = await jinaRequest(
        "search",
        joinUrl(endpoints.searchUrl, `/?q=${encodeURIComponent(query)}`),
        { apiKey, method: "GET", headers, signal },
      );
      const data = (body as { data?: unknown } | null)?.data;
      if (!Array.isArray(data)) {
        throw new WebProviderError("Jina search returned an unexpected response", {
          kind: "unavailable",
        });
      }
      const results: WebSearchResult[] = [];
      for (const item of data) {
        const r = toResult(item);
        if (r) results.push(r);
        if (results.length >= maxResults) break;
      }
      return { results };
    },
  };
}
