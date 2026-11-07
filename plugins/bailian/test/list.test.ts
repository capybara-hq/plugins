import { isModelError, type ModelInfo } from "@capybara-hq/plugin-sdk";
import { checkDeclaredParameters, startFakeModelServer } from "@capybara-hq/testing";
import { describe, expect, it, vi } from "vitest";
import { createBailianProvider } from "../src/index.js";
import { fixtureModels, listResponse, SPECIAL_MODELS } from "./fixtures.js";

async function listWith(models = fixtureModels()) {
  const server = await startFakeModelServer((req) => listResponse(req.path, models));
  const warn = vi.fn();
  const provider = createBailianProvider(
    { apiKey: "sk-fixture", baseUrl: server.url },
    { log: { warn } },
  );
  try {
    const list = await provider.listModels();
    return { list, warn, requests: server.requests };
  } finally {
    await server.stop();
  }
}

const byId = (list: ModelInfo[], id: string) => list.find((m) => m.id === id);

describe("listModels", () => {
  it("pages to the end with the largest page size the API accepts", async () => {
    const { list, requests } = await listWith();
    expect(requests).toHaveLength(2);
    for (const r of requests) {
      const u = new URL(r.path, "http://x");
      expect(u.pathname).toBe("/api/v1/models");
      expect(u.searchParams.get("page_size")).toBe("200");
      expect(u.searchParams.get("supports")).toBe("inference");
      expect(u.searchParams.get("language")).toBe("zh-CN");
      expect(r.headers.authorization).toBe("Bearer sk-fixture");
    }
    expect(requests.map((r) => new URL(r.path, "http://x").searchParams.get("page_no"))).toEqual([
      "1",
      "2",
    ]);
    // 210 fillers + the special entries that map to a kind
    expect(list.filter((m) => m.id.startsWith("cosyvoice-filler-"))).toHaveLength(210);
    expect(byId(list, "qwen3.8-flash")).toBeDefined();
  });

  it("maps a vision reasoning chat model", async () => {
    const { list } = await listWith();
    const m = byId(list, "qwen3.8-flash");
    expect(m).toMatchObject({
      displayName: "Qwen3.8-Flash",
      kind: "chat",
      publisher: "qwen",
      description: "旗舰轻量模型",
      contextWindow: 1_000_000,
      maxOutputTokens: 131_072,
      streamIdleTimeoutMs: 300_000,
      capabilities: {
        tools: true,
        vision: true,
        reasoning: true,
        caching: true,
        midConversationSystem: false,
        documents: false,
      },
    });
    expect(m?.parameters.map((p) => p.key)).toEqual(["thinking", "temperature", "maxOutputTokens"]);
    // Qwen's thinking default differs per model: no default declared
    expect(m?.parameters.find((p) => p.key === "thinking")?.default).toBeUndefined();
    expect(m?.retiresAt).toBeUndefined();
  });

  it("maps a plain chat model and a hosted vendor's model", async () => {
    const { list } = await listWith();
    const ds = byId(list, "deepseek-v4-pro");
    expect(ds).toMatchObject({
      kind: "chat",
      publisher: "deepseek",
      capabilities: { tools: true, vision: false, reasoning: false, caching: false },
    });
    expect(ds?.streamIdleTimeoutMs).toBeUndefined();
    expect(ds?.parameters.map((p) => p.key)).toEqual(["temperature", "maxOutputTokens"]);
  });

  it("uses conservative defaults for null limits and the id for a null name", async () => {
    const { list } = await listWith();
    expect(byId(list, "decision-model-preview")).toMatchObject({
      displayName: "decision-model-preview",
      contextWindow: 32_768,
      maxOutputTokens: 4096,
    });
  });

  it("carries offline_time as retiresAt", async () => {
    const { list } = await listWith();
    expect(byId(list, "qwen3.5-plus")?.retiresAt).toBe("2027-01-19");
  });

  it("leaves out models served by an unverified inference provider", async () => {
    const { list } = await listWith();
    expect(byId(list, "siliconflow/deepseek-v3.2")).toBeUndefined();
  });

  it("maps embedding models from the bundled table and skips unknown ones with one warn", async () => {
    const { list, warn } = await listWith();
    expect(byId(list, "text-embedding-v4")).toMatchObject({
      kind: "embedding",
      embedding: {
        dimensions: [2048, 1536, 1024, 768, 512, 256, 128, 64],
        defaultDimensions: 1024,
        maxBatch: 10,
        maxInputTokens: 8192,
      },
      parameters: [],
    });
    expect(byId(list, "text-embedding-async-v2")).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warn.mock.calls[0])).toContain("text-embedding-async-v2");
  });

  it("maps the other kinds and skips codes without an SDK kind", async () => {
    const { list } = await listWith();
    expect(byId(list, "gte-rerank-v2")?.kind).toBe("rerank");
    expect(byId(list, "wan2.7-t2i")?.kind).toBe("image_generation");
    expect(byId(list, "wan2.7-t2v")?.kind).toBe("video_generation");
    expect(byId(list, "paraformer-v2")?.kind).toBe("speech_to_text");
    expect(byId(list, "cosyvoice-v3")?.kind).toBe("text_to_speech");
    for (const id of [
      "multimodal-embedding-v1",
      "qwen3-omni-realtime",
      "tripo-3d",
      "future-model",
      "broken-caps",
      "",
    ]) {
      expect(byId(list, id)).toBeUndefined();
    }
    const nonChat = list.filter((m) => m.kind !== "chat");
    for (const m of nonChat) expect(m.parameters).toEqual([]);
  });

  it("declares valid parameters on every model", async () => {
    const { list } = await listWith();
    expect(checkDeclaredParameters("bailian", list)).toEqual([]);
  });

  it("a short list is one request", async () => {
    const { list, requests } = await listWith(SPECIAL_MODELS);
    expect(requests).toHaveLength(1);
    expect(list.length).toBeGreaterThan(5);
  });

  it("an error body under HTTP 200 fails the list", async () => {
    const server = await startFakeModelServer(() => ({
      status: 200,
      json: { code: "InvalidApiKey", message: "bad", success: false, output: null },
    }));
    const provider = createBailianProvider({ apiKey: "sk-fixture", baseUrl: server.url });
    const err = await provider.listModels().catch((e: unknown) => e);
    await server.stop();
    expect(isModelError(err) && err.kind).toBe("auth");
  });

  it("maps an HTTP error of the list", async () => {
    const server = await startFakeModelServer(() => ({
      status: 401,
      json: { code: "InvalidApiKey", message: "Invalid API-key provided." },
    }));
    const provider = createBailianProvider({ apiKey: "sk-fixture", baseUrl: server.url });
    const err = await provider.listModels().catch((e: unknown) => e);
    await server.stop();
    expect(isModelError(err) && err.kind).toBe("auth");
  });
});
