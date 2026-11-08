import { readFileSync } from "node:fs";
import {
  parseConnectorTemplateFile,
  parsePluginManifest,
  validateConnectorTemplate,
} from "@capybara-hq/plugin-sdk";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

/**
 * The Slack connector template (connectors/slack.json): per-person OAuth to Slack's MCP server
 * through connector-mcp (design: docs/superpowers/specs/2026-11-08-slack-connector-design.md).
 */
const root = new URL("../", import.meta.url);
const read = (p: string) => readFileSync(new URL(p, root), "utf8");
const file = JSON.parse(read("connectors/slack.json")) as {
  defaultEnabled?: boolean;
  icon?: string;
  template: {
    plugin: string;
    pluginVersion: string;
    connector: string;
    endpoint: Record<string, unknown>;
    editableEndpoint?: string[];
    auth: Record<string, unknown> & { scopes: string[] };
    defaultToolPolicies: Record<string, "allow" | "ask" | "deny">;
  };
};

/** The user scopes Slack's MCP server lists in `scopes_supported` (design §2.1, §3). */
const SCOPES = [
  "search:read.public",
  "search:read.private",
  "search:read.mpim",
  "search:read.im",
  "search:read.files",
  "search:read.users",
  "channels:history",
  "groups:history",
  "mpim:history",
  "im:history",
  "channels:read",
  "groups:read",
  "mpim:read",
  "im:read",
  "channels:write",
  "groups:write",
  "mpim:write",
  "im:write",
  "chat:write",
  "canvases:read",
  "canvases:write",
  "lists:read",
  "lists:write",
  "files:read",
  "files:write",
  "reactions:read",
  "reactions:write",
  "emoji:read",
  "users:read",
  "users:read.email",
];

/** Slack MCP tool names (design §2.1; to be checked against a live tools/list before release). */
const READ_TOOLS = [
  "slack_search_public",
  "slack_search_channels",
  "slack_search_users",
  "slack_search_emojis",
  "slack_read_channel",
  "slack_read_thread",
  "slack_read_canvas",
  "slack_read_file",
  "slack_read_list",
  "slack_read_user_profile",
  "slack_list_user_channels",
  "slack_list_channel_members",
  "slack_get_reactions",
];
const WRITE_TOOLS = [
  "slack_send_message",
  "slack_send_message_draft",
  "slack_schedule_message",
  "slack_create_canvas",
  "slack_update_canvas",
  "slack_create_conversation",
  "slack_add_reaction",
  "slack_create_list",
  "slack_add_list_record",
  "slack_update_list",
  "slack_update_list_record",
  "slack_get_file_upload_url",
  "slack_complete_file_upload",
];

describe("connectors/slack.json", () => {
  it("is a valid connector template file", () => {
    const parsed = parseConnectorTemplateFile(file);
    expect("errors" in parsed ? parsed.errors : []).toEqual([]);
    expect(validateConnectorTemplate(file.template)).toEqual([]);
  });

  it("starts switched off in every org (an org on slack only for the bot needs no OAuth client)", () => {
    expect(file.defaultEnabled).toBe(false);
  });

  it("runs on connector-mcp against Slack's MCP server, not editable by orgs", () => {
    expect(file.template).toMatchObject({
      plugin: "connector-mcp",
      connector: "mcp",
      endpoint: { url: "https://mcp.slack.com/mcp" },
    });
    expect(Object.keys(file.template.endpoint)).toEqual(["url"]);
    expect(file.template.editableEndpoint).toBeUndefined();
    expect(file.icon).toBe("./icon.svg");
  });

  it("per-person OAuth: MCP discovery, a manually entered client, client_secret_post, explicit scopes", () => {
    const { scopes, ...auth } = file.template.auth;
    expect(auth).toEqual({
      type: "oauth_code",
      ownership: "personal",
      discovery: "mcp",
      client: "manual",
      tokenAuthMethod: "client_secret_post",
    });
    // No tokenTypes: Slack's token_type "user" is accepted by the kernel without it
    expect(file.template.auth).not.toHaveProperty("tokenTypes");
    expect(scopes).toEqual(SCOPES);
    expect(new Set(scopes).size).toBe(scopes.length);
    expect(scopes.length).toBeLessThanOrEqual(50);
  });

  it("reads are allowed; writes and the private / DM search ask; nothing is denied", () => {
    const p = file.template.defaultToolPolicies;
    for (const t of READ_TOOLS) expect(p[t], t).toBe("allow");
    for (const t of WRITE_TOOLS) expect(p[t], t).toBe("ask");
    expect(p.slack_search_public_and_private).toBe("ask");
    expect(Object.keys(p).sort()).toEqual(
      [...READ_TOOLS, ...WRITE_TOOLS, "slack_search_public_and_private"].sort(),
    );
  });

  it("plugin.json declares the dependency on connector-mcp with a prerelease-friendly range", () => {
    const m = JSON.parse(read(".capybara-plugin/plugin.json"));
    const parsed = parsePluginManifest(m);
    expect("errors" in parsed ? parsed.errors : []).toEqual([]);
    expect(m.dependencies).toEqual([
      { name: "connector-mcp", version: file.template.pluginVersion },
    ]);
    expect(file.template.pluginVersion).toMatch(/^\^0\.1\.0-rc\.\d+$/);
  });
});

describe("app-manifest.connector.yaml", () => {
  const m = parse(read("app-manifest.connector.yaml")) as {
    oauth_config: { redirect_urls: string[]; scopes: { user: string[]; bot?: string[] } };
    settings: Record<string, unknown>;
    features?: unknown;
  };

  it("asks for exactly the template's user scopes, no bot, MCP on, rotation off", () => {
    expect(m.oauth_config.scopes.user).toEqual(SCOPES);
    expect(m.oauth_config.scopes.bot).toBeUndefined();
    expect(m.features).toBeUndefined();
    expect(m.settings).toMatchObject({
      is_mcp_enabled: true,
      socket_mode_enabled: false,
      token_rotation_enabled: false,
    });
  });

  it("names the kernel's OAuth callback as the redirect URL", () => {
    expect(m.oauth_config.redirect_urls).toEqual([
      "https://capybara.example.com/api/v1/oauth/callback",
    ]);
  });
});
