import { readFileSync } from "node:fs";
import {
  parseConnectorTemplateFile,
  parsePluginManifest,
  validateConnectorTemplate,
} from "@capybara-hq/plugin-sdk";
import { describe, expect, it } from "vitest";

/**
 * The GitHub connector template `connectors/github.json`: per-person OAuth through a GitHub App
 * or OAuth App, on connector-mcp against GitHub's remote MCP server.
 */
const root = new URL("../", import.meta.url);
const read = (p: string) => readFileSync(new URL(p, root), "utf8");
type Policy = "allow" | "ask" | "deny";
interface TemplateFile {
  displayName: { zh: string; en: string };
  defaultEnabled?: boolean;
  icon?: string;
  template: {
    plugin: string;
    pluginVersion: string;
    connector: string;
    endpoint: { url: string; headers?: Record<string, string> };
    editableEndpoint?: string[];
    auth: Record<string, unknown>;
    defaultToolPolicies: Record<string, Policy>;
  };
}
const oauth = JSON.parse(read("connectors/github.json")) as TemplateFile;

/**
 * Tool names of github/github-mcp-server (checked 2026-11-12 at 6fbcd00, `pkg/github` and the
 * tool snapshots) in the toolsets the template turns on, including the ones behind GitHub's
 * feature flags (granular issue and pull request tools, file blame, issue dependencies and
 * artifacts, duplicate detection) and the remote server's Copilot tools.
 */
const READ_TOOLS = [
  // context
  "get_me",
  "get_teams",
  "get_team_members",
  "ui_get",
  // repos
  "get_commit",
  "get_file_contents",
  "get_file_blame",
  "get_latest_release",
  "get_release_by_tag",
  "get_tag",
  "list_branches",
  "list_commits",
  "list_releases",
  "list_repository_collaborators",
  "list_tags",
  "search_code",
  "search_commits",
  "search_repositories",
  // issues
  "issue_read",
  "list_issues",
  "search_issues",
  "list_issue_types",
  "list_issue_fields",
  "get_label",
  "find_duplicate",
  "issue_dependency_read",
  "issue_artifact_read",
  // pull_requests
  "pull_request_read",
  "list_pull_requests",
  "search_pull_requests",
  // users
  "search_users",
  // actions
  "actions_get",
  "actions_list",
  "get_job_logs",
];
/** Writes the task names explicitly: creating issues, merging pull requests, pushing files. */
const MUST_ASK = [
  "create_issue",
  "issue_write",
  "add_issue_comment",
  "create_pull_request",
  "merge_pull_request",
  "pull_request_review_write",
  "push_files",
  "create_or_update_file",
  "create_branch",
  "delete_file",
  "actions_run_trigger",
];

describe("connectors/github.json", () => {
  for (const [name, file] of [["github", oauth]] as const) {
    it(`${name}: is a valid connector template file`, () => {
      const parsed = parseConnectorTemplateFile(file);
      expect("errors" in parsed ? parsed.errors : []).toEqual([]);
      expect(validateConnectorTemplate(file.template)).toEqual([]);
    });

    it(`${name}: connector-mcp against GitHub's remote MCP server with the six toolsets`, () => {
      expect(file.template).toMatchObject({
        plugin: "connector-mcp",
        connector: "mcp",
        endpoint: {
          url: "https://api.githubcopilot.com/mcp/",
          headers: { "X-MCP-Toolsets": "context,repos,issues,pull_requests,users,actions" },
        },
      });
      // GHE.com data residency changes the url; toolsets, read-only or lockdown change headers
      expect(file.template.editableEndpoint).toEqual(["url", "headers"]);
      expect(file.icon).toBe("./icon.svg");
    });
  }

  it("github: per-person OAuth with MCP discovery and a manually entered client (no DCR at GitHub)", () => {
    expect(oauth.template.auth).toEqual({
      type: "oauth_code",
      ownership: "personal",
      discovery: "mcp",
      client: "manual",
      tokenAuthMethod: "client_secret_post",
      // OAuth App scopes (a GitHub App ignores them and uses its permissions)
      scopes: ["repo", "read:org", "read:user", "user:email", "workflow"],
    });
    expect(oauth.defaultEnabled).toBeUndefined();
  });

  it("reads are allowed, writes ask, deleting a repository is denied", () => {
    const p = oauth.template.defaultToolPolicies;
    for (const t of READ_TOOLS) expect(p[t], t).toBe("allow");
    for (const t of MUST_ASK) expect(p[t], t).toBe("ask");
    expect(p.delete_repository).toBe("deny");
    const allowed = Object.keys(p).filter((t) => p[t] === "allow");
    expect(allowed.sort()).toEqual([...READ_TOOLS].sort());
    expect(Object.entries(p).filter(([, v]) => v === "deny")).toEqual([
      ["delete_repository", "deny"],
    ]);
  });

  it("every tool name makes a valid tool key (no dots; mcp__<slug>__<name> fits 64)", () => {
    for (const t of Object.keys(oauth.template.defaultToolPolicies)) {
      expect(t).toMatch(/^[a-z0-9_]+$/);
      expect(`mcp__github__${t}`.length, t).toBeLessThanOrEqual(64);
    }
  });

  it("plugin.json lists the template and depends on connector-mcp at the templates' range", () => {
    const m = JSON.parse(read(".capybara-plugin/plugin.json"));
    const parsed = parsePluginManifest(m);
    expect("errors" in parsed ? parsed.errors : []).toEqual([]);
    expect(m.connectorTemplates).toEqual([{ path: "./connectors/github.json" }]);
    expect(m.dependencies).toEqual([
      { name: "connector-mcp", version: oauth.template.pluginVersion },
    ]);
    expect(oauth.template.pluginVersion).toMatch(/^\^0\.1\.0-rc\.\d+$/);
  });
});
