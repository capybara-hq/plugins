import { timingSafeEqual } from "node:crypto";
import type {
  ExternalIdentity,
  IdentitySource,
  IdentitySourceTenant,
} from "@capybara-hq/plugin-sdk";
import { createRemoteJWKSet, type JWTPayload, type JWTVerifyGetKey, jwtVerify } from "jose";
import { CONSUMER_TENANT, hostedDomainGate, toExternalIdentity } from "./claims.js";
import { loginConfig } from "./config.js";
import { readJsonCapped } from "./http.js";

/** The scopes login requests: non-sensitive, no app verification needed. */
export const GOOGLE_OIDC_SCOPES = "openid email profile";

/**
 * The tenant of a Google sign-in, as the admin console labels and checks trusted tenants: the
 * verified `hd` claim (the Workspace or Cloud Identity primary domain); consumer accounts share the
 * tenant `consumer`, which may never be trusted (anyone can create a Google account on any email).
 */
export const GOOGLE_TENANT: IdentitySourceTenant = {
  label: { zh: "Google Workspace 主域名", en: "Google Workspace primary domain" },
  help: {
    zh: "Google Workspace 或 Cloud Identity 的主域名（ID 令牌里的 hd），在 Google 管理控制台的「账号」→「域名」里可以看到。",
    en: "The primary domain of Google Workspace or Cloud Identity (the hd claim of the ID token), shown in the Google Admin console under Account → Domains.",
  },
  pattern: "^[a-z0-9.-]+\\.[a-z]{2,}$",
  placeholder: "example.com",
  neverTrusted: [CONSUMER_TENANT],
};
/** The token exchange's timeout; the kernel's 15-second signal also applies. */
const REQUEST_TIMEOUT_MS = 10_000;
/**
 * The JWKS fetch's timeout. jose's remote key set takes no signal, so this keeps exchange plus
 * key fetch inside the kernel's 15-second callback budget.
 */
const JWKS_TIMEOUT_MS = 5_000;
/** Google's ID tokens live one hour; an older `iat`, or one ahead of the clock tolerance, is refused. */
const MAX_TOKEN_AGE_S = 3600;
/** An OAuth error code as Google sends it; anything else is reported as the HTTP status. */
const OAUTH_ERROR = /^[a-z_]{1,64}$/;

const str = (v: unknown) => (typeof v === "string" && v !== "" ? v : undefined);

/** Constant-time string equality (unequal lengths are unequal). */
function sameString(a: string, b: string): boolean {
  const x = Buffer.from(a, "utf8");
  const y = Buffer.from(b, "utf8");
  return x.length === y.length && timingSafeEqual(x, y);
}

/** A jose error as a short code (never the token). */
function joseReason(e: unknown): string {
  const code = (e as { code?: unknown }).code;
  const claim = (e as { claim?: unknown }).claim;
  if (typeof code !== "string") return "invalid token";
  return typeof claim === "string" && /^[a-z_]{1,32}$/.test(claim) ? `${code} (${claim})` : code;
}

/**
 * The authorization code -> ID token exchange: one form POST (`client_secret_post` plus the PKCE
 * verifier), no retries. Errors carry Google's OAuth error code or the HTTP status only, never the
 * body, the code, the verifier or the secret.
 */
async function exchangeCode(
  tokenUrl: string,
  form: Record<string, string>,
  signal: AbortSignal,
): Promise<string> {
  let res: Response;
  try {
    res = await fetch(tokenUrl, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body: new URLSearchParams(form).toString(),
      redirect: "manual",
      signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
    });
  } catch {
    throw new Error("Google token exchange failed: network error");
  }
  let body: Record<string, unknown> | undefined;
  try {
    body = (await readJsonCapped(res)) as Record<string, unknown>;
  } catch {
    body = undefined;
  }
  if (res.status !== 200) {
    const code = str(body?.error);
    throw new Error(
      `Google token exchange failed: ${code !== undefined && OAUTH_ERROR.test(code) ? code : `HTTP ${res.status}`}`,
    );
  }
  const idToken = str(body?.id_token);
  if (idToken === undefined) throw new Error("Google token exchange failed: no id_token");
  return idToken;
}

/**
 * Sign in with Google (`identity-source@1`, OpenID Connect;
 * https://developers.google.com/identity/openid-connect/openid-connect, read 2026-11-22). Spec §4.3
 * and §4.8 of docs/superpowers/specs/2026-11-22-google-plugin-design.md.
 *
 * - Authorize: `response_type=code`, `scope=openid email profile`, the kernel's `state`, `nonce`
 *   and PKCE S256 challenge, `prompt=select_account`; `hd=<domain>` only with exactly one allowed
 *   domain, as a UI hint (never the gate). No `access_type`: login needs no refresh token.
 * - Callback: one token exchange (`client_secret_post` + `code_verifier`); the ID token verified
 *   with jose against Google's JWKS (RS256 only, `iss` either documented form, `aud = clientId`,
 *   `exp` / `iat` / `sub` / `nonce` required, 60 s clock tolerance), the nonce compared in constant
 *   time, `azp` (when present) equal to the client. Then the hosted-domain gate on the verified `hd`
 *   claim and the identity mapping (claims.ts). No userinfo call: the ID token carries everything.
 * - Nothing from Google is stored; errors carry codes only.
 */
export function createGoogleIdentitySource(): IdentitySource {
  /**
   * One remote key set per JWKS URL: jose caches the keys (10 minutes) and refetches on an unknown
   * `kid` (after its 30-second cooldown), so Google's key rotation needs no restart. A read-only
   * cache, correct when lost; it lives with the source instance.
   */
  const jwks = new Map<string, JWTVerifyGetKey>();
  const keySet = (url: string) => {
    let set = jwks.get(url);
    if (set === undefined) {
      set = createRemoteJWKSet(new URL(url), { timeoutDuration: JWKS_TIMEOUT_MS });
      jwks.set(url, set);
    }
    return set;
  };

  return {
    label: { zh: "Google", en: "Google" },
    tenant: GOOGLE_TENANT,

    authorizeUrl({ config, redirectUri, state, nonce, codeChallenge, codeChallengeMethod }) {
      const c = loginConfig(config);
      const u = new URL(c.endpoints.authorizationUrl);
      u.searchParams.set("response_type", "code");
      u.searchParams.set("client_id", c.clientId);
      u.searchParams.set("redirect_uri", redirectUri);
      u.searchParams.set("scope", GOOGLE_OIDC_SCOPES);
      u.searchParams.set("state", state);
      u.searchParams.set("nonce", nonce);
      if (codeChallenge !== undefined && codeChallengeMethod !== undefined) {
        u.searchParams.set("code_challenge", codeChallenge);
        u.searchParams.set("code_challenge_method", codeChallengeMethod);
      }
      u.searchParams.set("prompt", "select_account");
      const only = c.allowedDomains.length === 1 ? c.allowedDomains[0] : undefined;
      if (only !== undefined) u.searchParams.set("hd", only);
      return u.toString();
    },

    async callback({
      config,
      redirectUri,
      query,
      nonce,
      signal,
      codeVerifier,
    }): Promise<ExternalIdentity> {
      const c = loginConfig(config);
      if (query.error !== undefined) {
        const shown = OAUTH_ERROR.test(query.error) ? query.error : "invalid error parameter";
        throw new Error(`Google authorization failed: ${shown}`);
      }
      const code = query.code;
      if (code === undefined || code === "") throw new Error("Google authorization code missing");

      const idToken = await exchangeCode(
        c.endpoints.tokenUrl,
        {
          grant_type: "authorization_code",
          code,
          redirect_uri: redirectUri,
          client_id: c.clientId,
          client_secret: c.clientSecret,
          ...(codeVerifier !== undefined && { code_verifier: codeVerifier }),
        },
        signal,
      );

      let claims: JWTPayload;
      try {
        claims = (
          await jwtVerify(idToken, keySet(c.endpoints.jwksUrl), {
            algorithms: ["RS256"],
            issuer: c.endpoints.issuers,
            audience: c.clientId,
            requiredClaims: ["exp", "iat", "sub", "nonce"],
            clockTolerance: 60,
            maxTokenAge: MAX_TOKEN_AGE_S,
          })
        ).payload;
      } catch (e) {
        throw new Error(`Google ID token rejected: ${joseReason(e)}`);
      }
      signal.throwIfAborted();
      if (typeof claims.nonce !== "string" || !sameString(claims.nonce, nonce)) {
        throw new Error("Google ID token rejected: nonce mismatch");
      }
      // OIDC Core §3.1.3.7: with several audiences the authorized party must be present and be us.
      const severalAudiences = Array.isArray(claims.aud) && claims.aud.length > 1;
      if ((claims.azp !== undefined || severalAudiences) && claims.azp !== c.clientId) {
        throw new Error("Google ID token rejected: azp mismatch");
      }
      return toExternalIdentity(claims, hostedDomainGate(claims, c));
    },
  };
}
