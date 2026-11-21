import { type SetupCheckResult, validateSetupCheckResult } from "@capybara-hq/plugin-sdk";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { apnsCredentialsCheck } from "../src/check.js";
import type { ApnsDeployment } from "../src/config.js";
import { FAKE_APNS_CA, type FakeApns, startFakeApns } from "./fake-apns.js";
import { KEY_ID, memoryKv, testConfig, testSigningKey } from "./helpers.js";

const ZERO_TOKEN = "0".repeat(64);

let fake: FakeApns;
beforeAll(async () => {
  fake = await startFakeApns();
});
afterAll(async () => {
  await fake?.close();
});
beforeEach(() => {
  fake.received.length = 0;
  fake.respond(ZERO_TOKEN, { status: 400, reason: "BadDeviceToken" });
});

async function run(config: unknown, kv = memoryKv()): Promise<SetupCheckResult> {
  const check = apnsCredentialsCheck({ kv, net: { origin: () => fake.url, ca: FAKE_APNS_CA } });
  expect(check.place).toBe("extension-deployment");
  const result = await check.run({
    orgId: null,
    config,
    locale: "en",
    mode: null,
    target: { kind: "extension-deployment", plugin: "push-apns", config },
    signal: new AbortController().signal,
  });
  expect(validateSetupCheckResult(result)).toEqual(result);
  return result;
}

/** No part of the key (any line of its base64 body) appears in the result. */
function expectNoSecret(result: SetupCheckResult, cfg: ApnsDeployment) {
  const text = JSON.stringify(result);
  for (const line of cfg.key.split("\n")) {
    if (line.length > 0 && !line.startsWith("-----")) expect(text).not.toContain(line.slice(0, 16));
  }
}

describe("apns-credentials", () => {
  it("ok when APNs answers 400 BadDeviceToken for the all-zero token; nothing is written", async () => {
    const cfg = testConfig(testSigningKey().pem);
    const kv = memoryKv();
    const result = await run(cfg, kv);
    expect(result.status).toBe("ok");
    expectNoSecret(result, cfg);
    expect(fake.received).toHaveLength(1);
    expect(fake.received[0]?.token).toBe(ZERO_TOKEN);
    expect(fake.received[0]?.headers["apns-topic"]).toBe("com.example.app");
    expect(fake.received[0]?.headers.authorization?.startsWith("bearer ")).toBe(true);
    expect(kv.writes).toEqual([]);
    expect(kv.dels).toEqual([]);
  });

  it("reuses a valid cached JWT without writing", async () => {
    const cfg = testConfig(testSigningKey().pem);
    const kv = memoryKv();
    const { providerToken } = await import("../src/jwt.js");
    const cached = await providerToken(kv, cfg, Date.now());
    kv.writes.length = 0;
    await run(cfg, kv);
    expect(fake.received[0]?.headers.authorization).toBe(`bearer ${cached}`);
    expect(kv.writes).toEqual([]);
  });

  it("checks each environment once (one request per environment)", async () => {
    const cfg = testConfig(testSigningKey().pem, {
      bundles: [
        { bundleId: "com.example.a", environment: "sandbox" },
        { bundleId: "com.example.b", environment: "sandbox" },
        { bundleId: "com.example.c", environment: "production" },
      ],
    });
    const result = await run(cfg);
    expect(result.status).toBe("ok");
    expect(fake.received.map((r) => r.headers["apns-topic"])).toEqual([
      "com.example.a",
      "com.example.c",
    ]);
  });

  it.each(["InvalidProviderToken", "ExpiredProviderToken"])(
    "failing on 403 %s, the reason names the APNs code",
    async (code) => {
      fake.respond(ZERO_TOKEN, { status: 403, reason: code });
      const cfg = testConfig(testSigningKey().pem);
      const result = await run(cfg);
      expect(result.status).toBe("failing");
      expect(result.reason?.en).toContain(code);
      expect(result.fix?.en).toBeTruthy();
      expectNoSecret(result, cfg);
    },
  );

  it("failing when the key cannot be read, without a request or an echo", async () => {
    const cfg = testConfig(
      "-----BEGIN PRIVATE KEY-----\nMIGHAgEAMBMGsecretsecretsecret\n-----END PRIVATE KEY-----",
    );
    const result = await run(cfg);
    expect(result.status).toBe("failing");
    expect(JSON.stringify(result)).not.toContain("secretsecret");
    expect(fake.received).toHaveLength(0);
  });

  it("failing when the config is incomplete", async () => {
    const result = await run({ keyId: KEY_ID });
    expect(result.status).toBe("failing");
    expect(fake.received).toHaveLength(0);
  });

  it.each([
    [{ status: 200 }],
    [{ status: 500, reason: "InternalServerError" }],
    [{ status: 429, reason: "TooManyRequests" }],
    [{ network: "reset" as const }],
  ])("unknown on any other answer (%j)", async (answer) => {
    fake.respond(ZERO_TOKEN, answer);
    const result = await run(testConfig(testSigningKey().pem));
    expect(result.status).toBe("unknown");
  });
});
