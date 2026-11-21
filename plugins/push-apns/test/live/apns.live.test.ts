import { describe, expect, it } from "vitest";
import { apnsCredentialsCheck } from "../../src/check.js";
import type { ApnsDeployment } from "../../src/config.js";
import { createApnsProvider } from "../../src/send.js";
import { memoryKv } from "../helpers.js";

/**
 * Live APNs, only with every variable set: CAPYBARA_TEST_APNS_KEY (the .p8 content; literal \n
 * allowed), _KEY_ID, _TEAM_ID, _BUNDLE (an app's bundle id), _TOKEN (a device token of that app)
 * and optionally _ENVIRONMENT (`production` or `sandbox`, default `sandbox`). It runs the setup
 * check and sends one notification to the device. Never prints the key or the token.
 */
const env = process.env;
const live =
  env.CAPYBARA_TEST_APNS_KEY &&
  env.CAPYBARA_TEST_APNS_KEY_ID &&
  env.CAPYBARA_TEST_APNS_TEAM_ID &&
  env.CAPYBARA_TEST_APNS_BUNDLE &&
  env.CAPYBARA_TEST_APNS_TOKEN;

describe.skipIf(!live)("APNs live", () => {
  const config = (): ApnsDeployment => ({
    key: env.CAPYBARA_TEST_APNS_KEY as string,
    keyId: env.CAPYBARA_TEST_APNS_KEY_ID as string,
    teamId: env.CAPYBARA_TEST_APNS_TEAM_ID as string,
    bundles: [
      {
        bundleId: env.CAPYBARA_TEST_APNS_BUNDLE as string,
        environment: env.CAPYBARA_TEST_APNS_ENVIRONMENT === "production" ? "production" : "sandbox",
      },
    ],
  });

  it("the setup check answers ok", async () => {
    const cfg = config();
    const result = await apnsCredentialsCheck({ kv: memoryKv() }).run({
      orgId: null,
      config: cfg,
      locale: "en",
      mode: null,
      target: { kind: "extension-deployment", plugin: "push-apns", config: cfg },
      signal: AbortSignal.timeout(10_000),
    });
    expect(result.status, result.reason?.en).toBe("ok");
  });

  it("delivers one notification to the device", async () => {
    const cfg = config();
    const provider = createApnsProvider({ config: cfg, kv: memoryKv() });
    const results = await provider.send({
      registrations: [
        {
          id: "live",
          platform: "ios",
          appId: cfg.bundles[0]?.bundleId ?? "",
          token: env.CAPYBARA_TEST_APNS_TOKEN as string,
        },
      ],
      message: {
        title: "Capybara",
        body: "push-apns live test",
        path: "/",
        threadId: "push-apns-live",
        collapseId: `push-apns-live-${Date.now()}`,
        origin: "https://capybara.example.com",
      },
      signal: AbortSignal.timeout(15_000),
    });
    expect(results).toEqual([{ registrationId: "live", status: "delivered" }]);
  });
});
