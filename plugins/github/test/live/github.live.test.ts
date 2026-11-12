import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Live check of the GitHub connector templates against GitHub's remote MCP server:
 * `CAPYBARA_TEST_LIVE_TOOLS=1 pnpm exec vitest run plugins/github/test/live -t live`.
 *
 * Needs `CAPYBARA_TEST_GITHUB_MCP_TOKEN` (a personal access token: fine-grained with the
 * permissions of guides/github-pat.md, or classic with `repo`); values starting with 「替换为」
 * count as unset. The token is never printed. Read-only: it lists the tools and calls `get_me`.
 *
 * It speaks MCP (Streamable HTTP) to the template's endpoint with its headers, the way
 * connector-mcp does, and checks what the templates rely on: the toolset header reaches the
 * server (Actions tools are listed), no tool name has a character a tool key cannot hold, every
 * listed tool has a template policy, and the template allows exactly the tools GitHub annotates
 * read-only. The full path through a kernel (install, approval, no token in events or logs) is
 * connector-mcp's live test (`plugins/connector-mcp/test/live/m3.live.test.ts`).
 */

const filled = (v: string | undefined): v is string =>
  v !== undefined && v.trim() !== "" && !v.startsWith("替换为");
const TOKEN = process.env.CAPYBARA_TEST_GITHUB_MCP_TOKEN;
const LIVE = process.env.CAPYBARA_TEST_LIVE_TOOLS === "1" && filled(TOKEN);
if (!LIVE) {
  console.info(
    "[github-live] skipped: set CAPYBARA_TEST_LIVE_TOOLS=1 and CAPYBARA_TEST_GITHUB_MCP_TOKEN",
  );
}

interface Template {
  template: {
    endpoint: { url: string; headers: Record<string, string> };
    defaultToolPolicies: Record<string, "allow" | "ask" | "deny">;
  };
}
const read = (p: string) =>
  JSON.parse(readFileSync(new URL(`../../${p}`, import.meta.url), "utf8")) as Template;
const oauth = read("connectors/github.json");
const pat = read("connectors/github-pat.json");

interface McpTool {
  name: string;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
}

/** One MCP session against the template's endpoint: JSON-RPC over POST, JSON or SSE answers. */
async function mcpSession(tpl: Template) {
  const { url, headers: fixed } = tpl.template.endpoint;
  let sessionId: string | null = null;
  let id = 0;
  const post = async (body: Record<string, unknown>) => {
    const headers: Record<string, string> = {
      ...fixed,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${TOKEN}`,
      ...(sessionId !== null && { "mcp-session-id": sessionId }),
    };
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", ...body }),
      redirect: "manual",
    });
    sessionId = res.headers.get("mcp-session-id") ?? sessionId;
    const text = await res.text();
    expect(res.status, `HTTP ${res.status} for ${String(body.method)}`).toBeLessThan(300);
    if (!("id" in body)) return undefined;
    const json = text.startsWith("{") ? text : (/^data: (.*)$/m.exec(text)?.[1] ?? "{}");
    const msg = JSON.parse(json) as { result?: Record<string, unknown>; error?: unknown };
    expect(msg.error, JSON.stringify(msg.error)).toBeUndefined();
    return msg.result as Record<string, unknown>;
  };
  const call = (method: string, params: Record<string, unknown> = {}) =>
    post({ id: ++id, method, params });
  await call("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "capybara-live-test", version: "0" },
  });
  await post({ method: "notifications/initialized" });
  return call;
}

describe.skipIf(!LIVE)("live", { timeout: 120_000 }, () => {
  it("live GitHub MCP: the templates' toolsets, tool names and read-only policies match", async () => {
    expect(pat.template.endpoint).toEqual(oauth.template.endpoint);
    const call = await mcpSession(pat);
    const tools: McpTool[] = [];
    let cursor: string | undefined;
    do {
      const page = (await call("tools/list", cursor ? { cursor } : {})) as {
        tools: McpTool[];
        nextCursor?: string;
      };
      tools.push(...page.tools);
      cursor = page.nextCursor;
    } while (cursor);
    const names = tools.map((t) => t.name).sort();
    console.info(`[github-live] ${names.length} tools: ${names.join(",")}`);

    // The X-MCP-Toolsets header reached the server: Actions is not a default toolset
    expect(names).toEqual(expect.arrayContaining(["actions_list", "get_me", "issue_read"]));
    // Tool keys hold only [a-zA-Z0-9_-]; GitHub's names have no dots
    for (const n of names) expect(n).toMatch(/^[a-z0-9_]+$/);
    // Every listed tool has a template policy (a new upstream tool shows up here)
    const policies = pat.template.defaultToolPolicies;
    expect(names.filter((n) => !(n in policies))).toEqual([]);
    // The template allows exactly the tools GitHub annotates read-only
    for (const t of tools) {
      expect(policies[t.name] === "allow", t.name).toBe(t.annotations?.readOnlyHint === true);
    }

    const me = (await call("tools/call", { name: "get_me", arguments: {} })) as {
      isError?: boolean;
    };
    expect(me.isError ?? false).toBe(false);
  });
});
