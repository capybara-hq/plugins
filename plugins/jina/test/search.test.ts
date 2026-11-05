import { WebProviderError } from "@capybara-hq/plugin-sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createJinaSearch } from "../src/search.js";
import { type FakeJina, startFakeJina } from "./fake-jina.js";

let fake: FakeJina;
beforeEach(async () => {
  fake = await startFakeJina();
});
afterEach(async () => {
  await fake.stop();
});

const orgConfig = { apiKey: "k" };
function run(extra: Record<string, unknown> = {}) {
  return createJinaSearch({ searchUrl: fake.url }).search({
    query: "capybara",
    maxResults: 10,
    orgConfig,
    signal: new AbortController().signal,
    ...extra,
  });
}
const ok = (data: unknown) => () => ({ status: 200, body: JSON.stringify({ data }) });

describe("jina web-search", () => {
  it("maps Jina results", async () => {
    fake.respond(
      ok([
        {
          title: "A",
          url: "https://a.example/x",
          description: "about a",
          publishedTime: "2026-11-01T08:00:00Z",
        },
        { title: "B", url: "https://b.example/" },
      ]),
    );
    expect((await run()).results).toEqual([
      {
        title: "A",
        url: "https://a.example/x",
        snippet: "about a",
        publishedAt: "2026-11-01T08:00:00Z",
      },
      { title: "B", url: "https://b.example/" },
    ]);
  });

  it("sends the query, no-content and no site for zero or several domains", async () => {
    fake.respond(ok([]));
    await run({ query: "capybara release & notes", allowedDomains: ["a.com", "b.com"] });
    const req = fake.requests[0];
    if (!req) throw new Error("no request");
    expect(req.path).toBe("/?q=capybara%20release%20%26%20notes");
    expect(req.headers["x-respond-with"]).toBe("no-content");
    expect(req.headers["x-site"]).toBeUndefined();
    expect(req.headers.authorization).toBe("Bearer k");
  });

  it("one allowed domain becomes X-Site", async () => {
    fake.respond(ok([]));
    await run({ allowedDomains: ["docs.jina.ai"] });
    expect(fake.requests[0]?.headers["x-site"]).toBe("https://docs.jina.ai");
  });

  it("a non-ASCII allowed domain sends no X-Site", async () => {
    fake.respond(ok([]));
    await run({ allowedDomains: ["bücher.de"] });
    expect(fake.requests[0]?.headers["x-site"]).toBeUndefined();
  });

  it("maxResults 0 returns nothing", async () => {
    fake.respond(ok([{ title: "t", url: "https://e.example/1" }]));
    expect((await run({ maxResults: 0 })).results).toEqual([]);
  });

  it("trims result URLs", async () => {
    fake.respond(ok([{ title: "t", url: " https://a.example/x " }]));
    expect((await run()).results[0]?.url).toBe("https://a.example/x");
  });

  it("slices to maxResults", async () => {
    fake.respond(
      ok(Array.from({ length: 12 }, (_, i) => ({ title: `t${i}`, url: `https://e.example/${i}` }))),
    );
    const { results } = await run({ maxResults: 10 });
    expect(results.map((r) => r.title)).toEqual(Array.from({ length: 10 }, (_, i) => `t${i}`));
  });

  it("drops unusable URLs and fills a missing title", async () => {
    fake.respond(
      ok([
        { title: "rel", url: "/relative" },
        { title: "ftp", url: "ftp://x.example/f" },
        { title: "none" },
        { url: "https://c.example", title: " ", date: "not a date" },
      ]),
    );
    expect((await run()).results).toEqual([
      { title: "https://c.example", url: "https://c.example" },
    ]);
  });

  it("prefers a valid publishedTime and falls back to date", async () => {
    fake.respond(
      ok([
        { url: "https://a.example", publishedTime: "2026-01-02", date: "2025-01-01" },
        { url: "https://b.example", publishedTime: "nope", date: "2025-01-01" },
      ]),
    );
    const { results } = await run();
    expect(results.map((r) => r.publishedAt)).toEqual(["2026-01-02", "2025-01-01"]);
  });

  it("data null is unavailable", async () => {
    fake.respond(() => ({ status: 200, body: JSON.stringify({ data: null }) }));
    await expect(run()).rejects.toMatchObject({
      kind: "unavailable",
      message: "Jina search returned an unexpected response",
    });
  });

  it("401 is auth", async () => {
    fake.respond(() => ({ status: 401, body: "{}" }));
    const err = await run().catch((e) => e);
    expect(err).toBeInstanceOf(WebProviderError);
    expect(err.kind).toBe("auth");
  });

  it("configured follows the org config", () => {
    const p = createJinaSearch({ searchUrl: fake.url });
    expect(p.configured?.({})).toBe(false);
    expect(p.configured?.({ apiKey: "k" })).toBe(true);
  });
});
