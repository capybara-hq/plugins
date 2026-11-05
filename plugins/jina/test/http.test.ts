import { WebProviderError } from "@capybara-hq/plugin-sdk";
import { afterEach, describe, expect, it } from "vitest";
import { type JinaOp, jinaErrorKind, jinaRequest, joinUrl } from "../src/http.js";
import { type FakeJina, startFakeJina } from "./fake-jina.js";

const TABLE: [number, string, string][] = [
  [401, "auth", "auth"],
  [403, "auth", "auth"],
  [402, "rate_limited", "rate_limited"],
  [429, "rate_limited", "rate_limited"],
  [404, "not_found", "not_found"],
  [422, "invalid", "not_found"],
  [451, "blocked", "blocked"],
  [400, "invalid", "invalid"],
  [418, "invalid", "invalid"],
  [500, "unavailable", "unavailable"],
  [503, "unavailable", "unavailable"],
];

let fake: FakeJina | undefined;
afterEach(async () => {
  await fake?.stop();
  fake = undefined;
});

const call = (url: string, signal = new AbortController().signal, op: JinaOp = "search") =>
  jinaRequest(op, url, { apiKey: "k-123", method: "GET", signal });

describe("jinaErrorKind", () => {
  it.each(TABLE)("maps %i", (status, search, reader) => {
    expect(jinaErrorKind("search", status)).toBe(search);
    expect(jinaErrorKind("reader", status)).toBe(reader);
  });
});

describe("jinaRequest", () => {
  it("sends the bearer key and Accept: application/json", async () => {
    fake = await startFakeJina();
    fake.respond(() => ({ status: 200, body: '{"data":[]}' }));
    await expect(call(fake.url)).resolves.toEqual({ data: [] });
    expect(fake.requests[0]?.headers.authorization).toBe("Bearer k-123");
    expect(fake.requests[0]?.headers.accept).toBe("application/json");
  });

  it("a 401 is auth and the error carries neither the key nor the body", async () => {
    fake = await startFakeJina();
    fake.respond(() => ({ status: 401, body: '{"message":"bad key k-123"}' }));
    const err = await call(fake.url).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WebProviderError);
    const e = err as WebProviderError;
    expect(e.kind).toBe("auth");
    expect(e.message).toBe("Jina search failed: HTTP 401");
    expect(JSON.stringify(e) + e.message + String(e.stack)).not.toContain("k-123");
  });

  it("a 200 HTML body is unavailable", async () => {
    fake = await startFakeJina();
    fake.respond(() => ({ status: 200, body: "<html><body>oops</body></html>" }));
    await expect(call(fake.url)).rejects.toMatchObject({ kind: "unavailable" });
  });

  it("a refused connection is unavailable", async () => {
    const closed = await startFakeJina();
    const url = closed.url;
    await closed.stop();
    await expect(call(url)).rejects.toMatchObject({ kind: "unavailable" });
  });

  it("an aborted call rethrows the abort", async () => {
    fake = await startFakeJina();
    fake.respond(() => ({ status: 200, body: "{}", delayMs: 5000 }));
    const controller = new AbortController();
    const reason = new Error("stop");
    setTimeout(() => controller.abort(reason), 50);
    await expect(call(fake.url, controller.signal)).rejects.toBe(reason);
  });
});

describe("joinUrl", () => {
  it("joins without doubling the slash", () => {
    expect(joinUrl("https://proxy.example/jina/s/", "/?q=x")).toBe(
      "https://proxy.example/jina/s/?q=x",
    );
    expect(joinUrl("https://s.jina.ai", "/")).toBe("https://s.jina.ai/");
  });
});
