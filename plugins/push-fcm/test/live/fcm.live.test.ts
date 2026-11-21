import { checkPushResults, type PushTarget } from "@capybara-hq/plugin-sdk";
import { describe, expect, it } from "vitest";
import { credentialsCheck } from "../../src/check.js";
import { makeFcmProvider } from "../../src/provider.js";

/**
 * FCM live acceptance against Google (the real token endpoint and FCM HTTP v1):
 * `pnpm exec vitest run plugins/push-fcm/test/live`
 *
 * Runs only when all three are set (a value starting with "replace" counts as unset), so a plain
 * `pnpm test` never reaches the network:
 * - `CAPYBARA_TEST_FCM_SERVICE_ACCOUNT`: the service account JSON (Firebase console → Project
 *   settings → Service accounts → Generate new private key), as one line;
 * - `CAPYBARA_TEST_FCM_APP_ID`: the Android application id of the test app;
 * - `CAPYBARA_TEST_FCM_TOKEN`: an FCM registration token of that app on a test device.
 * The credentials come from the outer environment; this file reads no credential file and never
 * prints them. The device shows one notification per run.
 */

const filled = (v: string | undefined): v is string =>
  v !== undefined && v.trim() !== "" && !v.toLowerCase().startsWith("replace");
const env = process.env;
const SERVICE_ACCOUNT = env.CAPYBARA_TEST_FCM_SERVICE_ACCOUNT;
const APP_ID = env.CAPYBARA_TEST_FCM_APP_ID;
const TOKEN = env.CAPYBARA_TEST_FCM_TOKEN;
const READY = filled(SERVICE_ACCOUNT) && filled(APP_ID) && filled(TOKEN);

if (!READY) {
  console.info(
    "[fcm-live] skipped: CAPYBARA_TEST_FCM_SERVICE_ACCOUNT / _APP_ID / _TOKEN not all filled",
  );
}

/** A test-only kv (the real one is the kernel's). */
function memoryKv() {
  const map = new Map<string, string>();
  return {
    get: async (key: string) => map.get(key) ?? null,
    set: async (key: string, value: string, _opts: { ttlSeconds: number }) => {
      map.set(key, value);
    },
    del: async (key: string) => {
      map.delete(key);
    },
  };
}

describe.skipIf(!READY)("FCM live", () => {
  const config = () => ({
    serviceAccount: SERVICE_ACCOUNT as string,
    applicationIds: [APP_ID as string],
  });

  it("live: the credentials check passes", async () => {
    const r = await credentialsCheck().run({
      orgId: null,
      config: config(),
      locale: "en",
      mode: null,
      target: { kind: "extension-deployment", plugin: "push-fcm", config: config() },
      signal: AbortSignal.timeout(10_000),
    });
    expect(r.status, r.reason?.en).toBe("ok");
  });

  it("live: a push reaches the device and a made-up token is unregistered", async () => {
    const provider = makeFcmProvider({ config: config(), kv: memoryKv() });
    const regs: PushTarget[] = [
      { id: "real", platform: "android", appId: APP_ID as string, token: TOKEN as string },
      { id: "fake", platform: "android", appId: APP_ID as string, token: "made-up-token" },
    ];
    const results = await provider.send({
      registrations: regs,
      message: {
        title: "Capybara live test",
        body: "push-fcm live acceptance",
        path: "/",
        threadId: "push-fcm-live",
        collapseId: `push-fcm-live-${Date.now()}`,
        origin: "https://capybara.example.com",
      },
      signal: AbortSignal.timeout(15_000),
    });
    expect(checkPushResults(regs, results)).toBeNull();
    expect(results[0]).toEqual({ registrationId: "real", status: "delivered" });
    expect(results[1]).toEqual({ registrationId: "fake", status: "unregistered" });
  });
});
