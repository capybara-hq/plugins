import { fileURLToPath } from "node:url";
import {
  createDb,
  createLocalAccount,
  createOrg,
  type FakeModelServer,
  type KernelRequest,
  kernelDb,
  login,
  startFakeModelServer,
  startTestKernel,
  startTestPostgres,
  startTestRedis,
  type TestContainer,
  type TestKernel,
  testKernelConfig,
} from "@capybara-hq/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MODELS_BODY } from "./fixtures.js";

/**
 * deepseek in a real kernel without a platform key: the extension loads (the kernel's load gate
 * makes the required overridable key optional for the platform), an org following the platform
 * needs configuration and lists nothing (no request leaves), and an org copy with its own key
 * lists the models with that key.
 */

const PLUGIN_DIR = fileURLToPath(new URL("../", import.meta.url));
const DEEPSEEK = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const MODEL_FAKE = "@capybara-hq/plugin-model-fake";

let pgc: TestContainer;
let rd: TestContainer;
let fake: FakeModelServer;
let k: TestKernel;
let raw: ReturnType<typeof createDb>;

beforeAll(async () => {
  fake = await startFakeModelServer((req) =>
    req.path.endsWith("/models")
      ? { status: 200, json: MODELS_BODY }
      : { status: 404, json: { error: { message: "not found" } } },
  );
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  k = await startTestKernel(
    testKernelConfig(
      { pg: pgc.url, redis: rd.url },
      { extensions: [MODEL_FAKE, DEEPSEEK], roles: ["api", "worker"] },
    ),
    { resolveFrom: PLUGIN_DIR },
  );
  raw = createDb(pgc.url, 3);
}, 120_000);

afterAll(async () => {
  await k?.close();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop(), fake?.stop()]);
});

describe("deepseek without a key", () => {
  it("needs configuration in an org until the org brings its own key", async () => {
    await createLocalAccount(kernelDb(raw), "owner");
    const owner = await login(k, "owner");
    const orgId = await createOrg(owner);
    const enabled = await owner({
      method: "PUT",
      url: `/api/v1/orgs/${orgId}/extensions/deepseek`,
      payload: { enabled: true },
    });
    expect(enabled.statusCode, enabled.body).toBe(200);

    // following the platform, which has no key: needs configuration, not listed, nothing sent
    expect(await extensionView(owner, orgId)).toMatchObject({
      available: true,
      needsConfig: true,
    });
    expect(await providers(owner, orgId)).not.toContain("deepseek");
    expect(fake.requests).toHaveLength(0);

    // the org's own copy with its key: configured, listed with the org's key
    const saved = await owner({
      method: "PUT",
      url: `/api/v1/orgs/${orgId}/extensions/deepseek/overrides`,
      payload: { values: { apiKey: "sk-org-1", baseUrl: fake.url } },
    });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(await extensionView(owner, orgId)).toMatchObject({ needsConfig: false });
    expect(await providers(owner, orgId)).toContain("deepseek");
    expect(fake.requests.at(-1)?.headers.authorization).toBe("Bearer sk-org-1");
  }, 120_000);
});

async function extensionView(owner: KernelRequest, orgId: string) {
  const res = await owner({ method: "GET", url: `/api/v1/orgs/${orgId}/extensions` });
  expect(res.statusCode, res.body).toBe(200);
  const list = (res.json() as { extensions: { plugin: string }[] }).extensions;
  return list.find((e) => e.plugin === "deepseek");
}

async function providers(owner: KernelRequest, orgId: string): Promise<string[]> {
  const res = await owner({ method: "GET", url: `/api/v1/orgs/${orgId}/models` });
  expect(res.statusCode, res.body).toBe(200);
  return (res.json() as { providers: { provider: string }[] }).providers.map((p) => p.provider);
}
