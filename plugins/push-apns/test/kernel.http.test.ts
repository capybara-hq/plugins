import { verify } from "node:crypto";
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
import { type FakeApns, startFakeApns } from "./fake-apns.js";
import { decodeJwt, KEY_ID, TEAM_ID, testSigningKey } from "./helpers.js";

/**
 * push-apns through a real kernel (one in-process kernel, api + worker): a person registers an iOS
 * device for the plugin, a model-fake run in their chat conversation finishes, and the kernel's
 * push fanout makes exactly one APNs request at the local fake, signed with the configured key.
 */

const PLUGIN_DIR = fileURLToPath(new URL("../", import.meta.url));
const APNS = fileURLToPath(new URL("./fixtures/local-apns.ts", import.meta.url));
const MODEL_FAKE = "@capybara-hq/plugin-model-fake";
const APP_ID = "com.example.app";
const DEVICE_TOKEN = "a".repeat(64);

let pgc: TestContainer;
let rd: TestContainer;
let fake: FakeApns;
let k: TestKernel;
let raw: ReturnType<typeof createDb>;
const signing = testSigningKey();

beforeAll(async () => {
  fake = await startFakeApns();
  process.env.CAPYBARA_PUSH_APNS_FAKE_ORIGIN = fake.url;
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  k = await startTestKernel(
    testKernelConfig(
      { pg: pgc.url, redis: rd.url },
      {
        extensions: [MODEL_FAKE, APNS],
        roles: ["api", "worker"],
        http: { port: 0, publicUrl: "https://cap.example" },
        extensionConfig: {
          "push-apns": {
            key: signing.pem,
            keyId: KEY_ID,
            teamId: TEAM_ID,
            bundles: [{ bundleId: APP_ID, environment: "production" }],
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
  await Promise.all([pgc?.stop(), rd?.stop(), fake?.close()]);
  delete process.env.CAPYBARA_PUSH_APNS_FAKE_ORIGIN;
});

describe("push-apns in a kernel", () => {
  it("a finished run makes one signed APNs request for the registered device", async () => {
    const db = kernelDb(raw);
    await createLocalAccount(db, "owner");
    const owner = await login(k, "owner");

    const reg = await owner({
      method: "POST",
      url: "/api/v1/me/push-registrations",
      payload: {
        platform: "ios",
        appId: APP_ID,
        provider: "push-apns",
        token: DEVICE_TOKEN,
        locale: "en",
        deviceName: "iPhone",
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

    await waitFor(async () => fake.received.length >= 1 || undefined, 30_000, "an APNs request");
    expect(fake.received).toHaveLength(1);
    const [req] = fake.requests();
    expect(req).toMatchObject({
      token: DEVICE_TOKEN,
      threadId: convId,
      origin: "https://cap.example",
    });
    expect(req?.path).toContain(`/chat/${convId}`);
    expect(req?.collapseId).toMatch(/^[A-Za-z0-9._-]{1,64}$/);
    const headers = fake.received[0]?.headers ?? {};
    expect(headers["apns-topic"]).toBe(APP_ID);
    const jwt = (headers.authorization ?? "").replace(/^bearer /, "");
    const { header, sig } = decodeJwt(jwt);
    expect(header).toEqual({ alg: "ES256", kid: KEY_ID });
    const signed = Buffer.from(jwt.slice(0, jwt.lastIndexOf(".")));
    expect(
      verify("sha256", signed, { key: signing.publicKey, dsaEncoding: "ieee-p1363" }, sig),
    ).toBe(true);
  });
});
