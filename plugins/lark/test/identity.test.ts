import { createHash } from "node:crypto";
import { type FakeLarkServer, startFakeLark } from "@capybara-hq/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLarkIdentitySource } from "../src/identity.js";

let lark: FakeLarkServer;
const REDIRECT = "https://cap.example/api/v1/auth/sso/lark/callback";
const VERIFIER = "pkce-verifier-0123456789-abcdefghijklmnopqrstuvwxyz";
const CHALLENGE = createHash("sha256").update(VERIFIER).digest("base64url");

beforeAll(async () => {
  lark = await startFakeLark({ tenantKey: "t1", appSecret: "lark-login-secret-9a8b" });
  lark.users.set("ou_alice", {
    openId: "ou_alice",
    name: "Alice Liddell",
    email: "alice@corp.example",
    avatar72: "https://avatars.example/alice.png",
  });
  lark.users.set("ou_bob", {
    openId: "ou_bob",
    name: "",
    enName: "Bob",
    enterpriseEmail: "bob@mail.corp.example",
    avatar72: "javascript:alert(1)",
  });
  lark.users.set("ou_noemail", { openId: "ou_noemail", name: "No Email" });
  lark.users.set("ou_mallory", { openId: "ou_mallory", name: "Mallory", tenantKey: "t_other" });
});
afterAll(async () => {
  await lark?.stop();
});

const config = (o: Record<string, unknown> = {}) => ({
  apiUrl: lark.url,
  accountsUrl: lark.url,
  appId: lark.appId,
  appSecret: lark.appSecret,
  ...o,
});
const source = () => createLarkIdentitySource();
const signal = () => AbortSignal.timeout(10_000);

/** 发起授权并让假 Lark 以 `as` 同意，返回回调查询参数。 */
async function authorize(as: string, o: { pkce?: boolean; state?: string } = {}) {
  const url = source().authorizeUrl({
    config: config(),
    redirectUri: REDIRECT,
    state: o.state ?? "state-xyz",
    nonce: "nonce-abc",
    ...(o.pkce !== false && { codeChallenge: CHALLENGE, codeChallengeMethod: "S256" as const }),
  });
  const res = await fetch(`${url}&as=${as}`, { redirect: "manual" });
  expect(res.status).toBe(302);
  const back = new URL(res.headers.get("location") ?? "");
  expect(back.origin + back.pathname).toBe(REDIRECT);
  return Object.fromEntries(back.searchParams) as Record<string, string>;
}

const callback = (
  query: Record<string, string>,
  o: { verifier?: string; redirect?: string } = {},
) =>
  source().callback({
    config: config(),
    redirectUri: o.redirect ?? REDIRECT,
    query,
    nonce: "nonce-abc",
    signal: signal(),
    ...(o.verifier !== "" && { codeVerifier: o.verifier ?? VERIFIER }),
  });

describe("Lark login: authorizeUrl", () => {
  it("builds the web-app authorize URL with PKCE (S256) and no scope (Ruling A31)", () => {
    const u = new URL(
      source().authorizeUrl({
        config: config(),
        redirectUri: REDIRECT,
        state: "st",
        nonce: "nn",
        codeChallenge: "cc",
        codeChallengeMethod: "S256",
      }),
    );
    expect(u.origin + u.pathname).toBe(`${lark.url}/open-apis/authen/v1/authorize`);
    expect(Object.fromEntries(u.searchParams)).toEqual({
      client_id: lark.appId,
      redirect_uri: REDIRECT,
      state: "st",
      code_challenge: "cc",
      code_challenge_method: "S256",
    });
    expect(u.searchParams.has("scope")).toBe(false);
  });

  it("defaults to accounts.larksuite.com; omits PKCE when the kernel gives none", () => {
    const u = new URL(
      source().authorizeUrl({
        config: { appId: lark.appId, appSecret: "x" },
        redirectUri: REDIRECT,
        state: "st",
        nonce: "nn",
      }),
    );
    expect(u.origin + u.pathname).toBe(
      "https://accounts.larksuite.com/open-apis/authen/v1/authorize",
    );
    expect(u.searchParams.has("code_challenge")).toBe(false);
    expect(u.searchParams.has("code_challenge_method")).toBe(false);
  });

  it("throws when the deployment config has no appId / appSecret", () => {
    for (const c of [{}, { appId: lark.appId }, { appSecret: "s" }]) {
      expect(() =>
        source().authorizeUrl({ config: c, redirectUri: REDIRECT, state: "s", nonce: "n" }),
      ).toThrow(/not configured/);
    }
  });
});

describe("Lark login: callback", () => {
  it("code + PKCE verifier → user_access_token → user info; key lark:<tenant_key> + open_id", async () => {
    const before = lark.calls.length;
    const q = await authorize("ou_alice");
    expect(q.state).toBe("state-xyz");
    expect(await callback(q)).toEqual({
      source: "lark:t1",
      externalId: "ou_alice",
      tenantId: "t1",
      email: "alice@corp.example",
      emailVerified: false,
      displayName: "Alice Liddell",
      avatarUrl: "https://avatars.example/alice.png",
    });
    const calls = lark.calls.slice(before);
    const tok = calls.find((c) => c.api === "oauth_token");
    expect(tok?.body).toEqual({
      grant_type: "authorization_code",
      client_id: lark.appId,
      client_secret: lark.appSecret,
      code: q.code,
      redirect_uri: REDIRECT,
      code_verifier: VERIFIER,
    });
    expect(calls.find((c) => c.api === "user_info")?.token.startsWith("u-fake-")).toBe(true);
    // 租户核对用的是登录应用自己的 tenant token
    expect(calls.some((c) => c.api === "tenant")).toBe(true);
  });

  it("falls back to enterprise_email / en_name; drops non-http avatars", async () => {
    const id = await callback(await authorize("ou_bob"));
    expect(id).toEqual({
      source: "lark:t1",
      externalId: "ou_bob",
      tenantId: "t1",
      email: "bob@mail.corp.example",
      emailVerified: false,
      displayName: "Bob",
    });
  });

  it("no email in user info (scope not granted) → identity without email", async () => {
    const id = await callback(await authorize("ou_noemail"));
    expect(id).toEqual({
      source: "lark:t1",
      externalId: "ou_noemail",
      tenantId: "t1",
      emailVerified: false,
      displayName: "No Email",
    });
  });

  it("works without PKCE (older kernel)", async () => {
    const id = await callback(await authorize("ou_alice", { pkce: false }), { verifier: "" });
    expect(id.externalId).toBe("ou_alice");
  });

  it("wrong PKCE verifier → error with the Lark code, never the secret", async () => {
    const err = await callback(await authorize("ou_alice"), {
      verifier: "wrong-verifier-0123456789-abcdefghijklmnopqrstuvwxyz",
    }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/code 20049/);
    expect((err as Error).message).not.toContain(lark.appSecret);
  });

  it("an authorization code works once", async () => {
    const q = await authorize("ou_alice");
    await callback(q);
    await expect(callback(q)).rejects.toThrow(/code 20065/);
  });

  it("bad code / redirect_uri mismatch are rejected", async () => {
    await expect(callback({ code: "nope", state: "s" })).rejects.toThrow(/code 20003/);
    await expect(
      callback(await authorize("ou_alice"), { redirect: "https://evil.example/cb" }),
    ).rejects.toThrow(/code 20071/);
  });

  it("provider error (access_denied) and missing code", async () => {
    await expect(callback({ error: "access_denied", state: "s" })).rejects.toThrow(/access_denied/);
    await expect(callback({ state: "s" })).rejects.toThrow(/code missing/);
    // 假 Lark 对未知用户回 access_denied
    const q = await authorize("ou_nobody");
    expect(q.error).toBe("access_denied");
  });

  it("user from another tenant than the login app → rejected", async () => {
    await expect(callback(await authorize("ou_mallory"))).rejects.toThrow(/tenant/);
  });

  it("user info failure → error (no token in the message)", async () => {
    lark.failNext("user_info", { status: 500, code: 20050 });
    const err = await callback(await authorize("ou_alice")).catch((e: Error) => e);
    expect((err as Error).message).toMatch(/user info failed: code 20050 \(HTTP 500\)/);
    expect((err as Error).message).not.toMatch(/u-fake-/);
  });

  it("wrong app secret → token exchange error without the secret", async () => {
    const q = await authorize("ou_alice");
    const err = await source()
      .callback({
        config: config({ appSecret: "totally-wrong-secret-77" }),
        redirectUri: REDIRECT,
        query: q,
        nonce: "n",
        signal: signal(),
        codeVerifier: VERIFIER,
      })
      .catch((e: Error) => e);
    expect((err as Error).message).toMatch(/OAuth token exchange failed: code 20002/);
    expect((err as Error).message).not.toContain("totally-wrong");
  });
});
