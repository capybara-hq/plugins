import type { SetupCheckDefinition, SetupCheckResult } from "@capybara-hq/plugin-sdk";
import { createRemoteJWKSet } from "jose";
import { describe, expect, it } from "vitest";
import { GOOGLE_ENDPOINTS } from "../../src/config.js";
import { clientCheck, discoveryCheck } from "../../src/setup-checks.js";

/**
 * Sign in with Google live checks against Google (discovery, the token endpoint, the JWKS):
 * `pnpm exec vitest run plugins/google/test/live`
 *
 * Runs only when both are set (a value starting with "replace" counts as unset), so a plain
 * `pnpm test` never reaches the network:
 * - `CAPYBARA_TEST_GOOGLE_CLIENT_ID`: a Web application OAuth client (Internal, in a
 *   Workspace-owned Google Cloud project);
 * - `CAPYBARA_TEST_GOOGLE_CLIENT_SECRET`: its secret.
 * The interactive login cannot be automated; it is on the README's live acceptance list. The
 * credentials come from the outer environment; nothing beyond a check's status is printed.
 */

const filled = (v: string | undefined): v is string =>
  v !== undefined && v.trim() !== "" && !v.toLowerCase().startsWith("replace");
const CLIENT_ID = process.env.CAPYBARA_TEST_GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.CAPYBARA_TEST_GOOGLE_CLIENT_SECRET;
const READY = filled(CLIENT_ID) && filled(CLIENT_SECRET);

if (!READY) {
  console.info(
    "[google-live] skipped: CAPYBARA_TEST_GOOGLE_CLIENT_ID / _CLIENT_SECRET not both filled",
  );
}

async function run(check: SetupCheckDefinition, config: unknown): Promise<SetupCheckResult> {
  return check.run({
    orgId: null,
    config,
    locale: "en",
    mode: null,
    target: { kind: "extension-deployment", plugin: "google", config },
    signal: AbortSignal.timeout(10_000),
  });
}

describe.skipIf(!READY)("Sign in with Google live", () => {
  const config = () => ({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });

  it("google-discovery: Google still publishes the plugin's endpoints", async () => {
    const r = await run(discoveryCheck(), config());
    expect(r.status, r.reason?.en).toBe("ok");
  });

  it("google-client: Google accepts the client; a changed secret is refused", async () => {
    expect((await run(clientCheck(), config())).status).toBe("ok");
    const secret = CLIENT_SECRET as string;
    const altered = `${secret.slice(0, -1)}${secret.endsWith("x") ? "y" : "x"}`;
    expect((await run(clientCheck(), { ...config(), clientSecret: altered })).status).toBe(
      "failing",
    );
  });

  it("Google's JWKS serves at least one RS256 key", async () => {
    const res = await fetch(GOOGLE_ENDPOINTS.jwksUrl, { signal: AbortSignal.timeout(10_000) });
    expect(res.status).toBe(200);
    const { keys } = (await res.json()) as { keys: { alg?: string; kty?: string }[] };
    expect(keys.some((k) => k.kty === "RSA" && (k.alg === undefined || k.alg === "RS256"))).toBe(
      true,
    );
    // and jose can build a key set over it
    expect(typeof createRemoteJWKSet(new URL(GOOGLE_ENDPOINTS.jwksUrl))).toBe("function");
  });
});
