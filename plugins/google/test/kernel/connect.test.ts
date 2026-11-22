import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  type ConversationEvent,
  createConversation,
  createDb,
  createLocalAccount,
  createOrg,
  enableModelProviders,
  eventsOf,
  type FakeMcpServer,
  type FakeOAuthServer,
  fakeExtensionEntry,
  type KernelSchemaDb,
  kernelDb,
  login,
  postMessage,
  type KernelRequest as Req,
  startFakeMcpServer,
  startFakeOAuthServer,
  startTestKernel,
  startTestPostgres,
  startTestRedis,
  type TestContainer,
  type TestKernel,
  testKernelConfig,
  truncateTables,
  waitForTerminal,
} from "@capybara-hq/testing";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * The Google connector templates' auth preset through a real kernel, against a Google-like
 * authorization server (a refresh token only with `access_type=offline` and `prompt=consent`).
 * The kernel cannot reach Google from a test and the template's URLs are not editable, so each
 * connector is created from the template file's own `auth` with only `authorizationUrl` /
 * `tokenUrl` pointed at the fake, on the testing kit's `fake-connector` (an MCP client like
 * connector-mcp). The catalog path (import, switch on, create from template) is live acceptance.
 */

const PLUGIN_DIR = fileURLToPath(new URL("../../", import.meta.url));
const MODEL_FAKE = "@capybara-hq/plugin-model-fake";
const CONNECTOR = fakeExtensionEntry("fake-connector");
const PUBLIC_URL = "https://cap.example";
const CALLBACK = `${PUBLIC_URL}/api/v1/oauth/callback`;
const CLIENT = { clientId: "google-agent-client", clientSecret: "google-agent-secret-0123456789" };
const GOOGLE_PARAMS = { access_type: "offline", prompt: "consent" };

const TEMPLATE_IDS = [
  "gmail",
  "google-drive",
  "google-calendar",
  "google-sheets",
  "google-docs",
  "google-slides",
  "bigquery",
] as const;

interface TemplateFile {
  displayName: { en: string };
  template: { auth: Record<string, unknown> & { scopes: string[] } };
}
const templateFile = (id: string) =>
  JSON.parse(
    readFileSync(new URL(`../../connectors/${id}.json`, import.meta.url), "utf8"),
  ) as TemplateFile;

let pgc: TestContainer;
let rd: TestContainer;
let k: TestKernel;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let req: Req;
let orgId: string;
const logLines: string[] = [];
/** Every HTTP response body and header set the test received from the kernel. */
const httpBodies: string[] = [];
const stops: (() => Promise<void>)[] = [];

const ofType = <T extends ConversationEvent["type"]>(evs: ConversationEvent[], type: T) =>
  evs.filter((e): e is Extract<ConversationEvent, { type: T }> => e.type === type);

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  k = await startTestKernel(
    testKernelConfig(
      { pg: pgc.url, redis: rd.url },
      {
        extensions: [MODEL_FAKE, CONNECTOR],
        extensionPermissions: { autoApprove: true },
        extensionConfig: { "fake-connector": {} },
        roles: ["api", "worker"],
        http: { port: 0, publicUrl: PUBLIC_URL },
        auth: { cookieSecure: false },
        // the fakes run plain http on 127.0.0.1 (tests only)
        net: { allowInsecureLoopback: true },
        tools: { oauthAllowInsecureLoopback: true, timeoutMs: 5_000 },
      },
    ),
    { resolveFrom: PLUGIN_DIR, log: { level: "info", write: (l) => logLines.push(l) } },
  );
  raw = createDb(pgc.url, 5);
  db = kernelDb(raw);
}, 120_000);

afterAll(async () => {
  await k?.close();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

beforeEach(async () => {
  await truncateTables(raw, "capybara.accounts, capybara.orgs, capybara.audit_events");
  await createLocalAccount(db, "owner", "O");
  req = await login(k, "owner");
  orgId = await createOrg(req);
  await enableModelProviders(req, orgId, ["model-fake"]);
  // Connectors can be created only of kinds whose extension the org has switched on
  await db
    .insertInto("extension_org_configs")
    .values({ plugin: "fake-connector", org_id: orgId, enabled: true })
    .execute();
});

afterEach(async () => {
  for (const s of stops.splice(0).reverse()) await s();
});

async function call(opts: Parameters<Req>[0]) {
  const res = await req(opts);
  httpBodies.push(res.body, JSON.stringify(res.headers));
  return res;
}

/** A Google-like authorization server and an MCP server that accepts only its access tokens. */
async function servers(): Promise<{ as: FakeOAuthServer; mcp: FakeMcpServer }> {
  const as = await startFakeOAuthServer({
    refreshTokenOnlyWith: GOOGLE_PARAMS,
    clients: [{ ...CLIENT, redirectUris: [CALLBACK] }],
  });
  stops.push(() => as.stop());
  const mcp = await startFakeMcpServer({
    verifyBearer: (t) => as.verify(t),
    tools: [
      {
        name: "list_labels",
        description: "List the caller's labels",
        annotations: { readOnlyHint: true },
        handler: ({ headers }) => ({
          content: [{ type: "text", text: `labels of ${headers.authorization}` }],
        }),
      },
    ],
  });
  stops.push(() => mcp.stop());
  return { as, mcp };
}

/** Create the connector from the template's own auth, only the two URLs pointed at the fake. */
async function install(templateId: string, as: FakeOAuthServer, mcp: FakeMcpServer) {
  const file = templateFile(templateId);
  const res = await call({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/connectors`,
    payload: {
      name: file.displayName.en,
      // the kernel's default slug for a template connector: from the English name
      slug: file.displayName.en.toLowerCase().replace(/[^a-z0-9]+/g, "_"),
      connector: "fake",
      endpoint: { url: mcp.url },
      auth: {
        ...file.template.auth,
        authorizationUrl: `${as.issuer}/authorize`,
        tokenUrl: `${as.issuer}/token`,
      },
      credential: CLIENT,
    },
  });
  expect(res.statusCode, res.body).toBe(201);
  return (res.json() as { connector: { id: string } }).connector.id;
}

/** Start connecting; returns the authorize URL. */
async function connect(connectorId: string): Promise<URL> {
  const res = await call({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/connectors/${connectorId}/connect`,
    payload: {},
  });
  expect(res.statusCode, res.body).toBe(200);
  return new URL((res.json() as { authorizationUrl: string }).authorizationUrl);
}

/** The browser visits the authorize URL (the fake approves); returns the kernel callback path. */
async function approve(url: URL): Promise<string> {
  const res = await fetch(url, { redirect: "manual" });
  expect(res.status).toBe(302);
  const back = new URL(res.headers.get("location") as string);
  expect(`${back.origin}${back.pathname}`).toBe(CALLBACK);
  return `${back.pathname}${back.search}`;
}

async function callback(path: string): Promise<string> {
  const res = await call({ method: "GET", url: path, csrf: false });
  expect(res.statusCode, res.body).toBe(302);
  return res.headers.location as string;
}

async function connectFully(connectorId: string): Promise<void> {
  const back = await callback(await approve(await connect(connectorId)));
  expect(back).toBe(`${PUBLIC_URL}/account/connections?connected=${connectorId}`);
}

async function agentFor(): Promise<string> {
  const res = await call({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/agents`,
    payload: {
      definition: {
        name: "Helper",
        instructions: "Be helpful.",
        model: { provider: "model-fake", model: "fake-1" },
        disabledTools: [],
      },
      visibility: "org",
    },
  });
  expect(res.statusCode, res.body).toBe(201);
  return (res.json() as { agent: { id: string } }).agent.id;
}

async function runTool(convId: string, n: number, key: string) {
  await postMessage(req, orgId, convId, `tool:${key}:{}`);
  await waitForTerminal(db, convId, n, 20_000);
  const r = ofType(await eventsOf(db, convId), "tool_result").at(-1);
  expect(r?.payload.toolKey).toBe(key);
  return r?.payload;
}

describe("Google connector templates through a real kernel", () => {
  it.each(TEMPLATE_IDS)(
    "%s: the auth preset installs and its authorize request asks for offline access with exactly its scopes",
    async (templateId) => {
      const { as, mcp } = await servers();
      const id = await install(templateId, as, mcp);
      await callback(await approve(await connect(id)));
      expect(as.authorizeRequests).toHaveLength(1);
      const q = as.authorizeRequests[0] as URLSearchParams;
      expect(q.get("access_type")).toBe("offline");
      expect(q.get("prompt")).toBe("consent");
      expect(q.get("code_challenge_method")).toBe("S256");
      expect(q.get("state")).toEqual(expect.any(String));
      expect(q.get("client_id")).toBe(CLIENT.clientId);
      expect(q.get("scope")?.split(" ")).toEqual(templateFile(templateId).template.auth.scopes);
      expect(q.has("include_granted_scopes")).toBe(false);
      expect(q.has("resource")).toBe(false);
      expect(as.tokenRequests.map((t) => [t.grantType, t.clientAuth, t.status])).toEqual([
        ["authorization_code", "post", 200],
      ]);
    },
  );

  it("gmail: the refresh token is stored, used after the access token dies, and re-issued on reconnect", async () => {
    const { as, mcp } = await servers();
    const id = await install("gmail", as, mcp);
    await connectFully(id);
    as.revokeAccessTokens();
    const convId = await createConversation(req, orgId, await agentFor());
    const r = await runTool(convId, 1, "mcp__gmail__list_labels");
    expect(r).toMatchObject({ content: "labels of [REDACTED]", isError: false });
    expect(as.tokenRequests.map((t) => [t.grantType, t.status])).toEqual([
      ["authorization_code", 200],
      ["refresh_token", 200],
    ]);

    await connectFully(id);
    expect(as.authorizeRequests).toHaveLength(2);
    expect(as.authorizeRequests[1]?.get("access_type")).toBe("offline");
    expect(as.authorizeRequests[1]?.get("prompt")).toBe("consent");
    // the parameters go only on the authorize request, never on a token request
    for (const t of as.tokenRequests) {
      expect(t.paramNames).not.toContain("access_type");
      expect(t.paramNames).not.toContain("prompt");
    }
  });

  it("gmail: a refresh token Google revoked asks the member to reconnect", async () => {
    const { as, mcp } = await servers();
    const id = await install("gmail", as, mcp);
    await connectFully(id);
    as.revokeAccessTokens();
    as.revokeRefreshTokens();
    const convId = await createConversation(req, orgId, await agentFor());
    const r = await runTool(convId, 1, "mcp__gmail__list_labels");
    expect(r).toMatchObject({
      isError: true,
      content:
        "The user has not connected Gmail. A connect card was shown; ask the user to connect, then retry.",
    });
    expect(
      ofType(await eventsOf(db, convId), "connection_required").map((e) => e.payload),
    ).toMatchObject([{ appId: id, appName: "Gmail" }]);
  });

  it("no token or client secret reaches logs, events or HTTP bodies", async () => {
    const { as, mcp } = await servers();
    const id = await install("gmail", as, mcp);
    await connectFully(id);
    const convId = await createConversation(req, orgId, await agentFor());
    await runTool(convId, 1, "mcp__gmail__list_labels");
    as.revokeAccessTokens();
    await runTool(convId, 2, "mcp__gmail__list_labels");
    // the fake MCP server really saw a bearer token (otherwise the absence proves nothing)
    expect(mcp.calls.at(-1)?.headers.authorization).toMatch(/^Bearer .+/);

    const events = JSON.stringify(await eventsOf(db, convId));
    const secrets = [...as.issuedSecrets(), CLIENT.clientSecret];
    expect(secrets.length).toBeGreaterThan(2);
    for (const s of secrets) {
      expect(logLines.some((l) => l.includes(s))).toBe(false);
      expect(events.includes(s)).toBe(false);
      expect(httpBodies.some((b) => b.includes(s))).toBe(false);
    }
  });
});
