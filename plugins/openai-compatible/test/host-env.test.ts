import type { ModelProvider, ModelRequest } from "@capybara-hq/plugin-sdk";
import { type FakeModelServer, startFakeModelServer } from "@capybara-hq/testing";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import plugin from "../src/index.js";
import { chatRoutes } from "./fixtures.js";

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

type SetupCtx = Parameters<typeof plugin.setup>[0];

let server: FakeModelServer;
beforeAll(async () => {
  server = await startFakeModelServer(chatRoutes("generic"));
});
afterAll(async () => {
  await server?.stop();
});
afterEach(() => {
  vi.unstubAllEnvs();
});

function setup(netCalls: string[]): ModelProvider {
  let provided: ModelProvider | undefined;
  const ctx = {
    config: {},
    net: {
      fetch: (url: string, init?: RequestInit) => {
        netCalls.push(url);
        return fetch(url, init);
      },
    },
    log: { debug() {}, info() {}, warn() {}, error() {} },
    provide: (_point: string, impl: ModelProvider) => {
      provided = impl;
    },
  } as unknown as SetupCtx;
  plugin.setup(ctx);
  if (provided === undefined) throw new Error("setup provided no model provider");
  return provided;
}

const req: ModelRequest = {
  model: "own/m",
  system: [],
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  tools: [],
  maxOutputTokens: 256,
  params: {},
};

describe("openai-compatible: host environment", () => {
  for (const apiKeys of [{ own: "sk-org" }, {}]) {
    const keyed = "own" in apiKeys;
    it(`an org-URL request carries no OPENAI_* host value (${keyed ? "with" : "without"} a key)`, async () => {
      for (const [k, v] of Object.entries(HOST_ENV)) vi.stubEnv(k, v);
      const netCalls: string[] = [];
      const p = setup(netCalls);
      const own = {
        name: "own",
        baseUrl: `${server.url}/v1`,
        dialect: "generic",
        models: [{ id: "m", contextWindow: 128_000, maxOutputTokens: 8192 }],
      };
      const before = server.requests.length;
      for await (const _ of p.stream(req, {
        signal: new AbortController().signal,
        orgId: "org-1",
        config: { endpoints: [own], apiKeys },
      })) {
        // drain
      }
      expect(netCalls.length).toBeGreaterThan(0);
      const sent = server.requests.slice(before);
      expect(sent.length).toBeGreaterThan(0);
      for (const r of sent) {
        expect(r.headers.authorization).toBe(keyed ? "Bearer sk-org" : undefined);
        expect(r.headers["openai-organization"]).toBeUndefined();
        expect(r.headers["openai-project"]).toBeUndefined();
        expect(r.headers["x-host-secret"]).toBeUndefined();
        expect(JSON.stringify(r.headers)).not.toContain("host-env");
      }
    });
  }
});
