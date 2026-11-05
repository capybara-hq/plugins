import { WebProviderError } from "@capybara-hq/plugin-sdk";
import { describe, expect, it } from "vitest";
import { createJinaReader } from "../../src/reader.js";
import { createJinaSearch } from "../../src/search.js";

/**
 * Jina live tests against the real service. Skipped unless `CAPYBARA_TEST_JINA_API_KEY` is set:
 * `set -a; . ~/.capybara-test.env; set +a; pnpm exec vitest run plugins/jina/test/live`
 */
const KEY = process.env.CAPYBARA_TEST_JINA_API_KEY;
const urls = { searchUrl: "https://s.jina.ai", readerUrl: "https://r.jina.ai" };
const search = createJinaSearch(urls);
const reader = createJinaReader(urls);
const cfg = { apiKey: KEY ?? "" };
const TIMEOUT = 60_000;

describe.skipIf(!KEY)("jina live", () => {
  it(
    "searches and maps results",
    async () => {
      const { results } = await search.search({
        query: "capybara animal",
        maxResults: 5,
        orgConfig: cfg,
        signal: AbortSignal.timeout(TIMEOUT),
      });
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results.length).toBeLessThanOrEqual(5);
      for (const r of results) {
        expect(r.url.startsWith("https://")).toBe(true);
        expect(r.title.length).toBeGreaterThan(0);
      }
      expect(results.some((r) => r.snippet !== undefined)).toBe(true);
    },
    TIMEOUT,
  );

  it(
    "restricts results to one allowed domain",
    async () => {
      const { results } = await search.search({
        query: "capybara",
        allowedDomains: ["wikipedia.org"],
        maxResults: 5,
        orgConfig: cfg,
        signal: AbortSignal.timeout(TIMEOUT),
      });
      expect(results.length).toBeGreaterThan(0);
      const d = "wikipedia.org";
      for (const r of results) {
        const h = new URL(r.url).hostname;
        expect(h === d || h.endsWith(`.${d}`)).toBe(true);
      }
    },
    TIMEOUT,
  );

  it(
    "reads a page as markdown",
    async () => {
      const page = await reader.fetch({
        url: "https://en.wikipedia.org/wiki/Capybara",
        orgConfig: cfg,
        signal: AbortSignal.timeout(TIMEOUT),
      });
      expect(page.markdown).toContain("Capybara");
      expect(page.finalUrl.startsWith("https://")).toBe(true);
    },
    TIMEOUT,
  );

  it(
    "maps a bad key to auth",
    async () => {
      const err = await search
        .search({
          query: "capybara",
          maxResults: 1,
          orgConfig: { apiKey: "jina_invalid_key_for_test" },
          signal: AbortSignal.timeout(TIMEOUT),
        })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(WebProviderError);
      expect((err as WebProviderError).kind).toBe("auth");
    },
    TIMEOUT,
  );
});
