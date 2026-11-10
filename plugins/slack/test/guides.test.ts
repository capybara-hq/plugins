import { readFileSync } from "node:fs";
import {
  parsePluginManifest,
  type RenderedSetupGuideDoc,
  renderSetupGuide,
  type SetupGuideAudience,
  type SetupGuidePlace,
  validateSetupGuide,
} from "@capybara-hq/plugin-sdk";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import plugin, { REQUIRED_BOT_SCOPES } from "../src/index.js";

/**
 * The setup guides (spec 2026-11-09-setup-guides-v2-design.md §5): `guides/slack-app.md` on
 * channel connections and `guides/slack-connector.md` on the Slack connector template, each with
 * a zh document whose code blocks are byte-equal.
 */
const root = new URL("../", import.meta.url);
const read = (p: string) => readFileSync(new URL(p, root), "utf8");
const manifestJson = JSON.parse(read(".capybara-plugin/plugin.json")) as {
  setupGuides: { id: string; place: SetupGuidePlace; template?: string }[];
};
const doc = (id: string, locale: "en" | "zh") =>
  read(locale === "en" ? `guides/${id}.md` : `guides/${id}.zh.md`);
const pluginChecks = plugin.permissions?.setupChecks ?? [];

// Names with characters that would break YAML or Markdown if a value were not escaped
const values = {
  publicUrl: "https://capybara.example.com",
  webhookUrl:
    "https://hooks.capybara.example.com/channels/webhook/0b9e6c1e-7d2f-4f4e-9b1a-2c3d4e5f6a7b",
  signInCallbackUrl: "https://capybara.example.com/api/v1/auth/sso/slack/callback",
  oauthCallbackUrl: "https://capybara.example.com/api/v1/oauth/callback",
  connectionName: 'Ops: "bot" # 1\nnext `x` {{orgName}}',
  templateName: 'Slack "work" # 2\nnext',
  templateId: "slack",
  orgName: "Acme",
  pluginName: "slack",
  pluginVersion: "0.1.0",
};

const render = (
  id: string,
  place: SetupGuidePlace,
  mode: string | null,
  audience: SetupGuideAudience,
  locale: "en" | "zh" = "en",
  vals: Record<string, string | null> = values,
): RenderedSetupGuideDoc =>
  renderSetupGuide(doc(id, locale), { place, mode, audience, values: vals });

const codeBlocks = (r: RenderedSetupGuideDoc) =>
  r.blocks.flatMap((b) => (b.kind === "code" ? [b] : []));

type AppManifest = {
  display_information: { name: string };
  features: {
    bot_user: { display_name: string };
    slash_commands?: {
      command: string;
      url?: string;
      should_escape: boolean;
      usage_hint?: string;
    }[];
  };
  oauth_config: { redirect_urls: string[]; scopes: { bot: string[]; user?: string[] } };
  settings: {
    event_subscriptions?: { request_url?: string; bot_events: string[] };
    interactivity?: { is_enabled: boolean; request_url?: string };
    socket_mode_enabled: boolean;
    token_rotation_enabled: boolean;
  };
};

/** The manifests of a mode, in order: one for long connection; basic then full for webhook. */
const appManifests = (mode: string): AppManifest[] => {
  const r = render("slack-app", "channel-connection", mode, "admin");
  expect(r.unresolved).toEqual([]);
  const blocks = codeBlocks(r);
  expect(blocks).toHaveLength(mode === "webhook" ? 2 : 1);
  return blocks.map((b) => {
    expect(b.language).toBe("yaml");
    return parse(b.text) as AppManifest;
  });
};

/** The manifest with the slash commands and events: the only one, or the webhook full one. */
const appManifest = (mode: string): AppManifest => {
  const m = appManifests(mode).at(-1);
  if (!m) throw new Error("no code block");
  return m;
};

const BOT_EVENTS = [
  "app_mention",
  "message.channels",
  "message.groups",
  "message.im",
  "team_join",
  "user_change",
];

describe("plugin.json setupGuides", () => {
  it("declares the channel guide and the connector template guide (spec §5.1)", () => {
    const parsed = parsePluginManifest(manifestJson);
    expect("errors" in parsed ? parsed.errors : []).toEqual([]);
    expect(manifestJson.setupGuides).toEqual([
      { id: "slack-app", place: "channel-connection" },
      { id: "slack-connector", place: "connector-template", template: "slack" },
    ]);
  });

  it("the extension declares the three plugin checks", () => {
    expect([...pluginChecks].sort()).toEqual(["app-token", "bot-scopes", "bot-token"]);
  });

  for (const g of [
    { id: "slack-app", place: "channel-connection" as const },
    { id: "slack-connector", place: "connector-template" as const },
  ]) {
    it(`${g.id}: en and zh validate without errors or warnings`, () => {
      const issues = validateSetupGuide({
        place: g.place,
        id: g.id,
        en: doc(g.id, "en"),
        zh: doc(g.id, "zh"),
        pluginChecks,
      });
      expect(issues).toEqual([]);
    });
  }
});

describe("guides/slack-app.md", () => {
  it("has the long connection and webhook modes for admins", () => {
    const r = render("slack-app", "channel-connection", "long_connection", "admin");
    expect(r.title).toBe("Create the Slack app");
    expect(r.modes).toEqual(["long_connection", "webhook"]);
    expect(render("slack-app", "channel-connection", "long_connection", "admin", "zh").title).toBe(
      "创建 Slack 应用",
    );
  });

  for (const mode of ["long_connection", "webhook"] as const) {
    it(`${mode}: renders to a manifest with the plugin's scopes, events and commands`, () => {
      const m = appManifest(mode);
      expect(m.display_information.name).toBe(values.connectionName);
      expect(m.features.bot_user.display_name).toBe("Capybara");
      expect(m.oauth_config.redirect_urls).toEqual([values.signInCallbackUrl]);
      // The bot-scopes check compares against exactly these scopes
      expect([...m.oauth_config.scopes.bot].sort()).toEqual([...REQUIRED_BOT_SCOPES].sort());
      expect(m.oauth_config.scopes.user).toBeUndefined();
      expect([...(m.settings.event_subscriptions?.bot_events ?? [])].sort()).toEqual(BOT_EVENTS);
      expect(m.settings.interactivity?.is_enabled).toBe(true);
      expect(m.settings.token_rotation_enabled).toBe(false);
      expect(m.features.slash_commands?.map((c) => c.command)).toEqual([
        "/new",
        "/env",
        "/capybara",
      ]);
      // Text arrives as typed (no <@U…> rewriting of mentions)
      expect(m.features.slash_commands?.every((c) => c.should_escape === false)).toBe(true);
      expect(m.features.slash_commands?.find((c) => c.command === "/capybara")?.usage_hint).toBe(
        "<skill> [args]",
      );
    });

    it(`${mode}: the zh document renders byte-equal code blocks`, () => {
      const en = codeBlocks(render("slack-app", "channel-connection", mode, "admin"));
      const zh = codeBlocks(render("slack-app", "channel-connection", mode, "admin", "zh"));
      expect(zh.map((b) => b.text)).toEqual(en.map((b) => b.text));
      expect(zh.map((b) => b.title)).not.toEqual(en.map((b) => b.title));
    });
  }

  it("long_connection: Socket Mode on, no request URLs, the app token check", () => {
    const m = appManifest("long_connection");
    expect(m.settings.socket_mode_enabled).toBe(true);
    expect(m.settings.event_subscriptions?.request_url).toBeUndefined();
    expect(m.settings.interactivity?.request_url).toBeUndefined();
    expect(m.features.slash_commands?.every((c) => c.url === undefined)).toBe(true);
    const r = render("slack-app", "channel-connection", "long_connection", "admin");
    expect(r.checks.map((c) => [c.id, c.source])).toEqual([
      ["app-token", "plugin"],
      ["bot-token", "plugin"],
      ["bot-scopes", "plugin"],
      ["capybara:public-url", "kernel"],
    ]);
  });

  it("webhook: a basic manifest without addresses comes before saving", () => {
    const [basic, full] = appManifests("webhook");
    if (!basic || !full) throw new Error("expected two manifests");
    expect(basic.display_information.name).toBe(values.connectionName);
    expect(basic.features.bot_user.display_name).toBe("Capybara");
    expect(basic.features.slash_commands).toBeUndefined();
    expect(basic.settings.event_subscriptions).toBeUndefined();
    expect(basic.settings.interactivity).toBeUndefined();
    expect(basic.settings).toEqual({
      socket_mode_enabled: false,
      org_deploy_enabled: false,
      token_rotation_enabled: false,
    });
    // The same bot and Sign in with Slack settings as the full manifest
    expect(basic.oauth_config).toEqual(full.oauth_config);
    const [basicBlock] = codeBlocks(render("slack-app", "channel-connection", "webhook", "admin"));
    expect(basicBlock?.text).not.toContain(values.webhookUrl);
  });

  it("webhook: the full manifest sends events, clicks and slash commands to the webhook URL", () => {
    const m = appManifest("webhook");
    expect(m.settings.socket_mode_enabled).toBe(false);
    expect(m.settings.event_subscriptions?.request_url).toBe(values.webhookUrl);
    expect(m.settings.interactivity?.request_url).toBe(values.webhookUrl);
    expect(m.features.slash_commands?.map((c) => c.url)).toEqual([
      values.webhookUrl,
      values.webhookUrl,
      values.webhookUrl,
    ]);
    const r = render("slack-app", "channel-connection", "webhook", "admin");
    expect(r.checks.map((c) => c.id)).toEqual([
      "bot-token",
      "bot-scopes",
      "capybara:webhook-public",
      "capybara:webhook-received",
      "capybara:public-url",
    ]);
  });

  for (const mode of ["long_connection", "webhook"] as const) {
    it(`${mode}: one thematic break, then the reference material`, () => {
      for (const locale of ["en", "zh"] as const) {
        const r = render("slack-app", "channel-connection", mode, "admin", locale);
        const md = r.blocks.flatMap((b) => (b.kind === "markdown" ? [b.text] : [])).join("\n");
        const lines = md.split("\n");
        expect(lines.filter((l) => l === "***")).toHaveLength(1);
        const signIn = locale === "en" ? "## Sign in with Slack" : "## Slack 登录";
        expect(lines.indexOf(signIn)).toBeGreaterThan(lines.indexOf("***"));
      }
    });
  }

  it("each mode shows only its own steps", () => {
    const text = (mode: string) =>
      render("slack-app", "channel-connection", mode, "admin")
        .blocks.flatMap((b) => (b.kind === "markdown" ? [b.text] : []))
        .join("\n");
    expect(text("long_connection")).toContain("Create the app-level token");
    expect(text("long_connection")).not.toContain("signing secret");
    expect(text("webhook")).toContain("Copy the signing secret");
    expect(text("webhook")).not.toContain("app-level token");
  });

  it("before the connection exists, the webhook URL is reported unresolved and stays visible", () => {
    const { webhookUrl: _, ...rest } = values;
    const r = render("slack-app", "channel-connection", "webhook", "admin", "en", rest);
    expect(r.unresolved).toEqual(["webhookUrl"]);
    const b = codeBlocks(r).at(-1);
    expect(b?.text).toContain('request_url: "{{webhookUrl}}"');
    expect(() => parse(b?.text ?? "")).not.toThrow();
  });
});

describe("guides/slack-connector.md", () => {
  const template = JSON.parse(read("connectors/slack.json")) as {
    template: { auth: { scopes: string[] } };
  };
  type ConnectorManifest = {
    display_information: { name: string };
    oauth_config: { redirect_urls: string[]; scopes: { user: string[]; bot?: string[] } };
    settings: Record<string, unknown>;
    features?: unknown;
  };

  it("admin: one manifest asking for exactly the template's user scopes, no bot, MCP on", () => {
    const r = render("slack-connector", "connector-template", null, "admin");
    expect(r.title).toBe("Set up the Slack connector");
    expect(r.audiences).toEqual(["admin", "member"]);
    expect(r.unresolved).toEqual([]);
    const blocks = codeBlocks(r);
    expect(blocks).toHaveLength(1);
    const m = parse(blocks[0]?.text ?? "") as ConnectorManifest;
    expect(m.display_information.name).toBe("Capybara connector");
    expect(m.oauth_config.scopes.user).toEqual(template.template.auth.scopes);
    expect(m.oauth_config.scopes.bot).toBeUndefined();
    expect(m.features).toBeUndefined();
    expect(m.oauth_config.redirect_urls).toEqual([values.oauthCallbackUrl]);
    expect(m.settings).toMatchObject({
      is_mcp_enabled: true,
      socket_mode_enabled: false,
      token_rotation_enabled: false,
    });
    // The hostile template name stays inside the YAML comment
    expect(blocks[0]?.text.split("\n")[0]).toContain('Slack \\"work\\" # 2\\nnext');
    expect(r.checks.map((c) => c.id)).toEqual([
      "capybara:public-url",
      "capybara:oauth-client",
      "capybara:oauth-token-endpoint",
      "capybara:connector-tools",
    ]);
  });

  it("member: how to connect, no manifest, the connected check only", () => {
    const r = render("slack-connector", "connector-template", null, "member");
    expect(codeBlocks(r)).toEqual([]);
    expect(r.checks.map((c) => c.id)).toEqual(["capybara:connector-connected"]);
    const text = r.blocks.flatMap((b) => (b.kind === "markdown" ? [b.text] : [])).join("\n");
    expect(text).toContain("Connect your Slack account");
    expect(text).not.toContain("Create the OAuth app");
  });

  it("the zh document renders byte-equal code blocks for both audiences", () => {
    for (const audience of ["admin", "member"] as const) {
      const en = render("slack-connector", "connector-template", null, audience);
      const zh = render("slack-connector", "connector-template", null, audience, "zh");
      expect(codeBlocks(zh).map((b) => b.text)).toEqual(codeBlocks(en).map((b) => b.text));
      expect(zh.checks.map((c) => c.id)).toEqual(en.checks.map((c) => c.id));
    }
  });
});
