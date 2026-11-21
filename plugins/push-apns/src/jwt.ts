import { createHash, createPrivateKey, type KeyObject, sign } from "node:crypto";
import type { ApnsDeployment } from "./config.js";

/**
 * APNs provider tokens (token-based authentication): an ES256 JWT with header `{ alg, kid }` and
 * claims `{ iss: teamId, iat }`. Apple accepts one for an hour and refuses a new one more often than
 * every 20 minutes (`TooManyProviderTokenUpdates`), so every replica shares one token through
 * `ctx.kv` for 40 minutes. The private key never leaves process memory: kv holds the token and a
 * fingerprint of the config it was signed with, never the key.
 */

/** How long a cached provider token is used (between Apple's 20-minute floor and 60-minute limit). */
export const JWT_CACHE_TTL_SECONDS = 40 * 60;

/** The kv key of the shared provider token. */
export const jwtCacheKey = (keyId: string) => `apns-jwt-${keyId}`;

/** The signing key cannot be used; the message never contains any part of it. */
export class ApnsKeyError extends Error {
  constructor() {
    super(
      "push-apns: the signing key is not a valid APNs .p8 key (an EC P-256 private key in PEM, " +
        "BEGIN and END lines included)",
    );
    this.name = "ApnsKeyError";
  }
}

const PEM_RE = /^-----BEGIN PRIVATE KEY-----([A-Za-z0-9+/=\s]+)-----END PRIVATE KEY-----$/;

/**
 * The canonical PEM of a pasted `.p8`: a single-line input drops the newlines, an env var carries
 * literal `\n`, an editor CRLF. Only the base64 body between the PKCS#8 markers is kept.
 */
function canonicalPem(input: string): string {
  const m = PEM_RE.exec(input.replaceAll("\\n", "\n").trim());
  if (!m) throw new ApnsKeyError();
  const body = (m[1] as string).replace(/\s+/g, "");
  return `-----BEGIN PRIVATE KEY-----\n${body.replace(/(.{64})/g, "$1\n").replace(/\n$/, "")}\n-----END PRIVATE KEY-----\n`;
}

/** Reads a `.p8` PEM (see canonicalPem for the accepted pastes); throws ApnsKeyError. */
export function loadSigningKey(pem: string): KeyObject {
  let key: KeyObject;
  try {
    key = createPrivateKey({ key: canonicalPem(pem), format: "pem" });
  } catch {
    throw new ApnsKeyError();
  }
  if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") {
    throw new ApnsKeyError();
  }
  return key;
}

const b64url = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");

/** Signs a provider token issued at `nowMs`. */
export function signProviderToken(
  key: KeyObject,
  opts: { keyId: string; teamId: string; nowMs: number },
): string {
  const input = `${b64url({ alg: "ES256", kid: opts.keyId })}.${b64url({
    iss: opts.teamId,
    iat: Math.floor(opts.nowMs / 1000),
  })}`;
  const sig = sign("sha256", Buffer.from(input), { key, dsaEncoding: "ieee-p1363" });
  return `${input}.${sig.toString("base64url")}`;
}

/** Narrow kv surface (ctx.kv). */
export interface ApnsKv {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, opts: { ttlSeconds: number }): Promise<void>;
  del(key: string): Promise<void>;
}

/** Identifies the config a token was signed with, so a changed key or team signs anew. */
function fingerprint(cfg: Pick<ApnsDeployment, "key" | "keyId" | "teamId">): string {
  return createHash("sha256")
    .update(`${cfg.teamId}\0${cfg.keyId}\0${cfg.key}`)
    .digest("hex")
    .slice(0, 32);
}

/** The cached token for this config, or null; reads only. */
export async function cachedProviderToken(
  kv: Pick<ApnsKv, "get">,
  cfg: Pick<ApnsDeployment, "key" | "keyId" | "teamId">,
): Promise<string | null> {
  const raw = await kv.get(jwtCacheKey(cfg.keyId));
  if (raw === null) return null;
  const sep = raw.indexOf(" ");
  if (sep < 0 || raw.slice(0, sep) !== fingerprint(cfg)) return null;
  return raw.slice(sep + 1);
}

/** The shared provider token: the cached one, else a new one cached for 40 minutes. */
export async function providerToken(
  kv: ApnsKv,
  cfg: Pick<ApnsDeployment, "key" | "keyId" | "teamId">,
  nowMs: number,
): Promise<string> {
  const cached = await cachedProviderToken(kv, cfg);
  if (cached !== null) return cached;
  const jwt = signProviderToken(loadSigningKey(cfg.key), { ...cfg, nowMs });
  await kv.set(jwtCacheKey(cfg.keyId), `${fingerprint(cfg)} ${jwt}`, {
    ttlSeconds: JWT_CACHE_TTL_SECONDS,
  });
  return jwt;
}

/** Forgets the shared token (APNs answered `ExpiredProviderToken`). */
export async function dropProviderToken(kv: Pick<ApnsKv, "del">, keyId: string): Promise<void> {
  await kv.del(jwtCacheKey(keyId));
}
