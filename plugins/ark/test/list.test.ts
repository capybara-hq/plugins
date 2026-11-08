import { assertValidDeclarations, isModelError } from "@capybara-hq/plugin-sdk";
import {
  type FakeModelServer,
  type FakeRequest,
  type FakeResponse,
  startFakeModelServer,
} from "@capybara-hq/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import extension, { createArkProvider } from "../src/index.js";
import { signV4 } from "../src/sign.js";
import {
  DEEPSEEK,
  EMBED,
  endpointItem,
  endpointsPage,
  errorJson,
  MODELS_BODY,
  SEED,
} from "./fixtures.js";

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

describe("ark listModels with management keys (inference endpoints)", () => {
  let data: FakeModelServer;
  let control: FakeModelServer;
  let controlNext: (path: string, body: unknown) => FakeResponse;
  const NOW = new Date("2026-11-08T01:02:03Z");
  const warnings: { msg: string; fields?: Record<string, unknown> }[] = [];
  const MGMT = { accessKeyId: "AKLTSETUP", secretAccessKey: "setup-secret" };

  beforeAll(async () => {
    data = await startFakeModelServer(() => ({ status: 200, json: MODELS_BODY }));
    control = await startFakeModelServer((r) => controlNext(r.path, r.body));
  });
  afterAll(async () => {
    await data?.stop();
    await control?.stop();
  });
  const provider = (management: typeof MGMT | null = MGMT) =>
    createArkProvider({
      apiKey: "ark-default",
      baseUrl: `${data.url}/api/v3`,
      controlPlaneUrl: control.url,
      ...(management !== null ? { management } : {}),
      now: () => NOW,
      log: { warn: (msg, fields) => warnings.push({ msg, ...(fields ? { fields } : {}) }) },
    });

  /** Recomputes the signature the way the control plane checks it. */
  const expectSigned = (r: FakeRequest | undefined, mgmt: typeof MGMT, region = "cn-beijing") => {
    const url = new URL(r?.path ?? "/", control.url);
    const signed = signV4({
      method: "POST",
      host: url.host,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      body: JSON.stringify(r?.body),
      accessKeyId: mgmt.accessKeyId,
      secretAccessKey: mgmt.secretAccessKey,
      region,
      service: "ark",
      now: NOW,
    });
    expect(r?.headers.authorization).toBe(signed.headers.authorization);
  };

  it("lists the running chat endpoints with their foundation model's info, every page", async () => {
    const many = Array.from({ length: 100 }, (_, i) =>
      endpointItem(`ep-gone-${i}`, `gone-${i}`, { name: "retired-model", version: "240101" }),
    );
    controlNext = (_path, body) =>
      (body as { PageNumber: number }).PageNumber === 1
        ? endpointsPage(many, 104)
        : endpointsPage(
            [
              endpointItem("ep-20260228102317-zgmls", "deepseek-v3.2", {
                name: "deepseek-v4-flash-ga",
                version: "260731",
              }),
              endpointItem(
                "ep-stopped",
                "off",
                { name: "deepseek-v4-flash-ga", version: "260731" },
                "Stopped",
              ),
              endpointItem("ep-embed", "embedding", {
                name: "doubao-embedding-vision",
                version: "251215",
              }),
              endpointItem("ep-custom", "custom", null),
            ],
            104,
            2,
          );
    warnings.length = 0;
    const before = control.requests.length;
    const models = await provider().listModels();
    const calls = control.requests.slice(before);
    expect(calls.map((c) => [c.path, c.body])).toEqual([
      ["/?Action=ListEndpoints&Version=2024-01-01", { PageNumber: 1, PageSize: 100 }],
      ["/?Action=ListEndpoints&Version=2024-01-01", { PageNumber: 2, PageSize: 100 }],
    ]);
    for (const c of calls) expectSigned(c, MGMT);
    const ds = models.find((m) => m.id === DEEPSEEK);
    const ep = models.find((m) => m.id === "ep-20260228102317-zgmls");
    expect(ep).toMatchObject({
      displayName: "deepseek-v3.2 (deepseek-v4-flash-ga (260731))",
      kind: "chat",
      contextWindow: ds?.contextWindow,
      maxOutputTokens: ds?.maxOutputTokens,
      capabilities: ds?.capabilities,
    });
    // the endpoint may set its own inference defaults: no declared defaults
    expect(ep?.parameters.map((p) => p.key)).toEqual(ds?.parameters.map((p) => p.key));
    expect(ep?.parameters.some((p) => p.default !== undefined)).toBe(false);
    for (const id of ["ep-stopped", "ep-embed", "ep-custom", "ep-gone-0"]) {
      expect(models.some((m) => m.id === id)).toBe(false);
    }
    // one warn per endpoint whose foundation model is unknown (100 gone + the custom model)
    expect(warnings.filter((w) => w.msg.includes("foundation model")).length).toBe(101);
  });

  it("lists no endpoints without management keys", async () => {
    const before = control.requests.length;
    const models = await provider(null).listModels();
    expect(control.requests.length).toBe(before);
    expect(models.some((m) => m.id.startsWith("ep-"))).toBe(false);
  });

  it("never signs with the setup AK/SK for an org config; an org's own keys sign its calls", async () => {
    controlNext = () => endpointsPage([], 0);
    const before = control.requests.length;
    await provider().listModels({
      orgId: "o1",
      config: { apiKey: "ark-org", region: "cn-shanghai" },
    });
    expect(control.requests.length).toBe(before);
    const org = { accessKeyId: "AKLTORG", secretAccessKey: "org-secret" };
    await provider().listModels({
      orgId: "o1",
      config: { apiKey: "ark-org", region: "cn-shanghai", management: org },
    });
    expect(control.requests.length).toBe(before + 1);
    expect(control.requests.at(-1)?.headers.authorization).toContain("Credential=AKLTORG/");
    expectSigned(control.requests.at(-1), org, "cn-shanghai");
  });

  it("pages until a short page when TotalCount is missing", async () => {
    const full = Array.from({ length: 100 }, (_, i) =>
      endpointItem(`ep-full-${i}`, `full-${i}`, { name: "retired-model", version: "240101" }),
    );
    const noTotal = (items: unknown[]): FakeResponse => ({
      status: 200,
      json: { ResponseMetadata: { RequestId: "fixture" }, Result: { Items: items } },
    });
    controlNext = (_path, body) =>
      (body as { PageNumber: number }).PageNumber === 1
        ? noTotal(full)
        : noTotal([
            endpointItem("ep-last", "last", { name: "deepseek-v4-flash-ga", version: "260731" }),
          ]);
    const before = control.requests.length;
    const models = await provider().listModels();
    expect(control.requests.slice(before).map((c) => c.body)).toEqual([
      { PageNumber: 1, PageSize: 100 },
      { PageNumber: 2, PageSize: 100 },
    ]);
    expect(models.map((m) => m.id)).toContain("ep-last");
  });

  it("marks both management fields secret, so an org copy starts without the pair", async () => {
    // The kernel's secret leaves: wrappers unwrapped, objects expanded, a secret object
    // marking every leaf under it (kernel config/fields.js configFields).
    const WRAPPERS = new Set(["default", "prefault", "optional", "nullable", "readonly", "catch"]);
    const secretLeaves = (schema: z.ZodType, prefix = "", inherited = false): string[] => {
      let node = schema as z.ZodType;
      let meta = z.globalRegistry.get(node);
      while (WRAPPERS.has(node._zod.def.type)) {
        node = (node._zod.def as unknown as { innerType: z.ZodType }).innerType;
        meta ??= z.globalRegistry.get(node);
      }
      const secret = inherited || meta?.secret === true;
      if (node._zod.def.type === "object") {
        const shape = (node._zod.def as unknown as { shape: Record<string, z.ZodType> }).shape;
        return Object.entries(shape).flatMap(([k, v]) =>
          secretLeaves(v, prefix ? `${prefix}.${k}` : k, secret),
        );
      }
      return secret ? [prefix] : [];
    };
    const schema = extension.config?.deployment as z.ZodType;
    const secrets = secretLeaves(schema);
    expect(secrets).toEqual(
      expect.arrayContaining(["apiKey", "management.accessKeyId", "management.secretAccessKey"]),
    );

    // A copy is the platform's override values with every secret leaf removed (kernel
    // platformOverrideValues); an emptied object goes away.
    const platform: Record<string, unknown> = {
      apiKey: "ark-platform",
      region: "cn-shanghai",
      management: { ...MGMT },
    };
    const copy = structuredClone(platform);
    for (const path of secrets) {
      const [head, leaf] = path.split(".");
      if (head === undefined) continue;
      if (leaf === undefined) {
        delete copy[head];
        continue;
      }
      const obj = copy[head] as Record<string, unknown> | undefined;
      if (obj === undefined) continue;
      delete obj[leaf];
      if (Object.keys(obj).length === 0) delete copy[head];
    }
    expect(copy).toEqual({ region: "cn-shanghai" });

    // The org enters only its own key: the models list with it, and nothing is signed.
    const before = control.requests.length;
    const dataBefore = data.requests.length;
    const models = await provider().listModels({
      orgId: "o1",
      config: { ...copy, apiKey: "ark-org" },
    });
    expect(control.requests.length).toBe(before);
    expect(data.requests.at(-1)?.headers.authorization).toBe("Bearer ark-org");
    expect(data.requests.length).toBe(dataBefore + 1);
    expect(models.some((m) => m.id.startsWith("ep-"))).toBe(false);
  });

  it("a ListEndpoints failure still lists the models, with a warning", async () => {
    warnings.length = 0;
    controlNext = () => ({
      status: 403,
      json: {
        ResponseMetadata: {
          RequestId: "fixture",
          Error: {
            Code: "AccessDenied",
            Message: "User is not authorized to perform: ark:ListEndpoints",
          },
        },
      },
    });
    const models = await provider().listModels();
    expect(models.map((m) => m.id)).toContain(SEED);
    expect(models.some((m) => m.id.startsWith("ep-"))).toBe(false);
    expect(warnings.map((w) => w.msg)).toEqual([
      "ark: listing inference endpoints failed; listing the models only",
    ]);
    expect(String(warnings[0]?.fields?.error)).toContain("AccessDenied");
    // an error inside a 200 body counts too
    warnings.length = 0;
    controlNext = () => ({
      status: 200,
      json: { ResponseMetadata: { Error: { Code: "InternalError", Message: "boom" } } },
    });
    expect((await provider().listModels()).length).toBe(models.length);
    expect(warnings).toHaveLength(1);
  });
});
