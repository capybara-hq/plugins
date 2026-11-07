import { assertValidDeclarations, isModelError } from "@capybara-hq/plugin-sdk";
import {
  type FakeModelServer,
  type FakeResponse,
  startFakeModelServer,
} from "@capybara-hq/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createArkProvider } from "../src/index.js";
import { DEEPSEEK, EMBED, errorJson, MODELS_BODY, SEED } from "./fixtures.js";

describe("ark listModels", () => {
  let server: FakeModelServer;
  let next: () => FakeResponse;
  beforeAll(async () => {
    server = await startFakeModelServer(() => next());
  });
  afterAll(async () => {
    await server?.stop();
  });
  const provider = () =>
    createArkProvider({ apiKey: "ark-default", baseUrl: `${server.url}/api/v3` });

  it("lists the data plane's /models with the inference key", async () => {
    next = () => ({ status: 200, json: MODELS_BODY });
    const before = server.requests.length;
    const models = await provider().listModels();
    const r = server.requests.at(-1);
    expect(server.requests.length).toBe(before + 1);
    expect(r?.path).toBe("/api/v3/models");
    expect(r?.headers.authorization).toBe("Bearer ark-default");
    expect(models.map((m) => [m.id, m.kind])).toEqual([
      ["kimi-k3-1-pro-261024", "chat"],
      [SEED, "chat"],
      [DEEPSEEK, "chat"],
      ["glm-5-3-flash-260828", "chat"],
      ["doubao-seed-character-251128", "chat"],
      ["mystery-chat-260101", "chat"],
      [EMBED, "embedding"],
      ["doubao-embedding-vision-250615", "embedding"],
      ["doubao-seedream-5-0-flash-260915", "image_generation"],
      ["doubao-seedance-2-5-260628", "video_generation"],
    ]);
    for (const m of models)
      expect(() => assertValidDeclarations("ark", m.parameters)).not.toThrow();
  });

  it("maps limits, capabilities and parameters per model", async () => {
    next = () => ({ status: 200, json: MODELS_BODY });
    const models = await provider().listModels();
    const by = (id: string) => models.find((m) => m.id === id);

    const seed = by(SEED);
    expect(seed).toMatchObject({
      displayName: "doubao-seed-2-0-lite (260428)",
      publisher: "ByteDance",
      contextWindow: 262144,
      maxOutputTokens: 131072,
      streamIdleTimeoutMs: 300000,
      capabilities: {
        tools: true,
        vision: true,
        documents: true,
        reasoning: true,
        caching: false,
        midConversationSystem: false,
      },
    });
    expect(seed?.parameters.map((p) => p.key)).toEqual(["thinking", "effort", "temperature"]);
    const thinking = seed?.parameters.find((p) => p.key === "thinking");
    expect(thinking?.schema).toEqual({ type: "string", enum: ["off", "on"] });
    expect(thinking?.default).toBeUndefined();
    const effort = seed?.parameters.find((p) => p.key === "effort");
    // `minimal` / `none` are not standard effort levels
    expect(effort?.schema).toEqual({ type: "string", enum: ["low", "medium", "high"] });
    expect(effort?.default).toBe("medium");
    expect(seed?.parameters.find((p) => p.key === "temperature")?.default).toBeUndefined();

    const ds = by(DEEPSEEK);
    expect(ds).toMatchObject({
      publisher: "DeepSeek",
      capabilities: { vision: false, documents: false, reasoning: true, caching: true },
    });
    expect(ds?.parameters.find((p) => p.key === "effort")?.schema).toEqual({
      type: "string",
      enum: ["low", "high", "max"],
    });

    // `max` is the API default for kimi
    expect(by("kimi-k3-1-pro-261024")?.parameters.find((p) => p.key === "effort")?.default).toBe(
      "max",
    );
    expect(by("kimi-k3-1-pro-261024")?.publisher).toBe("Moonshot AI");

    const character = by("doubao-seed-character-251128");
    expect(character).toMatchObject({
      contextWindow: 131072,
      maxOutputTokens: 32768,
      capabilities: { tools: false, reasoning: false, vision: false },
    });
    expect(character?.streamIdleTimeoutMs).toBeUndefined();
    expect(character?.parameters.map((p) => p.key)).toEqual(["temperature"]);

    const mystery = by("mystery-chat-260101");
    expect(mystery).toMatchObject({
      displayName: "mystery-chat",
      contextWindow: 32768,
      maxOutputTokens: 4096,
      capabilities: { tools: false, reasoning: false },
    });
  });

  it("lists the multimodal embedding models with the bundled facts", async () => {
    next = () => ({ status: 200, json: MODELS_BODY });
    const models = await provider().listModels();
    const embed = models.find((m) => m.id === EMBED);
    expect(embed).toMatchObject({
      kind: "embedding",
      embedding: { dimensions: [1024, 2048], defaultDimensions: 2048, maxBatch: 1 },
      parameters: [],
      capabilities: { tools: false, reasoning: false },
    });
    expect(embed?.embedding?.maxInputTokens).toBe(131072);
    const image = models.find((m) => m.kind === "image_generation");
    expect(image).toMatchObject({ contextWindow: 0, maxOutputTokens: 0, parameters: [] });
  });

  it("maps list errors by status and code", async () => {
    const cases: [FakeResponse, string][] = [
      [
        errorJson(401, { code: "AuthenticationError", message: "bad", type: "Unauthorized" }),
        "auth",
      ],
      [
        errorJson(
          429,
          { code: "RateLimitExceeded.EndpointRPMExceeded", message: "slow down" },
          { "retry-after": "2" },
        ),
        "rate_limited",
      ],
      [errorJson(500, { code: "InternalServiceError", message: "boom" }), "server"],
      [{ status: 200, json: { object: "list" } }, "server"],
    ];
    for (const [res, kind] of cases) {
      next = () => res;
      const err = await provider()
        .listModels()
        .catch((e: unknown) => e);
      expect(isModelError(err) && err.kind).toBe(kind);
      if (kind === "rate_limited") expect(isModelError(err) && err.retryAfterMs).toBe(2000);
    }
  });

  it("uses only the org's config when one is passed", async () => {
    next = () => ({ status: 200, json: MODELS_BODY });
    // an org copy without a key: auth, and no request reaches the server
    const before = server.requests.length;
    const err = await provider()
      .listModels({ orgId: "o1", config: { region: "cn-beijing" } })
      .catch((e: unknown) => e);
    expect(isModelError(err) && err.kind).toBe("auth");
    expect(server.requests.length).toBe(before);
    // an invalid config
    const bad = await provider()
      .listModels({ orgId: "o1", config: { apiKey: "k", region: "mars-1" } })
      .catch((e: unknown) => e);
    expect(isModelError(bad) && bad.kind).toBe("invalid_request");
    expect(server.requests.length).toBe(before);
    // the org's key is the one sent
    await provider().listModels({ orgId: "o1", config: { apiKey: "ark-org" } });
    expect(server.requests.at(-1)?.headers.authorization).toBe("Bearer ark-org");
  });

  it("is auth without any key", async () => {
    const err = await createArkProvider({ baseUrl: `${server.url}/api/v3` })
      .listModels()
      .catch((e: unknown) => e);
    expect(isModelError(err) && err.kind).toBe("auth");
  });
});
