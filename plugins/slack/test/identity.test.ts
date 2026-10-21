import { type FakeSlackServer, startFakeSlack } from "@capybara-hq/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSlackIdentitySource } from "../src/identity.js";

let slack: FakeSlackServer;
const REDIRECT = "https://cap.example/api/v1/auth/sso/slack/callback";

beforeAll(async () => {
  slack = await startFakeSlack({
    teamId: "T1",
    clientId: "cli-123",
    clientSecret: "shh-secret-42",
  });
  slack.users.set("U1", {
    id: "U1",
    teamId: "T1",
    name: "alice",
    realName: "Alice Liddell",
    email: "alice@corp.example",
    emailVerified: true,
    image72: "https://avatars.example/u1.png",
  });
  slack.users.set("U2", {
    id: "U2",
    teamId: "T1",
    name: "bob",
    realName: "Bob",
    email: "bob@corp.example",
    emailVerified: false,
  });
});
afterAll(async () => {
  await slack?.stop();
});

const config = () => ({
  apiUrl: slack.apiUrl,
  openidUrl: `${slack.url}/`,
  clientId: "cli-123",
  clientSecret: "shh-secret-42",
});
const source = () => createSlackIdentitySource();
const signal = () => AbortSignal.timeout(10_000);

/** 发起授权并让假 Slack 以 `as` 登录，返回回调查询参数。 */
async function authorize(as: string, nonce = "nonce-abc", state = "state-xyz") {
  const url = source().authorizeUrl({
    config: config(),
    redirectUri: REDIRECT,
    state,
    nonce,
    codeChallenge: "challenge-ignored",
    codeChallengeMethod: "S256",
  });
  const res = await fetch(`${url}&as=${as}`, { redirect: "manual" });
  expect(res.status).toBe(302);
  const back = new URL(res.headers.get("location") ?? "");
  expect(back.origin + back.pathname).toBe(REDIRECT);
  return Object.fromEntries(back.searchParams) as Record<string, string>;
}

describe("Sign in with Slack: authorizeUrl", () => {
  it("builds the OpenID Connect authorize URL (no PKCE: Slack OIDC does not document it)", () => {
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
    expect(u.origin + u.pathname).toBe(`${slack.url}/openid/connect/authorize`);
    expect(Object.fromEntries(u.searchParams)).toEqual({
      response_type: "code",
      scope: "openid email profile",
      client_id: "cli-123",
      redirect_uri: REDIRECT,
      state: "st",
      nonce: "nn",
    });
  });

  it("defaults to slack.com", () => {
    const u = new URL(
      source().authorizeUrl({
        config: { clientId: "c", clientSecret: "s" },
        redirectUri: REDIRECT,
        state: "st",
        nonce: "nn",
      }),
    );
    expect(u.origin + u.pathname).toBe("https://slack.com/openid/connect/authorize");
  });

  it("refuses when the deployment has no client id / secret", () => {
    expect(() =>
      source().authorizeUrl({ config: {}, redirectUri: REDIRECT, state: "s", nonce: "n" }),
    ).toThrow(/clientId and clientSecret/);
  });
});

describe("Sign in with Slack: callback", () => {
  it("exchanges the code, verifies the ID token and returns slack:<team> / user id", async () => {
    const query = await authorize("U1");
    expect(query.state).toBe("state-xyz");
    const before = slack.calls.length;
    const id = await source().callback({
      config: config(),
      redirectUri: REDIRECT,
      query,
      nonce: "nonce-abc",
      signal: signal(),
      codeVerifier: "verifier-ignored",
    });
    expect(id).toEqual({
      source: "slack:T1",
      externalId: "U1",
      tenantId: "T1",
      email: "alice@corp.example",
      emailVerified: true,
      displayName: "Alice Liddell",
      avatarUrl: "https://avatars.example/u1.png",
    });
    const token = slack.calls.slice(before).find((c) => c.method === "openid.connect.token");
    expect(token?.body).toEqual({
      client_id: "cli-123",
      client_secret: "shh-secret-42",
      code: query.code,
      redirect_uri: REDIRECT,
    });
    expect(slack.calls.slice(before).some((c) => c.method === "openid.connect.userInfo")).toBe(
      true,
    );
  });

  it("unverified email stays unverified", async () => {
    const id = await source().callback({
      config: config(),
      redirectUri: REDIRECT,
      query: await authorize("U2"),
      nonce: "nonce-abc",
      signal: signal(),
    });
    expect(id).toMatchObject({ externalId: "U2", email: "bob@corp.example", emailVerified: false });
  });

  it("rejects a nonce that does not match", async () => {
    const query = await authorize("U1", "nonce-one");
    await expect(
      source().callback({
        config: config(),
        redirectUri: REDIRECT,
        query,
        nonce: "nonce-two",
        signal: signal(),
      }),
    ).rejects.toThrow(/nonce/);
  });

  it("rejects an ID token for another audience", async () => {
    const query = await authorize("U1");
    slack.tamperNextIdToken({ aud: "someone-else" });
    await expect(
      source().callback({
        config: config(),
        redirectUri: REDIRECT,
        query,
        nonce: "nonce-abc",
        signal: signal(),
      }),
    ).rejects.toThrow(/aud/);
  });

  it("rejects an ID token from another issuer or signed with an unknown key", async () => {
    let query = await authorize("U1");
    slack.tamperNextIdToken({ iss: "https://evil.example" });
    await expect(
      source().callback({
        config: config(),
        redirectUri: REDIRECT,
        query,
        nonce: "nonce-abc",
        signal: signal(),
      }),
    ).rejects.toThrow(/iss/);
    query = await authorize("U1");
    slack.tamperNextIdToken({}, { foreignKey: true });
    await expect(
      source().callback({
        config: config(),
        redirectUri: REDIRECT,
        query,
        nonce: "nonce-abc",
        signal: signal(),
      }),
    ).rejects.toThrow(/signature|key/i);
  });

  it("rejects an ID token without exp, or signed with an unknown key id", async () => {
    let query = await authorize("U1");
    slack.tamperNextIdToken({ exp: undefined });
    await expect(
      source().callback({
        config: config(),
        redirectUri: REDIRECT,
        query,
        nonce: "nonce-abc",
        signal: signal(),
      }),
    ).rejects.toThrow(/exp/);
    query = await authorize("U1");
    slack.tamperNextIdToken({}, { kid: "unknown-kid" });
    await expect(
      source().callback({
        config: config(),
        redirectUri: REDIRECT,
        query,
        nonce: "nonce-abc",
        signal: signal(),
      }),
    ).rejects.toThrow(/key/i);
  });

  it("rejects when userInfo disagrees with the verified ID token", async () => {
    const query = await authorize("U1");
    slack.tamperNextIdToken({ "https://slack.com/team_id": "T9" });
    await expect(
      source().callback({
        config: config(),
        redirectUri: REDIRECT,
        query,
        nonce: "nonce-abc",
        signal: signal(),
      }),
    ).rejects.toThrow(/userInfo/);
  });

  it("maps provider errors to an error with the code only (no secrets)", async () => {
    const query = await authorize("U1");
    slack.failNext("openid.connect.token", { error: "invalid_code" });
    const err = await source()
      .callback({
        config: config(),
        redirectUri: REDIRECT,
        query,
        nonce: "nonce-abc",
        signal: signal(),
      })
      .catch((e: unknown) => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("invalid_code");
    expect((err as Error).message).not.toContain("shh-secret-42");

    await expect(
      source().callback({
        config: config(),
        redirectUri: REDIRECT,
        query: { error: "access_denied", state: "s" },
        nonce: "nonce-abc",
        signal: signal(),
      }),
    ).rejects.toThrow(/access_denied/);
    await expect(
      source().callback({
        config: config(),
        redirectUri: REDIRECT,
        query: { state: "s" },
        nonce: "nonce-abc",
        signal: signal(),
      }),
    ).rejects.toThrow(/code/);
  });

  it("a used authorization code cannot be exchanged twice", async () => {
    const query = await authorize("U1");
    const args = {
      config: config(),
      redirectUri: REDIRECT,
      query,
      nonce: "nonce-abc",
      signal: signal(),
    };
    await source().callback(args);
    await expect(source().callback(args)).rejects.toThrow(/invalid_code/);
  });
});
