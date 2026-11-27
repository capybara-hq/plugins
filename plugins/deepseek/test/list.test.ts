import { assertValidDeclarations, isModelError } from "@capybara-hq/plugin-sdk";
import {
  type FakeModelServer,
  type FakeResponse,
  startFakeModelServer,
} from "@capybara-hq/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDeepSeekProvider } from "../src/index.js";
import { errorJson, MODELS_BODY, recordingNet, refusingNetFetch } from "./fixtures.js";

describe("deepseek listModels", () => {
  let server: FakeModelServer;
  let next: () => FakeResponse;
  beforeAll(async () => {
    server = await startFakeModelServer(() => next());
  });
  afterAll(async () => {
    await server?.stop();
  });
  const provider = () =>
    createDeepSeekProvider({
      netFetch: recordingNet().netFetch,
      apiKey: "sk-default",
      baseUrl: server.url,
    });

  it("maps the live /models body and the minimal entry", async () => {
    next = () => ({ status: 200, json: MODELS_BODY });
    const models = await provider().listModels();
    expect(models.map((m) => m.id)).toEqual([
      "deepseek-flash",
      "deepseek-v4-pro",
      "deepseek-plain",
    ]);
    const [flash, pro, plain] = models;
    expect(flash).toMatchObject({
      displayName: "DeepSeek-V4.1-Flash",
      kind: "chat",
      contextWindow: 1048576,
      maxOutputTokens: 393216,
      streamIdleTimeoutMs: 300000,
      capabilities: {
        tools: true,
        vision: true,
        documents: false,
        reasoning: true,
        midConversationSystem: false,
      },
    });
    expect(pro?.capabilities.vision).toBe(false);
    const keys = flash?.parameters.map((p) => p.key);
    expect(keys).toEqual(["thinking", "effort", "temperature"]);
    const effort = flash?.parameters.find((p) => p.key === "effort");
    expect(effort?.schema).toEqual({ type: "string", enum: ["low", "high", "max"] });
    expect(effort?.default).toBe("high");
    expect(flash?.parameters.find((p) => p.key === "thinking")?.default).toBe("on");
    expect(flash?.parameters.find((p) => p.key === "temperature")).toMatchObject({
      schema: { type: "number", minimum: 0, maximum: 2 },
      default: 1,
    });
    for (const m of models)
      expect(() => assertValidDeclarations("deepseek", m.parameters)).not.toThrow();
    // only an id: name falls back to the id, bundled table does not know it, conservative defaults
    expect(plain).toMatchObject({
      displayName: "deepseek-plain",
      contextWindow: 128000,
      maxOutputTokens: 8192,
      capabilities: { vision: false, reasoning: false },
    });
    expect(plain?.parameters.map((p) => p.key)).toEqual(["temperature"]);
    expect(plain?.streamIdleTimeoutMs).toBeUndefined();
    expect(server.requests.at(-1)?.path).toBe("/models");
    expect(server.requests.at(-1)?.headers.authorization).toBe("Bearer sk-default");
  });

  it("every chat model declares the implicit prompt cache", async () => {
    next = () => ({ status: 200, json: MODELS_BODY });
    const models = await provider().listModels();
    expect(models.length).toBeGreaterThan(0);
    for (const m of models) {
      expect(m.cache).toEqual({
        mechanism: "implicit",
        ttlOptions: [],
        ttlIsMinimum: false,
        refreshOnHit: false,
        ttlClock: "unknown",
        minTokens: 256,
        guaranteed: false,
      });
    }
  });

  it("skips null and malformed entries with a warning, never failing the list", async () => {
    next = () => ({
      status: 200,
      json: { object: "list", data: [null, 7, "x", { id: 3 }, { id: "deepseek-plain" }] },
    });
    const warnings: string[] = [];
    const models = await createDeepSeekProvider({
      netFetch: recordingNet().netFetch,
      apiKey: "sk-default",
      baseUrl: server.url,
      log: { warn: (msg) => warnings.push(msg) },
    }).listModels();
    expect(models.map((m) => m.id)).toEqual(["deepseek-plain"]);
    expect(warnings).toEqual(["deepseek: skipped 4 malformed model list entries"]);
  });

  it("falls back to the bundled table when limits are missing", async () => {
    next = () => ({
      status: 200,
      json: { object: "list", data: [{ id: "deepseek-flash" }, { id: "deepseek-v4-pro" }] },
    });
    const models = await provider().listModels();
    for (const m of models) {
      expect(m.contextWindow).toBe(1048576);
      expect(m.maxOutputTokens).toBe(393216);
    }
  });

  it("uses the org's key and base URL from opts.config", async () => {
    next = () => ({ status: 200, json: MODELS_BODY });
    await createDeepSeekProvider({ netFetch: recordingNet().netFetch }).listModels({
      config: { apiKey: "sk-org", baseUrl: server.url },
    });
    expect(server.requests.at(-1)?.headers.authorization).toBe("Bearer sk-org");
  });

  it("an org's own base URL goes through ctx.net with the org's id; the platform's keeps fetch", async () => {
    next = () => ({ status: 200, json: MODELS_BODY });
    const net = recordingNet();
    const p = createDeepSeekProvider({
      apiKey: "sk-default",
      baseUrl: "https://api.deepseek.com",
      netFetch: net.netFetch,
    });
    await p.listModels({ orgId: "org-1", config: { apiKey: "sk-org", baseUrl: server.url } });
    expect(net.calls).toEqual([{ url: `${server.url}/models`, orgId: "org-1" }]);
    expect(server.requests.at(-1)?.headers.authorization).toBe("Bearer sk-org");

    // following the platform (its baseUrl in the per-call config): the global fetch, not ctx.net
    const platform = recordingNet();
    await createDeepSeekProvider({
      apiKey: "sk-default",
      baseUrl: server.url,
      netFetch: platform.netFetch,
    }).listModels({ orgId: "org-1", config: { apiKey: "sk-default", baseUrl: `${server.url}/` } });
    expect(platform.calls).toEqual([]);
    expect(server.requests.at(-1)?.headers.authorization).toBe("Bearer sk-default");
  });

  it("an org base URL ctx.net refuses -> invalid_request naming the host, nothing sent", async () => {
    const before = server.requests.length;
    const e = await createDeepSeekProvider({ netFetch: refusingNetFetch })
      .listModels({
        orgId: "org-1",
        config: { apiKey: "sk-org", baseUrl: "https://10.0.0.7/v1?tenant=secret-q" },
      })
      .catch((x: unknown) => x);
    expect(isModelError(e) && e.kind).toBe("invalid_request");
    const message = e instanceof Error ? e.message : "";
    expect(message).toContain("10.0.0.7");
    expect(message).toMatch(/refused by the platform's network rules/);
    expect(message).not.toMatch(/secret-q|sk-org/);
    expect(server.requests.length).toBe(before);
  });

  it("an org config without a key -> auth, the default key is not used", async () => {
    const before = server.requests.length;
    const e = await provider()
      .listModels({ config: { baseUrl: server.url } })
      .catch((x: unknown) => x);
    expect(isModelError(e) && e.kind).toBe("auth");
    expect(server.requests.length).toBe(before);
  });

  it("no key anywhere -> auth before any request", async () => {
    const before = server.requests.length;
    const e = await createDeepSeekProvider({
      netFetch: recordingNet().netFetch,
      baseUrl: server.url,
    })
      .listModels()
      .catch((x: unknown) => x);
    expect(isModelError(e) && e.kind).toBe("auth");
    expect(server.requests.length).toBe(before);
  });

  it.each([
    [401, "auth"],
    [402, "auth"],
    [429, "rate_limited"],
    [500, "server"],
    [503, "overloaded"],
  ])("HTTP %s -> %s", async (status, kind) => {
    next = () => errorJson(status, { message: "x" });
    const e = await provider()
      .listModels()
      .catch((x: unknown) => x);
    expect(isModelError(e) && e.kind).toBe(kind);
  });
});
