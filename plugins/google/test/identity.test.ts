import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { isIdentitySourceRefused } from "@capybara-hq/plugin-sdk";
import { exportJWK, generateKeyPair, type JWK, SignJWT } from "jose";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createGoogleIdentitySource } from "../src/identity.js";

/**
 * A local Google: `/jwks` serves the current public keys, `/token` answers the code exchange with
 * whatever the test arranged. Keys come from jose; tokens are signed by the test.
 */
type Key = Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];
interface SigningKey {
  kid: string;
  privateKey: Key;
  jwk: JWK;
}

const CLIENT_ID = "cli-123.apps.googleusercontent.com";
const CLIENT_SECRET = "google-secret-9d1c";
const NONCE = "nonce-abc-123";
const CODE = "auth-code-xyz";
const VERIFIER = "pkce-verifier-0123456789";
const REDIRECT = "https://cap.example/api/v1/auth/sso/google/callback";

async function newKey(kid: string): Promise<SigningKey> {
  const { privateKey, publicKey } = await generateKeyPair("RS256", { extractable: true });
  const jwk = { ...(await exportJWK(publicKey)), kid, alg: "RS256", use: "sig" };
  return { kid, privateKey, jwk };
}

let server: Server;
let base: string;
let published: SigningKey[];
let jwksFetches: number;
let tokenRequests: { body: URLSearchParams; contentType: string | undefined }[];
let answer: (() => { status: number; body: unknown } | "hang") | undefined;
let keyA: SigningKey;

beforeAll(async () => {
  keyA = await newKey("key-a");
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => {
      raw += c;
    });
    req.on("end", () => {
      if (req.url === "/jwks") {
        jwksFetches++;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ keys: published.map((k) => k.jwk) }));
        return;
      }
      if (req.url === "/token" && req.method === "POST") {
        tokenRequests.push({
          body: new URLSearchParams(raw),
          contentType: req.headers["content-type"],
        });
        const a = answer?.() ?? { status: 500, body: {} };
        if (a === "hang") return; // never answers
        res.writeHead(a.status, { "content-type": "application/json" });
        res.end(JSON.stringify(a.body));
        return;
      }
      res.writeHead(404).end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
});
beforeEach(() => {
  published = [keyA];
  jwksFetches = 0;
  tokenRequests = [];
  answer = undefined;
});
afterEach(() => {
  vi.useRealTimers();
});

const config = (over: Record<string, unknown> = {}) => ({
  clientId: CLIENT_ID,
  clientSecret: CLIENT_SECRET,
  allowedDomains: ["example.com"],
  endpoints: {
    authorizationUrl: `${base}/authorize`,
    tokenUrl: `${base}/token`,
    jwksUrl: `${base}/jwks`,
    issuers: ["https://accounts.google.com", "accounts.google.com"],
  },
  ...over,
});

interface TokenOpts {
  key?: SigningKey;
  claims?: Record<string, unknown>;
  omit?: string[];
  iat?: number;
  exp?: number;
}

async function idToken(o: TokenOpts = {}): Promise<string> {
  const key = o.key ?? keyA;
  const now = Math.floor(Date.now() / 1000);
  const claims: Record<string, unknown> = {
    iss: "https://accounts.google.com",
    aud: CLIENT_ID,
    azp: CLIENT_ID,
    sub: "1001",
    nonce: NONCE,
    hd: "example.com",
    email: "alice@example.com",
    email_verified: true,
    name: "Alice",
    iat: o.iat ?? now,
    exp: o.exp ?? now + 3600,
    ...o.claims,
  };
  for (const k of o.omit ?? []) delete claims[k];
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: key.kid, typ: "JWT" })
    .sign(key.privateKey);
}

function serve(token: string) {
  answer = () => ({ status: 200, body: { id_token: token, access_token: "ya29.access-token" } });
}

const source = createGoogleIdentitySource();

function login(o: { cfg?: unknown; signal?: AbortSignal; query?: Record<string, string> } = {}) {
  return source.callback({
    config: o.cfg ?? config(),
    redirectUri: REDIRECT,
    query: o.query ?? { code: CODE, state: "s" },
    nonce: NONCE,
    signal: o.signal ?? new AbortController().signal,
    codeVerifier: VERIFIER,
  });
}

/** Every error text must be free of the code, secret, verifier and any issued token. */
const errors: string[] = [];
async function rejection(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (e) {
    errors.push((e as Error).message);
    return e as Error;
  }
  throw new Error("expected a rejection");
}

describe("authorizeUrl", () => {
  const url = (cfg: unknown) =>
    new URL(
      source.authorizeUrl({
        config: cfg,
        redirectUri: REDIRECT,
        state: "st",
        nonce: NONCE,
        codeChallenge: "chal",
        codeChallengeMethod: "S256",
      }),
    );

  it("carries the client, PKCE S256, the nonce and select_account, never access_type", () => {
    const u = url(config());
    expect(`${u.origin}${u.pathname}`).toBe(`${base}/authorize`);
    expect(Object.fromEntries(u.searchParams)).toEqual({
      response_type: "code",
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT,
      scope: "openid email profile",
      state: "st",
      nonce: NONCE,
      code_challenge: "chal",
      code_challenge_method: "S256",
      prompt: "select_account",
      hd: "example.com",
    });
    expect(u.searchParams.has("access_type")).toBe(false);
    expect(u.toString()).not.toContain(CLIENT_SECRET);
  });

  it("sends the hd hint only with exactly one allowed domain", () => {
    expect(url(config({ allowedDomains: [] })).searchParams.has("hd")).toBe(false);
    expect(url(config({ allowedDomains: ["a.example", "b.example"] })).searchParams.has("hd")).toBe(
      false,
    );
  });

  it("uses Google's endpoint by default", () => {
    const u = url({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
    expect(`${u.origin}${u.pathname}`).toBe("https://accounts.google.com/o/oauth2/v2/auth");
  });

  it("throws while not configured", () => {
    expect(() => url({})).toThrow(/not configured/);
  });
});

describe("callback", () => {
  it("exchanges the code with client_secret_post and the verifier, and maps the identity", async () => {
    serve(await idToken());
    const id = await login();
    expect(id).toMatchObject({
      source: "google:example.com",
      externalId: "1001",
      tenantId: "example.com",
      email: "alice@example.com",
      emailVerified: true,
      displayName: "Alice",
    });
    expect(tokenRequests).toHaveLength(1);
    expect(tokenRequests[0]?.contentType).toBe("application/x-www-form-urlencoded");
    expect(Object.fromEntries(tokenRequests[0]?.body ?? [])).toEqual({
      grant_type: "authorization_code",
      code: CODE,
      redirect_uri: REDIRECT,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      code_verifier: VERIFIER,
    });
  });

  it("throws before any request on an authorization error or a missing code", async () => {
    expect((await rejection(login({ query: { error: "access_denied" } }))).message).toBe(
      "Google authorization failed: access_denied",
    );
    expect((await rejection(login({ query: { error: "Evil\nlog line <script>" } }))).message).toBe(
      "Google authorization failed: invalid error parameter",
    );
    expect((await rejection(login({ query: { state: "s" } }))).message).toContain("code missing");
    expect(tokenRequests).toHaveLength(0);
  });

  it.each(["https://accounts.google.com", "accounts.google.com"])("accepts iss %s", async (iss) => {
    serve(await idToken({ claims: { iss } }));
    expect((await login()).externalId).toBe("1001");
  });

  it.each([
    ["an unknown iss", { claims: { iss: "https://evil.example" } }, "iss"],
    ["a wrong aud", { claims: { aud: "other-client" } }, "aud"],
    ["an expired token", { exp: Math.floor(Date.now() / 1000) - 120 }, "ERR_JWT_EXPIRED"],
    ["a missing nonce", { omit: ["nonce"] }, "nonce"],
    ["a wrong nonce", { claims: { nonce: "nonce-abc-124" } }, "nonce mismatch"],
    ["a longer nonce", { claims: { nonce: `${NONCE}x` } }, "nonce mismatch"],
    ["a numeric nonce", { claims: { nonce: 42 } }, "nonce mismatch"],
    ["an azp of another client", { claims: { azp: "other-client" } }, "azp mismatch"],
    [
      "several audiences without azp",
      { claims: { aud: [CLIENT_ID, "other-client"] }, omit: ["azp"] },
      "azp mismatch",
    ],
    ["a missing sub", { omit: ["sub"] }, "sub"],
    ["a missing iat", { omit: ["iat"] }, "iat"],
    ["an iat 5 minutes ahead", { iat: Math.floor(Date.now() / 1000) + 300 }, "iat"],
    ["an iat over an hour old", { iat: Math.floor(Date.now() / 1000) - 3800 }, "ERR_JWT_EXPIRED"],
    ["an nbf in the future", { claims: { nbf: Math.floor(Date.now() / 1000) + 300 } }, "nbf"],
  ] as const)("refuses %s", async (_name, opts, reason) => {
    serve(await idToken(opts as TokenOpts));
    const err = await rejection(login());
    expect(err.message).toMatch(/^Google ID token rejected: /);
    expect(err.message).toContain(reason);
    expect(isIdentitySourceRefused(err)).toBe(false);
  });

  it("accepts tolerated clock skew: expired 30 s ago, issued 30 s ahead, absent azp", async () => {
    const now = Math.floor(Date.now() / 1000);
    serve(await idToken({ exp: now - 30 }));
    expect((await login()).externalId).toBe("1001");
    serve(await idToken({ iat: now + 30 }));
    expect((await login()).externalId).toBe("1001");
    serve(await idToken({ omit: ["azp"] }));
    expect((await login()).externalId).toBe("1001");
  });

  it("refuses a signature by a key not in the JWKS", async () => {
    const foreign = await newKey("key-a"); // same kid, other key
    serve(await idToken({ key: foreign }));
    expect((await rejection(login())).message).toMatch(/^Google ID token rejected: ERR_JWS/);
  });

  it("refuses an HS256 token", async () => {
    const now = Math.floor(Date.now() / 1000);
    const hs = await new SignJWT({
      iss: "https://accounts.google.com",
      aud: CLIENT_ID,
      sub: "1001",
      nonce: NONCE,
      hd: "example.com",
      iat: now,
      exp: now + 3600,
    })
      .setProtectedHeader({ alg: "HS256", kid: "key-a" })
      .sign(new TextEncoder().encode(CLIENT_SECRET));
    serve(hs);
    expect((await rejection(login())).message).toContain("ERR_JOSE_ALG_NOT_ALLOWED");
  });

  it("rotated key: a token signed with a newly published key verifies without a restart", async () => {
    const rotating = createGoogleIdentitySource();
    const run = () =>
      rotating.callback({
        config: config(),
        redirectUri: REDIRECT,
        query: { code: CODE },
        nonce: NONCE,
        signal: new AbortController().signal,
        codeVerifier: VERIFIER,
      });
    serve(await idToken());
    await run();
    const fetchesBefore = jwksFetches;
    // Google publishes key B and starts signing with it; jose's 30-second refetch cooldown passes.
    const keyB = await newKey("key-b");
    published = [keyA, keyB];
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 31_000 });
    serve(await idToken({ key: keyB }));
    expect((await run()).externalId).toBe("1001");
    expect(jwksFetches).toBe(fetchesBefore + 1);
  });

  it("propagates the hosted-domain refusal as IdentitySourceRefused", async () => {
    serve(await idToken({ claims: { hd: "evil.example" } }));
    const err = await rejection(login());
    expect(isIdentitySourceRefused(err)).toBe(true);
    expect(err.message).toBe(
      "Google account not allowed: hosted domain evil.example is not permitted",
    );
  });

  it("reports only Google's error code on a refused exchange", async () => {
    answer = () => ({
      status: 400,
      body: { error: "invalid_grant", error_description: `bad ${CODE} ${CLIENT_SECRET}` },
    });
    expect((await rejection(login())).message).toBe("Google token exchange failed: invalid_grant");
    answer = () => ({ status: 401, body: { error: "Not A Code!" } });
    expect((await rejection(login())).message).toBe("Google token exchange failed: HTTP 401");
    answer = () => ({ status: 302, body: {} });
    expect((await rejection(login())).message).toBe("Google token exchange failed: HTTP 302");
    answer = () => ({ status: 200, body: { id_token: "x", pad: "p".repeat(70_000) } });
    expect((await rejection(login())).message).toBe("Google token exchange failed: no id_token");
    answer = () => ({ status: 200, body: { access_token: "ya29.only-access" } });
    expect((await rejection(login())).message).toBe("Google token exchange failed: no id_token");
  });

  it("hung token endpoint: the abort ends the exchange as a network error", async () => {
    answer = () => "hang";
    const ac = new AbortController();
    const p = login({ signal: ac.signal });
    await vi.waitFor(() => expect(tokenRequests).toHaveLength(1));
    ac.abort();
    expect((await rejection(p)).message).toBe("Google token exchange failed: network error");
  });

  it("no error text carries the code, the secret, the verifier or a token", async () => {
    // runs last in this file: `errors` holds every rejection above
    serve(await idToken({ claims: { aud: "other" } }));
    const t = (await rejection(login())).message;
    expect(errors.length).toBeGreaterThan(10);
    for (const msg of [...errors, t]) {
      expect(msg).not.toContain(CODE);
      expect(msg).not.toContain(CLIENT_SECRET);
      expect(msg).not.toContain(VERIFIER);
      expect(msg).not.toContain("ya29.");
      expect(msg).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}/);
    }
  });
});
