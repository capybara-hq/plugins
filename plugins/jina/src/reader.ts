import { type WebFetchProvider, WebProviderError } from "@capybara-hq/plugin-sdk";
import { apiKeyOf, type JinaEndpoints, jinaConfigured } from "./config.js";
import { jinaRequest, joinUrl } from "./http.js";
import { httpUrl, text } from "./util.js";

/**
 * `web-fetch@1` over Jina's reader (`r.jina.ai`). The URL travels in a JSON body so its query string
 * and fragment are never re-parsed as part of Jina's own URL.
 */
export function createJinaReader(endpoints: Pick<JinaEndpoints, "readerUrl">): WebFetchProvider {
  return {
    configured: jinaConfigured,
    async fetch({ url, orgConfig, signal }) {
      const apiKey = apiKeyOf(orgConfig);
      const body = await jinaRequest("reader", joinUrl(endpoints.readerUrl, "/"), {
        apiKey,
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
        finalUrl: httpUrl(text(d.url)) ?? url,
        markdown: typeof d.content === "string" ? d.content : "",
      };
      const title = text(d.title);
      if (title !== undefined) page.title = title;
      return page;
    },
  };
}
