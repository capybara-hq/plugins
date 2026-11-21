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
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type FakeFcm, startFakeFcm } from "./fake-fcm.js";

/**
 * push-fcm through a real kernel (one in-process kernel, api + worker): a person registers an
 * Android device for the plugin, a model-fake run in their chat conversation finishes, and the
 * kernel's push fanout delivers exactly one FCM v1 request to the local fake for that device, with
 * the run's conversation as the thread.
 */

const PLUGIN_DIR = fileURLToPath(new URL("../", import.meta.url));
const FCM = fileURLToPath(new URL("./fixtures/local-fcm.ts", import.meta.url));
const MODEL_FAKE = "@capybara-hq/plugin-model-fake";
const APP_ID = "com.example.app";
const DEVICE_TOKEN = "fcm-device-token-kernel-1";

let pgc: TestContainer;
let rd: TestContainer;
let fake: FakeFcm;
let k: TestKernel;
let raw: ReturnType<typeof createDb>;

beforeAll(async () => {
  fake = await startFakeFcm();
  process.env.CAPYBARA_PUSH_FCM_FAKE_BASE = fake.apiBase;
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  k = await startTestKernel(
    testKernelConfig(
      { pg: pgc.url, redis: rd.url },
      {
        extensions: [MODEL_FAKE, FCM],
        roles: ["api", "worker"],
        http: { port: 0, publicUrl: "https://cap.example" },
        extensionConfig: {
          "push-fcm": { serviceAccount: fake.serviceAccount, applicationIds: [APP_ID] },
        },
      },
    ),
    { resolveFrom: PLUGIN_DIR },
  );
  raw = createDb(pgc.url, 3);
}, 120_000);

afterAll(async () => {
  await k?.close();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop(), fake?.close()]);
  delete process.env.CAPYBARA_PUSH_FCM_FAKE_BASE;
});

describe("push-fcm in a kernel", () => {
  it("a finished run pushes one FCM request to the registered device", async () => {
    const db = kernelDb(raw);
    await createLocalAccount(db, "owner");
    const owner = await login(k, "owner");

    const reg = await owner({
      method: "POST",
      url: "/api/v1/me/push-registrations",
      payload: {
        platform: "android",
        appId: APP_ID,
        provider: "push-fcm",
        token: DEVICE_TOKEN,
        locale: "en",
        deviceName: "Pixel",
      },
    });
    expect(reg.statusCode, reg.body).toBeLessThan(300);
    expect(reg.body).not.toContain(DEVICE_TOKEN);

    const orgId = await createOrg(owner);
    await enableModelProviders(owner, orgId, ["model-fake"]);
    const agentId = await createAgent(owner, orgId);
    const convId = await createConversation(owner, orgId, agentId);
    await postMessage(owner, orgId, convId, "echo:hello push");
    const [end] = await waitForTerminal(db, convId, 1, 30_000);
    expect(end?.type).toBe("run_finished");

    await waitFor(async () => fake.sends.length >= 1 || undefined, 30_000, "an FCM send");
    expect(fake.tokens).toHaveLength(1);
    expect(fake.sends).toHaveLength(1);
    const [req] = fake.requests();
    expect(req).toMatchObject({
      token: DEVICE_TOKEN,
      threadId: convId,
      origin: "https://cap.example",
    });
    expect(req?.path).toContain(`/chat/${convId}`);
    expect(req?.collapseId).toMatch(/^[A-Za-z0-9._-]{1,64}$/);
    expect(fake.sends[0]?.projectId).toBe(fake.projectId);
  });
});
