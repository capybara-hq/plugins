import { type ExternalIdentity, IdentitySourceRefused } from "@capybara-hq/plugin-sdk";
import { asciiLower, HOSTNAME } from "./domain.js";

/**
 * The plugin's authorization decision and identity mapping, as pure functions over the claims of
 * an ID token that `identity.ts` has already verified (signature, `iss`, `aud`, `exp`, nonce,
 * `azp`). No I/O. Spec §4.3 step 4 and §4.4 of
 * docs/superpowers/specs/2026-11-22-google-plugin-design.md.
 */

/** The tenant of a Google account outside any Workspace / Cloud Identity organization (no dot). */
export const CONSUMER_TENANT = "consumer";

/** The longest display name the plugin reports. */
const DISPLAY_NAME_CHARS = 200;

export interface HostedDomainPolicy {
  allowedDomains: string[];
  allowConsumerAccounts: boolean;
}

const nonEmpty = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;

/** The `hd` claim lowercased (ASCII); a missing, empty or non-string `hd` is none. */
function hostedDomainOf(claims: { hd?: unknown }): string | undefined {
  const hd = nonEmpty(claims.hd);
  return hd === undefined ? undefined : asciiLower(hd);
}

/** The email lowercased (ASCII), or none when missing, empty or not plain ASCII. */
function emailOf(claims: { email?: unknown }): string | undefined {
  const email = nonEmpty(claims.email);
  return email === undefined || !/^[\x21-\x7e]+$/.test(email) ? undefined : asciiLower(email);
}

function refuse(shown: string): never {
  // `shown` is "none", "(invalid)" or an hd that passed HOSTNAME (at most 253 characters).
  throw new IdentitySourceRefused(
    `Google account not allowed: hosted domain ${shown} is not permitted`,
  );
}

/**
 * The hosted-domain gate. Reads only the `hd` claim of the verified ID token: never the `hd` URL
 * parameter ("Don't rely on this UI optimization to control who can access your app, as
 * client-side requests can be modified") and never the email domain ("You also can't rely on the
 * domain of the email claim to identify users of Google Workspace or Cloud organizations"). Google:
 * "You must check this claim when restricting access to a resource to only members of certain
 * domains"; an absent `hd` means "the account does not belong to a Google hosted domain"
 * (https://developers.google.com/identity/openid-connect/openid-connect, read 2026-11-22).
 *
 * - `allowedDomains` non-empty: `hd` must be present and listed.
 * - `allowedDomains` empty and consumer accounts refused: `hd` must be present.
 * - Otherwise allowed.
 *
 * Returns the lowercased `hd` (undefined for none) when allowed; throws `IdentitySourceRefused`
 * (the kernel shows `sso.account_not_allowed`) otherwise. The message names the domain only, never
 * the email.
 */
export function hostedDomainGate(
  claims: { readonly hd?: unknown; readonly [claim: string]: unknown },
  policy: HostedDomainPolicy,
): string | undefined {
  const hd = hostedDomainOf(claims);
  if (hd !== undefined && !HOSTNAME.test(hd)) refuse("(invalid)");
  if (policy.allowedDomains.length > 0) {
    if (hd === undefined || !policy.allowedDomains.includes(hd)) refuse(hd ?? "none");
    return hd;
  }
  if (hd === undefined && !policy.allowConsumerAccounts) refuse("none");
  return hd;
}

/**
 * Whether Google is authoritative for the account's email. Google: "If the email has a gmail.com
 * suffix" or "If email_verified is true and hd is set", Google is authoritative; otherwise "Google
 * is not authoritative and password or other challenge methods are recommended"
 * (https://developers.google.com/identity/gsi/web/guides/verify-google-id-token, read 2026-11-22).
 * Only the boolean `true` counts as verified (never the string "true"), and a gmail.com address
 * still needs `email_verified`: the conservative reading, which may skip a merge but never makes
 * one Google does not vouch for. A consumer account on another domain (alice@customer.com, no
 * `hd`) is never authoritative: anyone can create a Google account on any address.
 */
export function emailIsAuthoritative(claims: {
  email?: unknown;
  email_verified?: unknown;
  hd?: unknown;
}): boolean {
  const email = emailOf(claims);
  if (email === undefined || claims.email_verified !== true) return false;
  return hostedDomainOf(claims) !== undefined || /^[^@]+@gmail\.com$/.test(email);
}

const cap = (s: string) => s.slice(0, DISPLAY_NAME_CHARS);

/**
 * The kernel identity of verified claims and the gate's `hd` (spec §4.4): `externalId = sub`
 * (Google: use `sub` as the unique identifier, never the email), tenant = `hd` or `consumer`,
 * `source = google:<tenant>`.
 */
export function toExternalIdentity(
  claims: Record<string, unknown>,
  hd: string | undefined,
): ExternalIdentity {
  // exact, untrimmed: the signed identifier
  const sub = typeof claims.sub === "string" && claims.sub !== "" ? claims.sub : undefined;
  if (sub === undefined) throw new Error("Google ID token rejected: no sub");
  const tenantId = hd ?? CONSUMER_TENANT;
  const email = emailOf(claims);
  const fullName = [nonEmpty(claims.given_name), nonEmpty(claims.family_name)]
    .filter((p) => p !== undefined)
    .join(" ");
  const displayName =
    nonEmpty(claims.name) ?? nonEmpty(fullName) ?? nonEmpty(email?.split("@")[0]) ?? sub;
  const avatarUrl = httpsUrl(claims.picture);
  return {
    source: `google:${tenantId}`,
    externalId: sub,
    tenantId,
    ...(email !== undefined && { email }),
    // authority from the gated hd, so the tenant and emailVerified can never disagree
    emailVerified: email !== undefined && emailIsAuthoritative({ ...claims, hd }),
    displayName: cap(displayName),
    ...(avatarUrl !== undefined && { avatarUrl }),
  };
}

function httpsUrl(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  try {
    return new URL(v).protocol === "https:" ? v : undefined;
  } catch {
    return undefined;
  }
}
