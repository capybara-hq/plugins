import { configUrlFetch, type WebFetchProvider, WebProviderError } from "@capybara-hq/plugin-sdk";
import { apiKeyOf, DEFAULTS, type JinaEnv, jinaConfigured, parseJinaConfig } from "./config.js";
import { jinaRequest, joinUrl } from "./http.js";
import { httpUrl, text } from "./util.js";

/**
 * `web-fetch@1` over Jina's reader (`r.jina.ai`). The URL travels in a JSON body so its query string
 * and fragment are never re-parsed as part of Jina's own URL.
 */
export function createJinaReader(env: JinaEnv): WebFetchProvider {
  return {
    configured: jinaConfigured,
    async fetch({ url, config, orgId, signal }) {
      const apiKey = apiKeyOf(config);
      const { readerUrl } = parseJinaConfig(config) ?? DEFAULTS;
      const fetch = configUrlFetch(env.net, {
        url: readerUrl,
        platform: parseJinaConfig(env.platform())?.readerUrl,
        orgId,
      });
      const body = await jinaRequest("reader", joinUrl(readerUrl, "/"), {
        apiKey,
        fetch,
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Return-Format": "markdown" },
        body: JSON.stringify({ url }),
        signal,
      });
      const data = (body as { data?: unknown } | null)?.data;
      if (typeof data !== "object" || data === null || Array.isArray(data)) {
        throw new WebProviderError("Jina reader returned an unexpected response", {
          kind: "unavailable",
        });
      }
      const d = data as Record<string, unknown>;
      const page: { finalUrl: string; title?: string; markdown: string } = {
        // `finalUrl` is where the page ended up after redirects; `url` echoes the request.
        finalUrl: httpUrl(text(d.finalUrl)) ?? httpUrl(text(d.url)) ?? url,
        markdown: typeof d.content === "string" ? d.content : "",
      };
      const title = text(d.title);
      if (title !== undefined) page.title = title;
      return page;
    },
  };
}
