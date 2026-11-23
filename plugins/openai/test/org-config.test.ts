import { isModelError, type ModelRequest, type ModelStreamEvent } from "@capybara-hq/plugin-sdk";
import { type FakeModelServer, startFakeModelServer } from "@capybara-hq/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import plugin, { createOpenAIProvider } from "../src/index.js";
import { openaiRoutes, refusingNetFetch } from "./fixtures.js";

const model = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  contextWindow: 400_000,
  maxOutputTokens: 128_000,
  reasoning: true,
  vision: true,
  ...over,
});

const req = (over: Partial<ModelRequest> = {}): ModelRequest => ({
  model: "org-model",
  system: [{ text: "Be brief.", cache: false }],
  messages: [{ role: "user", content: [{ type: "text", text: "Hi" }] }],
  tools: [],
  maxOutputTokens: 256,
  params: {},
  ...over,
});

const signal = new AbortController().signal;
async function drain(it: AsyncIterable<ModelStreamEvent>): Promise<ModelStreamEvent[]> {
  const out: ModelStreamEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}
const failure = async (p: Promise<unknown>) =>
  p.then(
    () => undefined,
    (e: unknown) => e,
  );

let server: FakeModelServer;
beforeAll(async () => {
  server = await startFakeModelServer(openaiRoutes());
});
afterAll(async () => {
  await server?.stop();
});

describe("openai: org-overridable config", () => {
  it("setup with an empty platform config does not throw", () => {
    const provided: unknown[] = [];
    const ctx = {
      config: {},
      log: { warn() {} },
      net: { fetch: refusingNetFetch },
      provide: (_point: string, impl: unknown) => provided.push(impl),
    };
    expect(() => plugin.setup?.(ctx as never)).not.toThrow();
    expect(provided).toHaveLength(1);
  });

  it("an org config without an API key is auth before any request, never the platform key", async () => {
    const before = server.requests.length;
    const p = createOpenAIProvider({
      apiKey: "sk-platform",
      baseUrl: `${server.url}/v1`,
      models: [model("platform-model")],
      netFetch: refusingNetFetch,
    });
    const config = { baseUrl: `${server.url}/v1`, models: [model("org-model")] };
    for (const run of [
      () => p.listModels({ config }),
      () => drain(p.stream(req(), { signal, config })),
    ]) {
      const e = await failure(run());
      expect(isModelError(e) && e.kind).toBe("auth");
    }
    expect(server.requests.length).toBe(before);
  });

  it("refuses an org base URL on a private address through the injected net fetch", async () => {
    const seen: string[] = [];
    const p = createOpenAIProvider({
      apiKey: "sk-platform",
      baseUrl: `${server.url}/v1`,
      models: [],
      netFetch: async (url) => {
        seen.push(String(url));
        throw new Error("net.private_address");
      },
    });
    const config = { apiKey: "sk-org", baseUrl: "http://10.0.0.1", models: [model("org-model")] };
    const e = await failure(drain(p.stream(req(), { signal, config, orgId: "org-1" })));
    expect(isModelError(e)).toBe(true);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[0]).toContain("http://10.0.0.1");
  });

  it("uses the org's key, models, organization, summary setting and image models", async () => {
    const platformUrl = `${server.url}/v1`;
    const p = createOpenAIProvider({
      apiKey: "sk-platform",
      baseUrl: platformUrl,
      models: [model("platform-model")],
      netFetch: refusingNetFetch,
    });
    const config = {
      apiKey: "sk-org",
      baseUrl: platformUrl,
      organization: "org_acme",
      models: [model("org-model")],
      reasoningSummary: "off",
      imageModels: ["gpt-image-1-mini"],
    };
    const listed = await p.listModels({ config, orgId: "org-1" });
    expect(listed.map((m) => m.id)).toEqual(["org-model", "gpt-image-1-mini"]);
    // reasoningSummary "off": no `thinking` parameter is declared
    expect(listed[0]?.parameters.map((x) => x.key)).toEqual(["effort"]);

    server.requests.length = 0;
    const events = await drain(p.stream(req(), { signal, config, orgId: "org-1" }));
    expect(events.at(-1)?.type).toBe("message_complete");
    expect(server.requests[0]?.headers.authorization).toBe("Bearer sk-org");
    expect(server.requests[0]?.headers["openai-organization"]).toBe("org_acme");
    const sent = server.requests[0]?.body as { reasoning?: { summary?: string } } | undefined;
    expect(sent?.reasoning?.summary).toBeUndefined();

    const img = await p.generateImage?.(
      {
        model: "gpt-image-1-mini",
        prompt: "a red square",
        size: { width: 1024, height: 1024 },
        n: 1,
        params: {},
      },
      { signal, config, orgId: "org-1" },
    );
    expect(img?.images).toHaveLength(1);
    expect(server.requests.at(-1)?.headers.authorization).toBe("Bearer sk-org");

    // The platform's own model is not the org's
    const e = await failure(drain(p.stream(req({ model: "platform-model" }), { signal, config })));
    expect(isModelError(e) && e.kind).toBe("invalid_request");
  });

  it("an invalid org config is invalid_request", async () => {
    const p = createOpenAIProvider({ netFetch: refusingNetFetch });
    const e = await failure(p.listModels({ config: { apiKey: "sk", baseUrl: "not a url" } }));
    expect(isModelError(e) && e.kind).toBe("invalid_request");
  });
});
