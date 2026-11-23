import type { ModelRequest } from "@capybara-hq/plugin-sdk";
import { type FakeModelServer, startFakeModelServer } from "@capybara-hq/testing";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createArkProvider } from "../src/index.js";
import { arkRoutes, SEED } from "./fixtures.js";

/**
 * The `openai` SDK defaults options to OPENAI_* env vars and merges OPENAI_CUSTOM_HEADERS into
 * every request. Ark's data plane is a fixed vendor host, but no host value is sent to it either.
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
  server = await startFakeModelServer(arkRoutes());
});
afterAll(async () => {
  await server?.stop();
});
afterEach(() => {
  vi.unstubAllEnvs();
});

const req: ModelRequest = {
  model: SEED,
  system: [],
  messages: [{ role: "user", content: [{ type: "text", text: "Hi" }] }],
  tools: [],
  maxOutputTokens: 256,
  params: {},
};

describe("ark: host environment", () => {
  it("an org's chat request carries no OPENAI_* host value", async () => {
    for (const [k, v] of Object.entries(HOST_ENV)) vi.stubEnv(k, v);
    const p = createArkProvider({ apiKey: "ark-platform", baseUrl: `${server.url}/api/v3` });
    const before = server.requests.length;
    for await (const _ of p.stream(req, {
      signal: new AbortController().signal,
      orgId: "org-1",
      config: { apiKey: "ark-fixture" },
    })) {
      // drain
    }
    const sent = server.requests.slice(before);
    expect(sent.length).toBeGreaterThan(0);
    for (const r of sent) {
      expect(r.headers.authorization).toBe("Bearer ark-fixture");
      expect(r.headers["openai-organization"]).toBeUndefined();
      expect(r.headers["openai-project"]).toBeUndefined();
      expect(r.headers["x-host-secret"]).toBeUndefined();
      expect(JSON.stringify(r.headers)).not.toContain("host-env");
    }
  });
});
