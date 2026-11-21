import { defineExtension, PUSH_PROVIDER_EXTENSION_POINT } from "@capybara-hq/plugin-sdk";
import { ApnsDeployment } from "../../src/config.js";
import real from "../../src/index.js";
import { createApnsProvider } from "../../src/send.js";
import { FAKE_APNS_CA } from "../fake-apns.js";

/**
 * TEST ONLY: push-apns as the kernel test loads it, identical to `src/index.ts` except that both
 * APNs environments point at the local fake (`CAPYBARA_PUSH_APNS_FAKE_ORIGIN`, trusted through the
 * fake's test-only certificate). The published extension has no such switch.
 */
export default defineExtension({
  ...real,
  setup(ctx) {
    const origin = process.env.CAPYBARA_PUSH_APNS_FAKE_ORIGIN;
    if (!origin) throw new Error("CAPYBARA_PUSH_APNS_FAKE_ORIGIN is not set");
    const provider = createApnsProvider({
      config: ApnsDeployment.parse(ctx.config),
      kv: ctx.kv,
      net: { origin: () => origin, ca: FAKE_APNS_CA },
    });
    ctx.provide(PUSH_PROVIDER_EXTENSION_POINT, provider);
  },
});
