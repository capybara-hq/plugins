import { readFileSync } from "node:fs";
import {
  parsePluginManifest,
  renderSetupGuideText,
  SETUP_GUIDE_VARIABLES,
  unknownSetupGuidePlaceholders,
} from "@capybara-hq/plugin-sdk";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const root = new URL("../", import.meta.url);
const manifestJson = JSON.parse(
  readFileSync(new URL(".capybara-plugin/plugin.json", root), "utf8"),
) as {
  setupGuides: {
    id: string;
    place: "channel-connection";
    steps: { en: string; zh?: string; mode?: string }[];
    files: { path: string; language: "yaml"; mode: string }[];
  }[];
};
const guide = manifestJson.setupGuides[0];
if (!guide) throw new Error("plugin.json has no setup guide");
const known = SETUP_GUIDE_VARIABLES["channel-connection"];

const fileFor = (mode: string) => {
  const f = guide.files.find((x) => x.mode === mode);
  if (!f) throw new Error(`no file for ${mode}`);
  return readFileSync(new URL(f.path, root), "utf8");
};

// A name with characters that would break YAML if the placeholder were not escaped and quoted
const values = {
  publicUrl: "https://capybara.example.com",
  webhookUrl:
    "https://hooks.capybara.example.com/channels/webhook/0b9e6c1e-7d2f-4f4e-9b1a-2c3d4e5f6a7b",
  signInCallbackUrl: "https://capybara.example.com/api/v1/auth/sso/slack/callback",
  connectionName: 'Ops: "bot" # 1\nnext',
  orgName: "Acme",
  pluginName: "slack",
  pluginVersion: "0.1.0",
};

type Manifest = {
  display_information: { name: string };
  features: {
    bot_user: { display_name: string };
    slash_commands: {
      command: string;
      url?: string;
      should_escape: boolean;
      usage_hint?: string;
    }[];
  };
  oauth_config: { redirect_urls: string[]; scopes: { bot: string[]; user?: string[] } };
  settings: {
    event_subscriptions: { request_url?: string; bot_events: string[] };
    interactivity: { is_enabled: boolean; request_url?: string };
    socket_mode_enabled: boolean;
    token_rotation_enabled: boolean;
  };
};

const render = (mode: string) => {
  const r = renderSetupGuideText(fileFor(mode), { ...values, mode }, "yaml", known);
  expect(r.unresolved).toEqual([]);
  return parse(r.text) as Manifest;
};

const BOT_SCOPES = [
  "app_mentions:read",
  "channels:history",
  "chat:write",
  "commands",
  "groups:history",
  "im:history",
  "im:write",
  "users:read",
  "users:read.email",
];
const BOT_EVENTS = [
  "app_mention",
  "message.channels",
  "message.groups",
  "message.im",
  "team_join",
  "user_change",
];

describe("setup guide slack-app", () => {
  it("is a valid plugin.json guide with one manifest per inbound mode", () => {
    const parsed = parsePluginManifest(manifestJson);
    expect("errors" in parsed ? parsed.errors : []).toEqual([]);
    expect(guide).toMatchObject({ id: "slack-app", place: "channel-connection" });
    expect(guide.files.map((f) => f.mode).sort()).toEqual(["long_connection", "webhook"]);
    for (const s of guide.steps) expect(s.zh).toBeTruthy();
  });

  it("uses only placeholders the channel-connection place defines, always inside double quotes", () => {
    for (const mode of ["long_connection", "webhook"]) {
      const text = fileFor(mode);
      expect(unknownSetupGuidePlaceholders(text, "channel-connection")).toEqual([]);
      for (const line of text.split("\n").filter((l) => l.includes("{{"))) {
        expect(line).toMatch(/"\{\{[A-Za-z]+\}\}"/);
      }
    }
    for (const s of guide.steps) {
      expect(unknownSetupGuidePlaceholders(s.en, "channel-connection")).toEqual([]);
      expect(unknownSetupGuidePlaceholders(s.zh ?? "", "channel-connection")).toEqual([]);
    }
  });

  for (const mode of ["long_connection", "webhook"] as const) {
    it(`${mode}: renders to a manifest with the plugin's scopes, events and commands`, () => {
      const m = render(mode);
      expect(m.display_information.name).toBe(values.connectionName);
      expect(m.features.bot_user.display_name).toBe("capybara");
      expect(m.oauth_config.redirect_urls).toEqual([values.signInCallbackUrl]);
      expect([...m.oauth_config.scopes.bot].sort()).toEqual(BOT_SCOPES);
      expect(m.oauth_config.scopes.user).toBeUndefined();
      expect([...m.settings.event_subscriptions.bot_events].sort()).toEqual(BOT_EVENTS);
      expect(m.settings.interactivity.is_enabled).toBe(true);
      expect(m.settings.token_rotation_enabled).toBe(false);
      expect(m.features.slash_commands.map((c) => c.command)).toEqual([
        "/new",
        "/env",
        "/capybara",
      ]);
      // Text arrives as typed (no <@U…> rewriting of mentions)
      expect(m.features.slash_commands.every((c) => c.should_escape === false)).toBe(true);
      expect(m.features.slash_commands.find((c) => c.command === "/capybara")?.usage_hint).toBe(
        "<skill> [args]",
      );
    });
  }

  it("long_connection: Socket Mode on, no request URLs", () => {
    const m = render("long_connection");
    expect(m.settings.socket_mode_enabled).toBe(true);
    expect(m.settings.event_subscriptions.request_url).toBeUndefined();
    expect(m.settings.interactivity.request_url).toBeUndefined();
    expect(m.features.slash_commands.every((c) => c.url === undefined)).toBe(true);
  });

  it("webhook: Socket Mode off, events, clicks and slash commands go to the webhook URL", () => {
    const m = render("webhook");
    expect(m.settings.socket_mode_enabled).toBe(false);
    expect(m.settings.event_subscriptions.request_url).toBe(values.webhookUrl);
    expect(m.settings.interactivity.request_url).toBe(values.webhookUrl);
    expect(m.features.slash_commands.map((c) => c.url)).toEqual([
      values.webhookUrl,
      values.webhookUrl,
      values.webhookUrl,
    ]);
  });

  it("before the connection exists, the webhook URL is reported unresolved and stays visible", () => {
    const { webhookUrl: _, ...rest } = values;
    const r = renderSetupGuideText(fileFor("webhook"), rest, "yaml", known);
    expect(r.unresolved).toEqual(["webhookUrl"]);
    expect(r.text).toContain('request_url: "{{webhookUrl}}"');
    expect(() => parse(r.text)).not.toThrow();
  });
});
