import { type EmbedRequest, isModelError, validateEmbedResult } from "@capybara-hq/plugin-sdk";
import { type FakeResponse, startFakeModelServer } from "@capybara-hq/testing";
import { describe, expect, it } from "vitest";
import { createBailianProvider } from "../src/index.js";
import { EMBEDDING_MODELS } from "../src/tables.js";
import { errorJson, vectorFor } from "./fixtures.js";

const PATH = "/api/v1/services/embeddings/text-embedding/text-embedding";

async function embedWith(
  response: (body: Record<string, unknown>) => FakeResponse,
  req: EmbedRequest,
) {
  const server = await startFakeModelServer((r) => response(r.body as Record<string, unknown>));
  const provider = createBailianProvider({ apiKey: "sk-fixture", baseUrl: server.url });
  try {
    const res = await provider.embed?.(req, { signal: new AbortController().signal });
    return { res, requests: server.requests };
  } catch (error) {
    return { error, requests: server.requests };
  } finally {
    await server.stop();
  }
}

const ok = (embeddings: unknown[], usage: unknown = { total_tokens: 12 }): FakeResponse => ({
  status: 200,
  json: { output: { embeddings }, usage, request_id: "req-fixture" },
});

const kindOf = (e: unknown) => (isModelError(e) ? e.kind : `not a ModelError: ${String(e)}`);

describe("embed", () => {
  it("returns vectors in input order whatever the text_index order, with the dimension sent", async () => {
    const req: EmbedRequest = {
      model: "text-embedding-v4",
      input: ["a", "b", "c"],
      dimensions: 64,
    };
    const { res, requests } = await embedWith(
      () =>
        ok([
          { text_index: 2, embedding: vectorFor("c", 64) },
          { text_index: 0, embedding: vectorFor("a", 64) },
          { text_index: 1, embedding: vectorFor("b", 64) },
        ]),
      req,
    );
    expect(requests[0]?.path).toBe(PATH);
    expect(requests[0]?.body).toEqual({
      model: "text-embedding-v4",
      input: { texts: ["a", "b", "c"] },
      parameters: { dimension: 64, text_type: "document" },
    });
    expect(res?.vectors).toEqual([vectorFor("a", 64), vectorFor("b", 64), vectorFor("c", 64)]);
    expect(res?.usage).toEqual({ inputTokens: 12 });
    const info = EMBEDDING_MODELS["text-embedding-v4"];
    expect(info && res && validateEmbedResult(req, info, res)).toBeNull();
  });

  it("reads `index` (the flash model's shape) and maps inputType query", async () => {
    const { res, requests } = await embedWith(
      () =>
        ok(
          [
            { index: 1, type: "dense", embedding: [0.2] },
            { index: 0, type: "dense", embedding: [0.1] },
          ],
          { prompt_tokens: 4, total_tokens: 4 },
        ),
      { model: "qwen3.7-text-embedding-flash", input: ["x", "y"], inputType: "query" },
    );
    expect((requests[0]?.body as { parameters?: unknown } | undefined)?.parameters).toEqual({
      dimension: 1024,
      text_type: "query",
    });
    expect(res?.vectors).toEqual([[0.1], [0.2]]);
  });

  it("does not send a dimension to a fixed-dimension model", async () => {
    const { requests } = await embedWith(
      () => ok([{ text_index: 0, embedding: vectorFor("a", 1536) }]),
      { model: "text-embedding-v2", input: ["a"] },
    );
    expect((requests[0]?.body as { parameters?: unknown } | undefined)?.parameters).toEqual({
      text_type: "document",
    });
  });

  it("refuses a model outside the table, an unsupported dimension and an oversized batch", async () => {
    for (const req of [
      { model: "text-embedding-async-v2", input: ["a"] },
      { model: "text-embedding-v4", input: ["a"], dimensions: 4096 },
      { model: "text-embedding-v4", input: Array.from({ length: 11 }, (_, i) => `t${i}`) },
      { model: "text-embedding-v4", input: [] },
    ]) {
      const { error, requests } = await embedWith(() => ok([]), req);
      expect(kindOf(error)).toBe("invalid_request");
      expect(requests).toHaveLength(0);
    }
  });

  it("a wrong vector count is server", async () => {
    const { error } = await embedWith(() => ok([{ text_index: 0, embedding: [1] }]), {
      model: "text-embedding-v4",
      input: ["a", "b"],
    });
    expect(kindOf(error)).toBe("server");
  });

  it.each<[string, FakeResponse, string]>([
    [
      "400 InvalidParameter",
      errorJson(
        400,
        "InvalidParameter",
        "<400> InternalError.Algo.InvalidParameter: Value error, batch size is invalid",
      ),
      "invalid_request",
    ],
    ["401", errorJson(401, "InvalidApiKey", "bad key"), "auth"],
    ["429", errorJson(429, "Throttling.RateQuota", "slow"), "rate_limited"],
    ["500", errorJson(500, "InternalError", "oops"), "server"],
  ])("HTTP %s is %s", async (_n, response, kind) => {
    const { error } = await embedWith(() => response, { model: "text-embedding-v4", input: ["a"] });
    expect(kindOf(error)).toBe(kind);
  });
});
