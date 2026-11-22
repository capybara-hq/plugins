import { defineExtension, IDENTITY_SOURCE_EXTENSION_POINT } from "@capybara-hq/plugin-sdk";
import { GoogleDeployment } from "./config.js";
import { createGoogleIdentitySource } from "./identity.js";
import { clientCheck, discoveryCheck } from "./setup-checks.js";

export {
  CONSUMER_TENANT,
  emailIsAuthoritative,
  hostedDomainGate,
  toExternalIdentity,
} from "./claims.js";
export {
  GOOGLE_ENDPOINTS,
  GoogleDeployment,
  type GoogleEndpoints,
  type GoogleLoginConfig,
  loginConfig,
} from "./config.js";
export { createGoogleIdentitySource, GOOGLE_OIDC_SCOPES } from "./identity.js";
export { clientCheck, discoveryCheck } from "./setup-checks.js";

// The manifest identity at the top level, where `capybara-plugin sync-versions` finds its version.
// capybara:allow-module-state read-only manifest constants, never mutated
const MANIFEST = Object.freeze({
  name: "google",
  version: "0.1.0-rc.0",
  sdk: "^0.1.0-rc.52",
} as const);

/**
 * Sign in with Google (`identity-source@1`). Deployment config only (the login page runs before
 * any org is known): the Web OAuth client, the allowed Workspace domains and whether consumer
 * accounts may sign in. Login is offered once the super admin adds `google` to
 * `auth.loginSources`. Two read-only setup checks verify Google's endpoints and the client. No
 * state, kv, hooks, tools, UI or migrations.
 */
export default defineExtension({
  ...MANIFEST,
  provides: [IDENTITY_SOURCE_EXTENSION_POINT],
  permissions: {
    network: ["accounts.google.com", "oauth2.googleapis.com", "www.googleapis.com"],
    setupChecks: ["google-discovery", "google-client"],
  },
  config: { deployment: GoogleDeployment },
  setup(ctx) {
    ctx.provide(IDENTITY_SOURCE_EXTENSION_POINT, createGoogleIdentitySource());
    ctx.setup.check("google-discovery", discoveryCheck());
    ctx.setup.check("google-client", clientCheck());
  },
});
