import { defineExtension, PUSH_PROVIDER_EXTENSION_POINT } from "@capybara-hq/plugin-sdk";
import { JPushDeployment } from "./config.js";
import { createCredentialsCheck, createJPushProvider } from "./jpush.js";

export { JPUSH_API, JPushDeployment, type JPushDeploymentConfig } from "./config.js";
export { createCredentialsCheck, createJPushProvider, notifyIdOf } from "./jpush.js";

/**
 * JPush push provider (`push-provider@1`) for Android phones in mainland China: JPush's own
 * channel plus the Huawei, Honor, Xiaomi, OPPO and vivo vendor channels, every message marked as a
 * service message. Platform deployment config only; the `jpush-app` setup guide's
 * `jpush-credentials` check verifies the credentials without sending.
 */
export default defineExtension({
  name: "push-jpush",
  version: "0.1.0-rc.0",
  sdk: "^0.1.0-rc.46",
  provides: [PUSH_PROVIDER_EXTENSION_POINT],
  permissions: { network: ["api.jpush.cn"], setupChecks: ["jpush-credentials"] },
  config: { deployment: JPushDeployment },
  setup(ctx) {
    const cfg = JPushDeployment.parse(ctx.config);
    ctx.provide(PUSH_PROVIDER_EXTENSION_POINT, createJPushProvider(cfg));
    ctx.setup.check("jpush-credentials", createCredentialsCheck());
  },
});
