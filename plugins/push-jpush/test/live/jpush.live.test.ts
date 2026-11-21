import { validateSetupCheckResult } from "@capybara-hq/plugin-sdk";
import { describe, expect, it } from "vitest";
import { createCredentialsCheck, createJPushProvider } from "../../src/jpush.js";

/**
 * Against the real JPush, only when the credentials are set:
 *
 * - `CAPYBARA_TEST_JPUSH_APP_KEY`, `CAPYBARA_TEST_JPUSH_MASTER_SECRET`: the credentials check;
 * - plus `CAPYBARA_TEST_JPUSH_REGISTRATION_ID` (a device of that app): one real push.
 */
const appKey = process.env.CAPYBARA_TEST_JPUSH_APP_KEY;
const masterSecret = process.env.CAPYBARA_TEST_JPUSH_MASTER_SECRET;
const registrationId = process.env.CAPYBARA_TEST_JPUSH_REGISTRATION_ID;
const live = appKey !== undefined && masterSecret !== undefined;

describe.skipIf(!live)("push-jpush live", () => {
  const config = () => ({
    appKey: appKey as string,
    masterSecret: masterSecret as string,
    applicationIds: ["com.example.app"],
  });

  it("JPush accepts the credentials", async () => {
    const r = await createCredentialsCheck().run({
      orgId: null,
      config: config(),
      locale: "en",
      mode: null,
      target: { kind: "extension-deployment", plugin: "push-jpush", config: config() },
      signal: new AbortController().signal,
    });
    expect("problem" in validateSetupCheckResult(r)).toBe(false);
    expect(r.status).toBe("ok");
  });

  it.skipIf(registrationId === undefined)("delivers one push to the test device", async () => {
    const results = await createJPushProvider(config()).send({
      registrations: [
        {
          id: "r1",
          platform: "android",
          appId: "com.example.app",
          token: registrationId as string,
        },
      ],
      message: {
        title: "Capybara",
        body: "JPush live test",
        path: "/",
        threadId: "live",
        collapseId: `live-${Date.now()}`,
        origin: "https://capybara.example.com",
      },
      signal: new AbortController().signal,
    });
    expect(results).toEqual([{ registrationId: "r1", status: "delivered" }]);
  });
});
