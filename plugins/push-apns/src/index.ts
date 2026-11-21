import { defineExtension, PUSH_PROVIDER_EXTENSION_POINT } from "@capybara-hq/plugin-sdk";
import { apnsCredentialsCheck } from "./check.js";
import { ApnsDeployment } from "./config.js";
import { createApnsProvider } from "./send.js";

export { apnsCredentialsCheck } from "./check.js";
export { ApnsDeployment } from "./config.js";
export { APPLE_ORIGINS, type ApnsNet, createApnsProvider, mapApnsAnswer } from "./send.js";

/**
 * Apple Push Notification service (`push-provider@1`): token-based authentication with a `.p8`
 * signing key from the deployment config, one HTTP/2 request per device to `api.push.apple.com`
 * or `api.sandbox.push.apple.com` by bundle. The provider token is shared through `ctx.kv`
 * (40 minutes). The platform setup guide `guides/apns-key.md` has one check, `apns-credentials`.
 * `permissions.network` is informational.
 */
export default defineExtension({
  name: "push-apns",
  version: "0.1.0-rc.0",
  sdk: "^0.1.0-rc.46",
  provides: [PUSH_PROVIDER_EXTENSION_POINT],
  permissions: {
    network: ["api.push.apple.com", "api.sandbox.push.apple.com"],
    setupChecks: ["apns-credentials"],
  },
  config: { deployment: ApnsDeployment },
  setup(ctx) {
    const provider = createApnsProvider({ config: ApnsDeployment.parse(ctx.config), kv: ctx.kv });
    ctx.provide(PUSH_PROVIDER_EXTENSION_POINT, provider);
    ctx.setup.check("apns-credentials", apnsCredentialsCheck({ kv: ctx.kv }));
  },
});
