import type { ModelRequest } from "@capybara-hq/plugin-sdk";
import { type FakeModelServer, startFakeModelServer } from "@capybara-hq/testing";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createDeepSeekProvider } from "../src/index.js";
import { deepseekRoutes, recordingNet } from "./fixtures.js";

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
  server = await startFakeModelServer(deepseekRoutes());
});
afterAll(async () => {
  await server?.stop();
});
afterEach(() => {
  vi.unstubAllEnvs();
});

const req: ModelRequest = {
  model: "deepseek-flash",
  system: [],
  messages: [{ role: "user", content: [{ type: "text", text: "Hi" }] }],
  tools: [],
  maxOutputTokens: 256,
  params: {},
};

describe("deepseek: host environment", () => {
  it("an org-URL request carries no OPENAI_* host value", async () => {
    for (const [k, v] of Object.entries(HOST_ENV)) vi.stubEnv(k, v);
    const net = recordingNet();
    const p = createDeepSeekProvider({ netFetch: net.netFetch, apiKey: "sk-platform" });
    const before = server.requests.length;
    for await (const _ of p.stream(req, {
      signal: new AbortController().signal,
      orgId: "org-1",
      config: { apiKey: "sk-org", baseUrl: server.url },
    })) {
      // drain
    }
    expect(net.calls.length).toBeGreaterThan(0);
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
});
