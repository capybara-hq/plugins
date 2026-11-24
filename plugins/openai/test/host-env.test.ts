import type { ModelRequest } from "@capybara-hq/plugin-sdk";
import { type FakeModelServer, startFakeModelServer } from "@capybara-hq/testing";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createOpenAIProvider } from "../src/index.js";
import { isolatedOpenAI } from "../src/openai-client.js";
import { openaiRoutes } from "./fixtures.js";

/**
 * The `openai` SDK defaults options to OPENAI_* env vars and merges OPENAI_CUSTOM_HEADERS into
 * every request. An org may point the provider at its own URL, so no host value may reach it.
 */
const HOST_ENV = {
  OPENAI_API_KEY: "sk-host-env",
  OPENAI_ADMIN_KEY: "sk-admin-host-env",
  OPENAI_ORG_ID: "org-host-env",
  OPENAI_PROJECT_ID: "proj-host-env",
  OPENAI_WEBHOOK_SECRET: "whsec-host-env",
  OPENAI_BASE_URL: "http://host-env.invalid/v1",
  OPENAI_CUSTOM_HEADERS: "X-Host-Secret: host-env-secret\nAuthorization: Bearer sk-custom-host-env",
};

let server: FakeModelServer;
beforeAll(async () => {
  server = await startFakeModelServer(openaiRoutes());
});
afterAll(async () => {
  await server?.stop();
});
afterEach(() => {
  vi.unstubAllEnvs();
});

const req: ModelRequest = {
  model: "org-model",
  system: [],
  messages: [{ role: "user", content: [{ type: "text", text: "Hi" }] }],
  tools: [],
  maxOutputTokens: 256,
  params: {},
};

describe("openai: host environment", () => {
  it("an org-URL request carries no OPENAI_* host value", async () => {
    for (const [k, v] of Object.entries(HOST_ENV)) vi.stubEnv(k, v);
    const netCalls: string[] = [];
    const p = createOpenAIProvider({
      apiKey: "sk-platform",
      baseUrl: "https://api.openai.com/v1",
      models: [],
      netFetch: (url, init) => {
        netCalls.push(String(url));
        return fetch(url, init);
      },
    });
    const config = {
      apiKey: "sk-org",
      baseUrl: `${server.url}/v1`,
      models: [
        {
          id: "org-model",
          contextWindow: 400_000,
          maxOutputTokens: 128_000,
          reasoning: true,
          vision: true,
        },
      ],
    };
    const before = server.requests.length;
    for await (const _ of p.stream(req, {
      signal: new AbortController().signal,
      config,
      orgId: "org-1",
    })) {
      // drain
    }
    expect(netCalls.length).toBeGreaterThan(0);
    const sent = server.requests.slice(before);
    expect(sent.length).toBeGreaterThan(0);
    for (const r of sent) {
      expect(r.headers.authorization).toBe("Bearer sk-org");
      expect(r.headers["openai-organization"]).toBeUndefined();
      expect(r.headers["openai-project"]).toBeUndefined();
      expect(r.headers["x-host-secret"]).toBeUndefined();
      expect(JSON.stringify(r.headers)).not.toContain("host-env");
    }
  });

  it("an explicit undefined option does not bring back the SDK's env default", async () => {
    for (const [k, v] of Object.entries(HOST_ENV)) vi.stubEnv(k, v);
    const client = isolatedOpenAI({
      apiKey: "sk-org",
      baseURL: `${server.url}/v1`,
      organization: undefined,
      project: undefined,
      adminAPIKey: undefined,
      webhookSecret: undefined,
      maxRetries: 0,
    });
    expect(client.organization).toBeNull();
    expect(client.project).toBeNull();
    expect(client.adminAPIKey).toBeNull();
    expect(client.webhookSecret).toBeNull();
    const before = server.requests.length;
    await client.models.list().catch(() => undefined);
    const sent = server.requests.slice(before);
    expect(sent.length).toBeGreaterThan(0);
    for (const r of sent) {
      expect(r.headers["openai-organization"]).toBeUndefined();
      expect(r.headers["openai-project"]).toBeUndefined();
      expect(JSON.stringify(r.headers)).not.toContain("host-env");
    }
  });

  it("refuses an empty API key or base URL instead of reading OPENAI_* env vars", () => {
    for (const [k, v] of Object.entries(HOST_ENV)) vi.stubEnv(k, v);
    expect(() => isolatedOpenAI({ apiKey: "", baseURL: `${server.url}/v1` })).toThrow(
      "apiKey must be a non-empty string",
    );
    expect(() =>
      isolatedOpenAI({ apiKey: "sk-org", baseURL: undefined as unknown as string }),
    ).toThrow("baseURL must be a non-empty string");
  });
});
