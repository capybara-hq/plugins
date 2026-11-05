import { WebProviderError } from "@capybara-hq/plugin-sdk";
import { describe, expect, it } from "vitest";
import { apiKeyOf, JinaDeployment, jinaConfigured } from "../src/config.js";

describe("jina config", () => {
  it("is configured only with a non-empty api key", () => {
    expect(jinaConfigured({ apiKey: "k" })).toBe(true);
    expect(jinaConfigured({})).toBe(false);
    expect(jinaConfigured({ apiKey: "" })).toBe(false);
    expect(jinaConfigured(null)).toBe(false);
  });

  it("rejects keys a header cannot carry and trims the rest", () => {
    expect(jinaConfigured({ apiKey: "k\u200b" })).toBe(false);
    expect(jinaConfigured({ apiKey: "a b" })).toBe(false);
    expect(jinaConfigured({ apiKey: " k " })).toBe(true);
    expect(apiKeyOf({ apiKey: " k " })).toBe("k");
  });

  it("defaults the deployment endpoints", () => {
    expect(JinaDeployment.parse({})).toEqual({
      searchUrl: "https://s.jina.ai",
      readerUrl: "https://r.jina.ai",
    });
  });

  it("apiKeyOf returns the key and throws an auth error without one", () => {
    expect(apiKeyOf({ apiKey: "k" })).toBe("k");
    try {
      apiKeyOf({});
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(WebProviderError);
      expect((err as WebProviderError).kind).toBe("auth");
    }
  });
});
