import { createHash, createSign } from "node:crypto";
import { PushError, type PushErrorKind } from "@capybara-hq/plugin-sdk";
import type { ServiceAccount } from "./config.js";

/** Where push-fcm sends: Google's OAuth token endpoint and the FCM HTTP v1 API. */
export interface FcmEndpoints {
  tokenUrl: string;
  /** The API origin; sends go to `<apiBase>/v1/projects/<project_id>/messages:send`. */
  apiBase: string;
}

export const FCM_ENDPOINTS: FcmEndpoints = Object.freeze({
  tokenUrl: "https://oauth2.googleapis.com/token",
  apiBase: "https://fcm.googleapis.com",
});

export const FCM_SCOPE = "https://www.googleapis.com/auth/firebase.messaging";
const JWT_BEARER = "urn:ietf:params:oauth:grant-type:jwt-bearer";
/** Seconds an assertion is valid (Google's maximum). */
const ASSERTION_SECONDS = 3600;
/** A cached access token expires this many seconds before Google's expiry. */
export const TOKEN_MARGIN_SECONDS = 300;
/** OAuth error codes that mean the credentials themselves are wrong. */
const AUTH_ERRORS = new Set(["invalid_grant", "invalid_client", "unauthorized_client"]); // capybara:allow-module-state read-only lookup table

/** The kv the token cache uses (the kernel's `ctx.kv`). */
export interface TokenKv {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, opts: { ttlSeconds: number }): Promise<void>;
  del(key: string): Promise<void>;
}

const b64url = (v: string | Buffer) => Buffer.from(v).toString("base64url");

/** The RS256-signed JWT bearer assertion for the firebase.messaging scope. */
export function signAssertion(sa: ServiceAccount, aud: string, nowSeconds: number): string {
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(
    JSON.stringify({
      iss: sa.clientEmail,
      scope: FCM_SCOPE,
      aud,
      iat: nowSeconds,
      exp: nowSeconds + ASSERTION_SECONDS,
    }),
  );
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${claims}`);
  return `${header}.${claims}.${b64url(signer.sign(sa.privateKey))}`;
}

/** The outcome of one token exchange; `code` is the OAuth error code when Google sent one. */
export type TokenExchange =
  | { ok: true; accessToken: string; expiresIn: number }
  | { ok: false; kind: PushErrorKind; message: string; code?: string };

/** An OAuth error code as Google sends it, safe to show (lowercase letters and `_` only). */
function oauthCode(body: unknown): string | undefined {
  const code = (body as { error?: unknown } | null)?.error;
  return typeof code === "string" && /^[a-z_]{1,64}$/.test(code) ? code : undefined;
}

/**
 * One JWT bearer exchange at the token endpoint, no retries, no cache. Messages never carry the
 * key, the assertion or the access token.
 */
export async function exchangeToken(
  sa: ServiceAccount,
  endpoints: FcmEndpoints,
  signal: AbortSignal,
): Promise<TokenExchange> {
  let assertion: string;
  try {
    assertion = signAssertion(sa, endpoints.tokenUrl, Math.floor(Date.now() / 1000));
  } catch {
    return { ok: false, kind: "auth", message: "the service account's private key cannot sign" };
  }
  let res: Response;
  try {
    res = await fetch(endpoints.tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: JWT_BEARER, assertion }).toString(),
      redirect: "error",
      signal,
    });
  } catch {
    return {
      ok: false,
      kind: "transient",
      message: signal.aborted
        ? "the Google token request was aborted"
        : "the Google token endpoint could not be reached",
    };
  }
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (res.ok) {
    const b = body as { access_token?: unknown; expires_in?: unknown } | null;
    if (typeof b?.access_token === "string" && b.access_token !== "") {
      const expiresIn = typeof b.expires_in === "number" ? b.expires_in : 0;
      return { ok: true, accessToken: b.access_token, expiresIn };
    }
    return {
      ok: false,
      kind: "transient",
      message: "Google answered the token request without an access token",
    };
  }
  const code = oauthCode(body);
  if (code !== undefined && AUTH_ERRORS.has(code)) {
    return {
      ok: false,
      kind: "auth",
      code,
      message: `Google refused the service account (${code}): check the key and the server clock`,
    };
  }
  if (res.status === 429) {
    return {
      ok: false,
      kind: "rate_limited",
      message: "Google rate-limited the token request (429)",
    };
  }
  return {
    ok: false,
    kind: "transient",
    ...(code !== undefined && { code }),
    message: `the Google token endpoint answered ${res.status}${code === undefined ? "" : ` (${code})`}`,
  };
}

/** The kv key of a service account's cached access token. */
export function tokenCacheKey(clientEmail: string): string {
  return `fcm-token-${createHash("sha256").update(clientEmail).digest("hex")}`;
}

/**
 * The access token for `sa`: from kv when cached, else one exchange, cached for
 * `expires_in − 300` seconds (not at all when that is not positive). A failed exchange throws a
 * PushError (it applies to every registration of the send).
 */
export async function accessToken(
  sa: ServiceAccount,
  endpoints: FcmEndpoints,
  kv: TokenKv,
  signal: AbortSignal,
): Promise<string> {
  const key = tokenCacheKey(sa.clientEmail);
  const cached = await kv.get(key);
  if (cached !== null && cached !== "") return cached;
  const r = await exchangeToken(sa, endpoints, signal);
  if (!r.ok) throw new PushError(`push-fcm: ${r.message}`, { kind: r.kind });
  const ttlSeconds = Math.floor(r.expiresIn) - TOKEN_MARGIN_SECONDS;
  if (ttlSeconds > 0) await kv.set(key, r.accessToken, { ttlSeconds });
  return r.accessToken;
}
