import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Live checks of the Google connector templates against Google's hosted MCP servers:
 * `CAPYBARA_TEST_LIVE_TOOLS=1 pnpm exec vitest run plugins/google/test/live/google-mcp.live.test.ts`.
 *
 * Unauthenticated part (`CAPYBARA_TEST_LIVE_TOOLS=1`): per template, `initialize` answers,
 * `tools/list` equals the recorded fixture (`test/fixtures/<id>-tools.json`, names and hints), each
 * tool's protected-resource metadata lists a scope the template requests, an unauthenticated call
 * answers 401 naming `resource_metadata`, and the server's metadata names Google's authorization
 * server. `CAPYBARA_TEST_GOOGLE_RECORD_FIXTURES=1` rewrites the fixtures from the live answers
 * instead of comparing (then update the templates' policies together with them).
 *
 * Authenticated part (also `CAPYBARA_TEST_GOOGLE_ACCESS_TOKEN`): a short-lived access token of a
 * Workspace member, minted outside the test with the agent-flagged test client and the union of
 * the seven templates' scopes (the template's OAuth flow needs a browser). The token's
 * `tools/list` must equal the unauthenticated one, and one read-only call per template must pass
 * Google's authorization (a tool-level error for a made-up document id is fine; HTTP 401 / 403 is
 * not). `CAPYBARA_TEST_GOOGLE_BIGQUERY_PROJECT` adds the BigQuery call. Values starting with
 * `replace` / 「替换为」 count as unset. Only tool names, counts and statuses are printed.
 */

const filled = (v: string | undefined): v is string =>
  v !== undefined && v.trim() !== "" && !/^(replace|替换为)/i.test(v.trim());
const LIVE = process.env.CAPYBARA_TEST_LIVE_TOOLS === "1";
const TOKEN = process.env.CAPYBARA_TEST_GOOGLE_ACCESS_TOKEN;
const AUTHED = LIVE && filled(TOKEN);
const BQ_PROJECT = process.env.CAPYBARA_TEST_GOOGLE_BIGQUERY_PROJECT;
const RECORD = process.env.CAPYBARA_TEST_GOOGLE_RECORD_FIXTURES === "1";
if (!LIVE) {
  console.info("[google-mcp-live] skipped: set CAPYBARA_TEST_LIVE_TOOLS=1");
} else if (!AUTHED) {
  console.info(
    "[google-mcp-live] authenticated part skipped: set CAPYBARA_TEST_GOOGLE_ACCESS_TOKEN",
  );
}

const TEMPLATE_IDS = [
  "gmail",
  "google-drive",
  "google-calendar",
  "google-sheets",
  "google-docs",
  "google-slides",
  "bigquery",
] as const;
type TemplateId = (typeof TEMPLATE_IDS)[number];

interface Template {
  template: { endpoint: { url: string }; auth: { scopes: string[] } };
}
interface FixtureTool {
  name: string;
  readOnlyHint: boolean;
  destructiveHint: boolean;
  scopes: string[];
}
interface Fixture {
  endpoint: string;
  recordedAt: string;
  tools: FixtureTool[];
}
const root = new URL("../../", import.meta.url);
const readJson = <T>(p: string) => JSON.parse(readFileSync(new URL(p, root), "utf8")) as T;
const template = (id: TemplateId) => readJson<Template>(`connectors/${id}.json`);
const fixturePath = (id: TemplateId) => `test/fixtures/${id}-tools.json`;

/** One read-only call per template; a made-up id still proves the token was accepted. */
const READ_CALLS: Record<TemplateId, { name: string; args: Record<string, unknown> } | null> = {
  gmail: { name: "list_labels", args: {} },
  "google-drive": { name: "list_recent_files", args: {} },
  "google-calendar": { name: "list_calendars", args: {} },
  "google-sheets": { name: "get_spreadsheet", args: { spreadsheetId: "capybara-live-missing" } },
  "google-docs": { name: "read_doc", args: { documentId: "capybara-live-missing" } },
  "google-slides": {
    name: "read_presentation",
    args: { presentationId: "capybara-live-missing" },
  },
  bigquery: filled(BQ_PROJECT)
    ? { name: "list_dataset_ids", args: { projectId: BQ_PROJECT } }
    : null,
};

interface McpTool {
  name: string;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
}
interface RpcAnswer {
  status: number;
  headers: Headers;
  result?: Record<string, unknown> | undefined;
  error?: unknown;
}

/** One MCP session (Streamable HTTP, JSON or SSE answers), the way connector-mcp speaks it. */
async function mcpSession(url: string, token?: string) {
  let sessionId: string | null = null;
  let id = 0;
  const post = async (body: Record<string, unknown>): Promise<RpcAnswer> => {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2025-06-18",
        ...(token !== undefined && { authorization: `Bearer ${token}` }),
        ...(sessionId !== null && { "mcp-session-id": sessionId }),
      },
      body: JSON.stringify({ jsonrpc: "2.0", ...body }),
      redirect: "manual",
    });
    sessionId = res.headers.get("mcp-session-id") ?? sessionId;
    const text = await res.text();
    if (!("id" in body) || res.status >= 300) return { status: res.status, headers: res.headers };
    const json = text.trimStart().startsWith("{")
      ? text
      : (/^data: (.*)$/m.exec(text)?.[1] ?? "{}");
    const msg = JSON.parse(json) as { result?: Record<string, unknown>; error?: unknown };
    return { status: res.status, headers: res.headers, result: msg.result, error: msg.error };
  };
  const call = (method: string, params: Record<string, unknown> = {}) =>
    post({ id: ++id, method, params });
  const init = await call("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "capybara-live-test", version: "0" },
  });
  if (init.status < 300) await post({ method: "notifications/initialized" });
  return { init, call };
}

async function listTools(url: string, token?: string): Promise<McpTool[]> {
  const s = await mcpSession(url, token);
  expect(s.init.status, `initialize HTTP ${s.init.status}`).toBeLessThan(300);
  const r = await s.call("tools/list");
  expect(r.status, `tools/list HTTP ${r.status}`).toBeLessThan(300);
  expect(r.error, JSON.stringify(r.error)).toBeUndefined();
  return (r.result?.tools ?? []) as McpTool[];
}

async function perToolScopes(url: string, tool: string): Promise<string[]> {
  const res = await fetch(`${new URL(url).origin}/.well-known/oauth-protected-resource/${tool}`, {
    redirect: "manual",
  });
  if (!res.ok) return [];
  return ((await res.json()) as { scopes_supported?: string[] }).scopes_supported ?? [];
}

const shape = (tools: McpTool[]) =>
  tools.map((t) => ({
    name: t.name,
    readOnlyHint: t.annotations?.readOnlyHint === true,
    destructiveHint: t.annotations?.destructiveHint === true,
  }));

/** A failure message naming the added, removed and changed tools. */
function diff(expected: Omit<FixtureTool, "scopes">[], actual: Omit<FixtureTool, "scopes">[]) {
  const e = new Map(expected.map((t) => [t.name, JSON.stringify(t)]));
  const a = new Map(actual.map((t) => [t.name, JSON.stringify(t)]));
  const added = [...a.keys()].filter((n) => !e.has(n));
  const removed = [...e.keys()].filter((n) => !a.has(n));
  const changed = [...a.keys()].filter((n) => e.has(n) && e.get(n) !== a.get(n));
  return `added: [${added}] removed: [${removed}] changed: [${changed}]`;
}

describe.skipIf(!LIVE)("live", { timeout: 180_000 }, () => {
  it.each(TEMPLATE_IDS)(
    "live %s unauthenticated: tools and hints equal the fixture, scopes, 401 and metadata",
    async (id) => {
      const { url } = template(id).template.endpoint;
      const scopes = new Set(template(id).template.auth.scopes);
      const s = await mcpSession(url);
      expect(s.init.status).toBeLessThan(300);
      expect(s.init.result?.protocolVersion).toEqual(expect.any(String));
      const listed = await listTools(url);

      const recorded: FixtureTool[] = [];
      for (const t of shape(listed)) {
        recorded.push({ ...t, scopes: await perToolScopes(url, t.name) });
      }
      if (RECORD) {
        const today = new Date().toISOString().slice(0, 10);
        const fixture: Fixture = { endpoint: url, recordedAt: today, tools: recorded };
        writeFileSync(new URL(fixturePath(id), root), `${JSON.stringify(fixture, null, 2)}\n`);
      } else {
        const fixture = readJson<Fixture>(fixturePath(id));
        const strip = (ts: FixtureTool[]) => ts.map(({ scopes: _, ...rest }) => rest);
        expect(strip(recorded), diff(strip(fixture.tools), strip(recorded))).toEqual(
          strip(fixture.tools),
        );
      }
      for (const t of recorded) {
        expect(
          t.scopes.some((x) => scopes.has(x)),
          `${t.name} accepts none of the template's scopes`,
        ).toBe(true);
      }

      const firstRead = listed.find((t) => t.annotations?.readOnlyHint === true);
      expect(firstRead).toBeDefined();
      const denied = await s.call("tools/call", { name: firstRead?.name, arguments: {} });
      expect(denied.status).toBe(401);
      expect(denied.headers.get("www-authenticate") ?? "").toContain("resource_metadata");

      const u = new URL(url);
      const meta = await fetch(`${u.origin}/.well-known/oauth-protected-resource${u.pathname}`, {
        redirect: "manual",
      });
      expect(meta.status).toBe(200);
      const servers =
        ((await meta.json()) as { authorization_servers?: string[] }).authorization_servers ?? [];
      expect(servers.map((x) => new URL(x).origin)).toContain("https://accounts.google.com");
      console.info(`[google-mcp-live] ${id}: ${listed.length} tools`);
    },
  );

  describe.skipIf(!AUTHED)("authenticated", () => {
    it.each(TEMPLATE_IDS)(
      "live %s authenticated: the token sees the same tools and a read passes Google's checks",
      async (id) => {
        const { url } = template(id).template.endpoint;
        const anonymous = shape(await listTools(url));
        const authed = shape(await listTools(url, TOKEN));
        expect(authed, diff(anonymous, authed)).toEqual(anonymous);

        const read = READ_CALLS[id];
        if (read === null) {
          console.info(`[google-mcp-live] ${id}: read call skipped (no project set)`);
          return;
        }
        const s = await mcpSession(url, TOKEN);
        const r = await s.call("tools/call", { name: read.name, arguments: read.args });
        // HTTP 401 / 403 means the token, the agent flag or the enabled service was refused
        expect(r.status, `${read.name} HTTP ${r.status}`).toBeLessThan(300);
        expect(r.error, `${read.name} JSON-RPC error`).toBeUndefined();
        console.info(
          `[google-mcp-live] ${id}: ${read.name} isError=${String(r.result?.isError ?? false)}`,
        );
      },
    );
  });
});
