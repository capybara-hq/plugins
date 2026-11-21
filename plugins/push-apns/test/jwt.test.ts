import { generateKeyPairSync, verify } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  ApnsKeyError,
  JWT_CACHE_TTL_SECONDS,
  jwtCacheKey,
  loadSigningKey,
  providerToken,
  signProviderToken,
} from "../src/jwt.js";
import { decodeJwt, KEY_ID, memoryKv, TEAM_ID, testConfig, testSigningKey } from "./helpers.js";

const NOW = Date.UTC(2026, 10, 21, 8, 0, 0);

describe("signProviderToken", () => {
  it("signs an ES256 JWT with kid in the header and iss / iat claims that the public key verifies", () => {
    const { pem, publicKey } = testSigningKey();
    const jwt = signProviderToken(loadSigningKey(pem), {
      keyId: KEY_ID,
      teamId: TEAM_ID,
      nowMs: NOW,
    });
    const { header, claims, sig } = decodeJwt(jwt);
    expect(header).toEqual({ alg: "ES256", kid: KEY_ID });
    expect(claims).toEqual({ iss: TEAM_ID, iat: Math.floor(NOW / 1000) });
    expect(sig).toHaveLength(64); // raw r || s, as JOSE requires
    const signed = Buffer.from(jwt.slice(0, jwt.lastIndexOf(".")));
    expect(verify("sha256", signed, { key: publicKey, dsaEncoding: "ieee-p1363" }, sig)).toBe(true);
  });

  it.each([
    ["literal \\n sequences (an env var)", (p: string) => p.replaceAll("\n", "\\n")],
    ["one line (a single-line input drops the newlines)", (p: string) => p.replaceAll("\n", "")],
    ["spaces for newlines", (p: string) => p.replaceAll("\n", " ")],
    ["CRLF line ends and surrounding blanks", (p: string) => `  ${p.replaceAll("\n", "\r\n")}  `],
  ])("accepts a key pasted with %s and signs the same as the original", (_l, mangle) => {
    const { pem, publicKey } = testSigningKey();
    const jwt = signProviderToken(loadSigningKey(mangle(pem)), {
      keyId: KEY_ID,
      teamId: TEAM_ID,
      nowMs: NOW,
    });
    const { sig } = decodeJwt(jwt);
    const signed = Buffer.from(jwt.slice(0, jwt.lastIndexOf(".")));
    expect(verify("sha256", signed, { key: publicKey, dsaEncoding: "ieee-p1363" }, sig)).toBe(true);
  });

  it.each([
    ["garbage", "garbage"],
    ["an RSA key", "rsa"],
    ["a public key", "public"],
  ])("refuses %s with an ApnsKeyError that does not echo the key", (_l, kind) => {
    const { pem, publicKey } = testSigningKey();
    let input = "not a key: SENTINEL-1f2e3d4c5b6a SENTINEL-1f2e3d4c5b6a";
    if (kind === "public") input = publicKey.export({ format: "pem", type: "spki" }).toString();
    if (kind === "rsa") input = rsaPem();
    let error: unknown;
    try {
      loadSigningKey(input);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ApnsKeyError);
    const message = (error as Error).message;
    expect(message).not.toContain("SENTINEL");
    for (const line of [...input.split("\n"), ...pem.split("\n")]) {
      if (line.length > 0 && !line.startsWith("-----"))
        expect(message).not.toContain(line.slice(0, 16));
    }
  });
});

describe("providerToken", () => {
  it("caches the token in ctx.kv under apns-jwt-<keyId> for 40 minutes and reuses it", async () => {
    const { pem, publicKey } = testSigningKey();
    const kv = memoryKv();
    const cfg = testConfig(pem);
    const first = await providerToken(kv, cfg, NOW);
    const second = await providerToken(kv, cfg, NOW + 39 * 60_000);
    expect(second).toBe(first);
    expect(JWT_CACHE_TTL_SECONDS).toBe(40 * 60);
    expect(kv.writes).toEqual([{ key: `apns-jwt-${KEY_ID}`, ttlSeconds: 2400 }]);
    expect(jwtCacheKey(KEY_ID)).toBe(`apns-jwt-${KEY_ID}`);
    // what kv holds never contains the private key
    expect([...kv.data.values()].join()).not.toContain(pem.split("\n")[1]);
    const { sig } = decodeJwt(first);
    const signed = Buffer.from(first.slice(0, first.lastIndexOf(".")));
    expect(verify("sha256", signed, { key: publicKey, dsaEncoding: "ieee-p1363" }, sig)).toBe(true);
  });

  it("signs anew when the cached token was made from another key or team", async () => {
    const a = testSigningKey();
    const b = testSigningKey();
    const kv = memoryKv();
    const first = await providerToken(kv, testConfig(a.pem), NOW);
    const second = await providerToken(kv, testConfig(b.pem), NOW);
    const third = await providerToken(kv, testConfig(b.pem, { teamId: "OTHERTEAM1" }), NOW);
    expect(new Set([first, second, third]).size).toBe(3);
    expect(kv.writes).toHaveLength(3);
  });

  it("signs anew once the cached entry is gone", async () => {
    const { pem } = testSigningKey();
    const kv = memoryKv();
    const cfg = testConfig(pem);
    const first = await providerToken(kv, cfg, NOW);
    kv.data.clear();
    const second = await providerToken(kv, cfg, NOW + 1000);
    expect(second).not.toBe(first);
  });
});

function rsaPem(): string {
  return generateKeyPairSync("rsa", { modulusLength: 1024 })
    .privateKey.export({ format: "pem", type: "pkcs8" })
    .toString();
}
