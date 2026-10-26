import { fileURLToPath } from "node:url";
import {
  createDb,
  createLocalAccount,
  createOrg,
  type FakeGitServer,
  type FakeMcpServer,
  fakeExtensionEntry,
  type Kernel,
  type KernelDb,
  kernelDb,
  login,
  type KernelRequest as Req,
  startFakeGitServer,
  startFakeMcpServer,
  startTestKernel,
  startTestPostgres,
  startTestRedis,
  startTestS3,
  type TestContainer,
  type TestS3,
  testKernelConfig,
} from "@capybara-hq/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * A Claude Code plugin's remote MCP server becomes a connector template for connector-mcp (spec
 * §8.2): with connector-mcp loaded the import checks the endpoint (`endpointChecked: true`), the
 * org install creates the connector, and with a bearer credential it lists the server's tools.
 * Uses only @capybara-hq/testing (a local fake git server and fake MCP server, no network).
 */

const PLUGIN_DIR = fileURLToPath(new URL("../", import.meta.url));
const CONNECTOR_MCP = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const OBJECT_STORE = fakeExtensionEntry("fake-object-store");
const TOKEN = "claude-mcp-token-41c7";

let pgc: TestContainer;
let rd: TestContainer;
let s3: TestS3;
let raw: ReturnType<typeof createDb>;
let db: KernelDb;
let k: Kernel;
let git: FakeGitServer;
let mcp: FakeMcpServer;
let admin: Req;
let orgId: string;

beforeAll(async () => {
  [pgc, rd, s3] = await Promise.all([startTestPostgres(), startTestRedis(), startTestS3()]);
  git = await startFakeGitServer();
  mcp = await startFakeMcpServer({
    requireBearer: TOKEN,
    tools: [
      {
        name: "search",
        description: "Search the docs",
        inputSchema: { type: "object", properties: { q: { type: "string" } } },
        annotations: { readOnlyHint: true },
        handler: () => ({ content: [{ type: "text", text: "ok" }] }),
      },
      {
        name: "delete_doc",
        description: "Delete a document",
        inputSchema: { type: "object", properties: { id: { type: "string" } } },
        annotations: { destructiveHint: true },
        handler: () => ({ content: [{ type: "text", text: "gone" }] }),
      },
    ],
  });
  k = await startTestKernel(
    testKernelConfig(
      { pg: pgc.url, redis: rd.url },
      {
        // imports stage their files in object storage
        extensions: [CONNECTOR_MCP, OBJECT_STORE],
        extensionConfig: {
          // the fake servers run plain http on 127.0.0.1
          "connector-mcp": { allowInsecureLoopback: true },
          "fake-object-store": {
            endpoint: s3.endpoint,
            region: s3.region,
            bucket: s3.bucket,
            accessKeyId: s3.accessKey,
            secretAccessKey: s3.secretKey,
            forcePathStyle: true,
          },
        },
        marketplaces: {
          official: { enabled: false },
          allowInsecureLoopback: true,
          allowedHosts: ["127.0.0.1"],
        },
        roles: ["api"],
      },
    ),
    { resolveFrom: PLUGIN_DIR },
  );
  raw = createDb(pgc.url, 3);
  db = kernelDb(raw);
  const rootId = await createLocalAccount(db, "root", "R");
  // marketplace imports need an enterprise admin (no testing helper creates one)
  await db
    .updateTable("accounts")
    .set({ is_enterprise_admin: true })
    .where("id", "=", rootId)
    .execute();
  admin = await login(k, "root");
  orgId = await createOrg(admin);
}, 120_000);

afterAll(async () => {
  await k?.stop();
  await mcp?.stop();
  await git?.stop();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop(), s3?.stop()]);
});

describe("a translated Claude Code MCP server with connector-mcp", () => {
  it("imports with the endpoint checked, installs in the org and lists the server's tools with a bearer credential", async () => {
    await git.commit("docs-mcp", {
      ".claude-plugin/plugin.json": JSON.stringify({
        name: "docs-mcp",
        version: "1.0.0",
        description: "Docs over MCP",
        author: { name: "Acme" },
      }),
      ".mcp.json": JSON.stringify({
        mcpServers: {
          "bearer-api": {
            type: "http",
            url: mcp.url,
            // biome-ignore lint/suspicious/noTemplateCurlyInString: a Claude Code variable, plain text
            headers: { Authorization: "Bearer ${API_TOKEN}" },
          },
        },
      }),
    });
    const prepared = await admin({
      method: "POST",
      url: "/api/v1/admin/catalog/import/git",
      payload: { url: git.url("docs-mcp") },
    });
    expect(prepared.statusCode, prepared.body).toBe(200);
    const { stagingId, review } = prepared.json();
    expect(review.format).toBe("claude-code");
    expect(review.connectorTemplates).toMatchObject([
      {
        id: "bearer-api",
        plugin: "connector-mcp",
        endpointChecked: true,
        auth: { type: "bearer", ownership: "personal" },
      },
    ]);
    const codes = (review.translation.items as { code: string; name: string }[]).map(
      (i) => `${i.code} ${i.name}`,
    );
    expect(codes).toContain("mcp_template bearer-api");
    expect(codes).toContain("mcp_header_variable bearer-api");
    expect(codes).not.toContain("connector_not_loaded bearer-api");

    const confirmed = await admin({
      method: "POST",
      url: `/api/v1/admin/catalog/imports/${stagingId}/confirm`,
      payload: { reviewHash: review.reviewHash, deployExtension: false },
    });
    expect(confirmed.statusCode, confirmed.body).toBe(201);
    const itemId = confirmed.json().item.id as string;

    // the template's bearer is personal: the installer's own credential lists the tools
    const installed = await admin({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/catalog/${itemId}/install`,
      payload: { connectors: { "bearer-api": { credential: { token: TOKEN } } } },
    });
    expect(installed.statusCode, installed.body).toBe(201);
    const list = await admin({ method: "GET", url: `/api/v1/orgs/${orgId}/connectors` });
    expect(list.statusCode, list.body).toBe(200);
    const [connector] = list.json().connectors as { id: string; connector: string }[];
    expect(connector?.connector).toBe("mcp");
    const got = await admin({
      method: "GET",
      url: `/api/v1/orgs/${orgId}/connectors/${connector?.id}`,
    });
    expect(got.statusCode, got.body).toBe(200);
    const tools = (got.json().connector.tools as { name: string; defaultPolicy: string }[]).map(
      (t) => [t.name, t.defaultPolicy],
    );
    expect(tools).toEqual(
      expect.arrayContaining([
        ["search", "allow"],
        ["delete_doc", "ask"],
      ]),
    );
    expect(mcp.requests.some((r) => r.headers.authorization === `Bearer ${TOKEN}`)).toBe(true);
  });
});
