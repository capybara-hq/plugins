import { defineExtension, PUSH_PROVIDER_EXTENSION_POINT } from "@capybara-hq/plugin-sdk";
import { credentialsCheck } from "./check.js";
import { FcmDeployment } from "./config.js";
import { FCM_ENDPOINTS, type FcmEndpoints } from "./oauth.js";
import { makeFcmProvider } from "./provider.js";

export { credentialsCheck } from "./check.js";
export { FcmDeployment, parseServiceAccount } from "./config.js";
export { FCM_ENDPOINTS, type FcmEndpoints } from "./oauth.js";
export { makeFcmProvider } from "./provider.js";

/**
 * Firebase Cloud Messaging push provider (`push-provider@1`, FCM HTTP v1). Deployment config: the
 * service account key file (secret) and the Android application ids it covers. Access tokens come
 * from a JWT bearer exchange and are cached in `ctx.kv`. `endpoints` is the test seam (a local
 * fake); the packed extension always talks to Google.
 */
export function fcmExtension(endpoints: FcmEndpoints = FCM_ENDPOINTS) {
  return defineExtension({
    name: "push-fcm",
    version: "0.1.0-rc.0",
    sdk: "^0.1.0-rc.46",
    provides: [PUSH_PROVIDER_EXTENSION_POINT],
    permissions: {
      network: ["oauth2.googleapis.com", "fcm.googleapis.com"],
      setupChecks: ["fcm-credentials"],
    },
    config: { deployment: FcmDeployment },
    setup(ctx) {
      const config = FcmDeployment.parse(ctx.config);
      ctx.provide(
        PUSH_PROVIDER_EXTENSION_POINT,
        makeFcmProvider({ config, kv: ctx.kv, endpoints }),
      );
      ctx.setup.check("fcm-credentials", credentialsCheck(endpoints));
    },
  });
}

export default fcmExtension();
