import { generateKeyPairSync, type KeyObject } from "node:crypto";
import type { ApnsDeployment } from "../src/config.js";

/** A fresh EC P-256 key pair: the private key as a `.p8` PEM (PKCS#8), the public key object. */
export function testSigningKey(): { pem: string; publicKey: KeyObject } {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return { pem: privateKey.export({ format: "pem", type: "pkcs8" }).toString(), publicKey };
}

export const KEY_ID = "ABC123DEFG";
export const TEAM_ID = "TEAM123456";

export function testConfig(pem: string, over: Partial<ApnsDeployment> = {}): ApnsDeployment {
  return {
    key: pem,
    keyId: KEY_ID,
    teamId: TEAM_ID,
    bundles: [{ bundleId: "com.example.app", environment: "sandbox" }],
    ...over,
  };
}

/** An in-memory `ctx.kv` that records every write with its TTL. */
export function memoryKv() {
  const data = new Map<string, string>();
  const writes: { key: string; ttlSeconds: number }[] = [];
  const dels: string[] = [];
  return {
    data,
    writes,
    dels,
    async get(key: string) {
      return data.get(key) ?? null;
    },
    async set(key: string, value: string, opts: { ttlSeconds: number }) {
      writes.push({ key, ttlSeconds: opts.ttlSeconds });
      data.set(key, value);
    },
    async del(key: string) {
      dels.push(key);
      data.delete(key);
    },
    async incr(key: string, opts: { ttlSeconds: number }) {
      writes.push({ key, ttlSeconds: opts.ttlSeconds });
      const n = Number(data.get(key) ?? "0") + 1;
      data.set(key, String(n));
      return n;
    },
  };
}

/** Decodes a JWT's three parts (no verification). */
export function decodeJwt(jwt: string): { header: unknown; claims: unknown; sig: Buffer } {
  const [h, c, s] = jwt.split(".") as [string, string, string];
  return {
    header: JSON.parse(Buffer.from(h, "base64url").toString("utf8")),
    claims: JSON.parse(Buffer.from(c, "base64url").toString("utf8")),
    sig: Buffer.from(s, "base64url"),
  };
}
