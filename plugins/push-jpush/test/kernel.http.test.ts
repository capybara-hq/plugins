import { fileURLToPath } from "node:url";
import {
  createAgent,
  createConversation,
  createDb,
  createLocalAccount,
  createOrg,
  enableModelProviders,
  kernelDb,
  login,
  postMessage,
  startTestKernel,
  startTestPostgres,
  startTestRedis,
  type TestContainer,
  type TestKernel,
  testKernelConfig,
  waitFor,
  waitForTerminal,
} from "@capybara-hq/testing";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { type FakeJPush, startFakeJPush } from "./fake-jpush.js";

/**
 * push-jpush through a real kernel (one in-process kernel, model-fake finishing a run): a person
 * posts a JPush registration, a run of theirs finishes, and exactly one push reaches JPush (a local
 * fake). The plugin always calls `https://api.jpush.cn`; this file routes that host to the fake by
 * wrapping the process's global fetch, so no test address appears in the admin config schema.
 */

const PLUGIN_DIR = fileURLToPath(new URL("../", import.meta.url));
const PUSH_JPUSH = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const MODEL_FAKE = "@capybara-hq/plugin-model-fake";
const TOKEN = "1a0018970af5e4a8a8b";

let pgc: TestContainer;
let rd: TestContainer;
let fake: FakeJPush;
let k: TestKernel;
let raw: ReturnType<typeof createDb>;

beforeAll(async () => {
  fake = await startFakeJPush();
  const realFetch = globalThis.fetch;
  vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    return url.startsWith("https://api.jpush.cn/")
      ? realFetch(fake.url + url.slice("https://api.jpush.cn".length), init)
      : realFetch(input, init);
  });
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  k = await startTestKernel(
    testKernelConfig(
      { pg: pgc.url, redis: rd.url },
      {
        extensions: [MODEL_FAKE, PUSH_JPUSH],
        roles: ["api", "worker"],
        http: { port: 0, publicUrl: "https://cap.example" },
        extensionConfig: {
          "push-jpush": {
            appKey: fake.appKey,
            masterSecret: fake.masterSecret,
            applicationIds: ["com.example.app"],
          },
        },
      },
    ),
    { resolveFrom: PLUGIN_DIR },
  );
  raw = createDb(pgc.url, 3);
});

afterAll(async () => {
  await k?.close();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop(), fake?.stop()]);
  vi.unstubAllGlobals();
});

describe("push-jpush in a kernel", () => {
  it("a finished run of a registered person sends one push to JPush", async () => {
    const db = kernelDb(raw);
    await createLocalAccount(db, "owner");
    const owner = await login(k, "owner");
    const reg = await owner({
      method: "POST",
      url: "/api/v1/me/push-registrations",
      payload: {
        platform: "android",
        appId: "com.example.app",
        provider: "push-jpush",
        token: TOKEN,
        locale: "en",
        deviceName: "Phone",
      },
    });
    expect(reg.statusCode, reg.body).toBeLessThan(300);
    expect(reg.body).not.toContain(TOKEN);

    const orgId = await createOrg(owner);
    await enableModelProviders(owner, orgId, ["model-fake"]);
    const agentId = await createAgent(owner, orgId);
    const convId = await createConversation(owner, orgId, agentId);
    await postMessage(owner, orgId, convId, "echo:hello");
    const [end] = await waitForTerminal(db, convId, 1);
    expect(end?.type).toBe("run_finished");

    const [sent] = await waitFor(
      async () => (fake.vendorRequests().length > 0 ? fake.vendorRequests() : null),
      undefined,
      "a push at the fake JPush",
    );
    expect(sent?.token).toBe(TOKEN);
    expect(sent?.origin).toBe("https://cap.example");
    expect(sent?.path).toContain(convId);
    expect(sent?.threadId).toBe(convId);
    const push = fake.requests.find((r) => r.path === "/v3/push");
    expect(push?.authorization).toBe(
      `Basic ${Buffer.from(`${fake.appKey}:${fake.masterSecret}`).toString("base64")}`,
    );
    expect(fake.vendorRequests()).toHaveLength(1);
  });
});
