import { NetDeniedError, WebProviderError } from "@capybara-hq/plugin-sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createJinaReader } from "../src/reader.js";
import { type FakeJina, startFakeJina } from "./fake-jina.js";

let fake: FakeJina;
beforeEach(async () => {
  fake = await startFakeJina();
});
afterEach(async () => {
  await fake.stop();
});

const config = () => ({ apiKey: "k", readerUrl: fake.url });
const guardedCalls: string[] = [];
const guardedFetch = ((url: string | URL) => {
  guardedCalls.push(String(url));
  throw new NetDeniedError("net.private_address", new URL(String(url)).hostname, "private");
}) as unknown as typeof fetch;
function run(url: string) {
  return createJinaReader({ net: { fetch: guardedFetch }, platform: config }).fetch({
    url,
    config: config(),
    signal: new AbortController().signal,
  });
}
const ok = (data: unknown) => () => ({ status: 200, body: JSON.stringify({ data }) });
async function kindOf(p: Promise<unknown>) {
  const err = await p.then(
    () => undefined,
    (e) => e,
  );
  expect(err).toBeInstanceOf(WebProviderError);
  return err as WebProviderError;
}

describe("jina web-fetch", () => {
  it("posts the URL as JSON and asks for markdown", async () => {
    fake.respond(ok({ content: "x" }));
    const url = "https://example.com/a?x=1&y=2#top";
    await run(url);
    const req = fake.requests[0];
    if (!req) throw new Error("no request");
    expect(req.method).toBe("POST");
    expect(req.path).toBe("/");
    expect(req.headers["content-type"]).toMatch(/^application\/json/);
    expect(req.headers["x-return-format"]).toBe("markdown");
    expect(JSON.parse(req.body)).toEqual({ url });
  });

  it("maps the page", async () => {
    fake.respond(ok({ title: " T ", url: "https://example.com/b", content: "# Hi" }));
    expect(await run("https://example.com/a")).toEqual({
      finalUrl: "https://example.com/b",
      title: "T",
      markdown: "# Hi",
    });
  });

  it("prefers data.finalUrl over the echoed data.url", async () => {
    fake.respond(
      ok({ url: "https://example.com/a#x", finalUrl: "https://example.com/b", content: "x" }),
    );
    expect((await run("https://example.com/a#x")).finalUrl).toBe("https://example.com/b");
  });

  it("no data.url keeps the requested URL", async () => {
    fake.respond(ok({ content: "x" }));
    expect((await run("https://example.com/a")).finalUrl).toBe("https://example.com/a");
  });

  it("content missing is an empty page", async () => {
    fake.respond(ok({ title: "T" }));
    expect((await run("https://example.com/a")).markdown).toBe("");
  });

  it("422 is not_found, 451 is blocked, 429 is rate_limited", async () => {
    for (const [status, kind] of [
      [422, "not_found"],
      [451, "blocked"],
      [429, "rate_limited"],
    ] as const) {
      fake.respond(() => ({ status, body: "{}" }));
      expect((await kindOf(run("https://example.com/a"))).kind).toBe(kind);
    }
  });

  it("data null is unavailable", async () => {
    for (const data of [null, [], "x"]) {
      fake.respond(ok(data));
      const err = await kindOf(run("https://example.com/a"));
      expect(err.kind).toBe("unavailable");
      expect(err.message).toBe("Jina reader returned an unexpected response");
    }
  });

  it("an org readerUrl goes through the guarded client and a private host is refused", async () => {
    guardedCalls.length = 0;
    const err = await kindOf(
      createJinaReader({ net: { fetch: guardedFetch }, platform: config }).fetch({
        url: "https://example.com/a",
        config: { apiKey: "k", readerUrl: "http://10.0.0.5:9" },
        orgId: "o1",
        signal: new AbortController().signal,
      }),
    );
    expect(err.kind).toBe("invalid");
    expect(guardedCalls[0]).toContain("10.0.0.5");
  });

  it("the platform's own readerUrl bypasses the guarded client", async () => {
    guardedCalls.length = 0;
    fake.respond(ok({ content: "x" }));
    await run("https://example.com/a");
    expect(guardedCalls).toHaveLength(0);
  });

  it("configured needs an apiKey in the config", () => {
    const p = createJinaReader({ net: { fetch: guardedFetch }, platform: config });
    expect(p.configured?.({})).toBe(false);
    expect(p.configured?.({ apiKey: "k" })).toBe(true);
  });
});
