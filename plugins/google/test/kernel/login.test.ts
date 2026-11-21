import { fileURLToPath } from "node:url";
import {
  createDb,
  createLocalAccount,
  type FakeOAuthServer,
  type FakeOidcClaims,
  kernelDb,
  startFakeOAuthServer,
  startTestKernel,
  startTestPostgres,
  startTestRedis,
  type TestContainer,
  type TestKernel,
  testKernelConfig,
} from "@capybara-hq/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Sign in with Google through a real kernel (one in-process kernel) against the fake OIDC provider
 * of @capybara-hq/testing: the kernel's SSO flow (state, browser binding, PKCE, nonce) drives the
 * plugin's authorize URL and callback, and the identity rows land in the kernel's database.
 */

const PLUGIN_DIR = fileURLToPath(new URL("../../", import.meta.url));
const GOOGLE = fileURLToPath(new URL("../../src/index.ts", import.meta.url));
const MODEL_FAKE = "@capybara-hq/plugin-model-fake";
const PUBLIC = "https://cap.example";
const CALLBACK = `${PUBLIC}/api/v1/auth/sso/google/callback`;
const CLIENT_ID = "cli-google";
const CLIENT_SECRET = "google-secret-5f2e";

let pgc: TestContainer;
let rd: TestContainer;
let fake: FakeOAuthServer;
let k: TestKernel;
let raw: ReturnType<typeof createDb>;

beforeAll(async () => {
  fake = await startFakeOAuthServer({
    oidc: {},
    metadata: "openid",
    clients: [{ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, redirectUris: [CALLBACK] }],
  });
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  k = await startTestKernel(
    testKernelConfig(
      { pg: pgc.url, redis: rd.url },
      {
        extensions: [MODEL_FAKE, GOOGLE],
        http: { port: 0, publicUrl: PUBLIC },
        auth: {
          cookieSecure: false,
          loginSources: ["google"],
          trustedIdentitySources: ["google:example.com"],
        },
        extensionConfig: {
          google: {
            clientId: CLIENT_ID,
            clientSecret: CLIENT_SECRET,
            allowedDomains: ["example.com", "other.example"],
            endpoints: {
              authorizationUrl: `${fake.issuer}/authorize`,
              tokenUrl: `${fake.issuer}/token`,
              jwksUrl: fake.jwksUrl,
              issuers: [fake.issuer],
              discoveryUrl: `${fake.issuer}/.well-known/openid-configuration`,
            },
          },
        },
      },
    ),
    { resolveFrom: PLUGIN_DIR },
  );
  raw = createDb(pgc.url, 3);
}, 120_000);

afterAll(async () => {
  await k?.close();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop(), fake?.stop()]);
});

type Jar = Map<string, string>;

function absorb(jar: Jar, setCookie: string | string[] | undefined): void {
  const list = setCookie === undefined ? [] : Array.isArray(setCookie) ? setCookie : [setCookie];
  for (const c of list) {
    const pair = c.split(";")[0] ?? "";
    const i = pair.indexOf("=");
    const name = pair.slice(0, i).trim();
    const value = pair.slice(i + 1).trim();
    if (value === "" || /max-age=0/i.test(c)) jar.delete(name);
    else jar.set(name, value);
  }
}
const cookieHeader = (jar: Jar) => [...jar].map(([n, v]) => `${n}=${v}`).join("; ");

async function get(jar: Jar, url: string) {
  const res = await k.http.inject({
    method: "GET",
    url,
    headers: jar.size > 0 ? { cookie: cookieHeader(jar) } : {},
  });
  absorb(jar, res.headers["set-cookie"] as string | string[] | undefined);
  return { status: res.statusCode, location: String(res.headers.location ?? ""), body: res.body };
}

/** Start at the kernel, let the fake Google approve, and return the callback path (not yet followed). */
async function toCallback(jar: Jar, claims?: FakeOidcClaims): Promise<string> {
  if (claims !== undefined) fake.queueLogin(claims);
  const start = await get(jar, "/api/v1/auth/sso/google/start?returnTo=%2Fchat");
  expect(start.status).toBe(302);
  const back = await fetch(start.location, { redirect: "manual" });
  expect(back.status).toBe(302);
  const cb = new URL(back.headers.get("location") ?? "");
  expect(cb.origin + cb.pathname).toBe(CALLBACK);
  return cb.pathname + cb.search;
}

async function signIn(claims: FakeOidcClaims) {
  const jar: Jar = new Map();
  const cb = await get(jar, await toCallback(jar, claims));
  return { jar, cb };
}

const db = () => kernelDb(raw);
const identitiesOf = (sub: string) =>
  db()
    .selectFrom("identities")
    .select(["account_id", "source"])
    .where("external_id", "=", sub)
    .execute();

async function verifiedAccount(login: string, email: string): Promise<string> {
  const id = await createLocalAccount(db(), login);
  await db()
    .updateTable("accounts")
    .set({ email, email_verified: true })
    .where("id", "=", id)
    .execute();
  return id;
}

describe("Sign in with Google in a kernel", () => {
  it("a Workspace account signs in and gets google:example.com + sub", async () => {
    const before = fake.authorizeRequests.length;
    const { jar, cb } = await signIn({
      sub: "1001",
      hd: "example.com",
      email: "new@example.com",
      email_verified: true,
      name: "New",
    });
    const authz = fake.authorizeRequests[before];
    expect(authz?.get("code_challenge_method")).toBe("S256");
    expect(authz?.get("nonce")).toBeTruthy();
    expect(authz?.get("prompt")).toBe("select_account");
    expect(authz?.get("redirect_uri")).toBe(CALLBACK);
    expect(authz?.has("access_type")).toBe(false);
    expect(authz?.has("hd")).toBe(false); // two allowed domains: no hint

    expect(cb.status).toBe(302);
    expect(cb.location).toBe(`${PUBLIC}/chat`);
    const rows = await identitiesOf("1001");
    expect(rows.map((r) => r.source)).toEqual(["google:example.com"]);

    const me = await get(jar, "/api/v1/me");
    expect(me.status).toBe(200);
    expect(me.body).not.toContain(CLIENT_SECRET);
    for (const s of fake.issuedSecrets()) expect(me.body).not.toContain(s);
  });

  it("merges into an existing account only for a trusted tenant with an authoritative email", async () => {
    const alice = await verifiedAccount("alice", "alice@example.com");
    const bob = await verifiedAccount("bob", "bob@other.example");
    const dave = await verifiedAccount("dave", "carol@example.com");

    // trusted tenant, verified email: the existing account
    await signIn({
      sub: "2001",
      hd: "example.com",
      email: "Alice@example.com",
      email_verified: true,
    });
    expect(await identitiesOf("2001")).toEqual([
      { account_id: alice, source: "google:example.com" },
    ]);

    // verified email, untrusted tenant: a new account
    await signIn({
      sub: "2002",
      hd: "other.example",
      email: "bob@other.example",
      email_verified: true,
    });
    const bobRows = await identitiesOf("2002");
    expect(bobRows.map((r) => r.source)).toEqual(["google:other.example"]);
    expect(bobRows[0]?.account_id).not.toBe(bob);

    // trusted tenant, email not verified by Google: a new account
    await signIn({
      sub: "2003",
      hd: "example.com",
      email: "carol@example.com",
      email_verified: false,
    });
    const carolRows = await identitiesOf("2003");
    expect(carolRows).toHaveLength(1);
    expect(carolRows[0]?.account_id).not.toBe(dave);
  });

  it("a refused domain ends on the login page with sso.account_not_allowed", async () => {
    const { cb } = await signIn({
      sub: "3001",
      hd: "evil.example",
      email: "x@evil.example",
      email_verified: true,
    });
    expect(cb.status).toBe(302);
    expect(cb.location).toBe(`${PUBLIC}/login?error=sso.account_not_allowed`);
    expect(await identitiesOf("3001")).toEqual([]);
  });

  it("a consumer account is refused while a domain list is set", async () => {
    const { cb } = await signIn({ sub: "3002", email: "x@gmail.com", email_verified: true });
    expect(cb.location).toBe(`${PUBLIC}/login?error=sso.account_not_allowed`);
    expect(await identitiesOf("3002")).toEqual([]);
  });

  it("a tampered ID token ends on sso.provider_error", async () => {
    fake.tamperNextIdToken({}, { foreignKey: true });
    const { cb } = await signIn({ sub: "4001", hd: "example.com" });
    expect(cb.location).toBe(`${PUBLIC}/login?error=sso.provider_error`);
    expect(await identitiesOf("4001")).toEqual([]);
  });

  it("an ID token for another client ends on sso.provider_error", async () => {
    const { cb } = await signIn({ sub: "4002", hd: "example.com", aud: "someone-else" });
    expect(cb.location).toBe(`${PUBLIC}/login?error=sso.provider_error`);
    expect(await identitiesOf("4002")).toEqual([]);
  });

  it("the kernel's own checks still hold", async () => {
    // replaying a used callback URL: the state is single-use
    const jar: Jar = new Map();
    const path = await toCallback(jar, { sub: "5001", hd: "example.com" });
    expect((await get(jar, path)).location).toBe(`${PUBLIC}/chat`);
    expect((await get(jar, path)).location).toBe(`${PUBLIC}/login?error=sso.state_invalid`);

    // the callback in another browser (no binding cookie)
    const jar2: Jar = new Map();
    const path2 = await toCallback(jar2, { sub: "5002", hd: "example.com" });
    const other = await get(new Map(), path2);
    expect(other.location).toBe(`${PUBLIC}/login?error=sso.session_mismatch`);
    expect(await identitiesOf("5002")).toEqual([]);
  });
});
