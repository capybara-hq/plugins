import { readFileSync } from "node:fs";
import {
  parsePluginManifest,
  type RenderedSetupGuideDoc,
  renderSetupGuide,
  type SetupGuideAudience,
  validateSetupGuide,
} from "@capybara-hq/plugin-sdk";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

/**
 * The setup guides of the two connector templates: `guides/github-oauth.md` (template `github`)
 * and `guides/github-pat.md` (template `github-pat`), each with a zh document whose code blocks
 * are byte-equal. The plugin has no extension, so only kernel checks appear.
 */
const root = new URL("../", import.meta.url);
const read = (p: string) => readFileSync(new URL(p, root), "utf8");
const doc = (id: string, locale: "en" | "zh") =>
  read(locale === "en" ? `guides/${id}.md` : `guides/${id}.zh.md`);
const oauthTemplate = JSON.parse(read("connectors/github.json")) as {
  template: { auth: { scopes: string[] } };
};

// Names with characters that would break YAML or Markdown if a value were not escaped
const values = {
  publicUrl: "https://capybara.example.com",
  signInCallbackUrl: "https://capybara.example.com/api/v1/auth/sso/x/callback",
  oauthCallbackUrl: "https://capybara.example.com/api/v1/oauth/callback",
  templateName: 'GitHub "work" # 2\nnext',
  templateId: "github",
  connectorName: "GitHub",
  orgName: "Acme",
  pluginName: "github",
  pluginVersion: "0.1.0",
};

const render = (
  id: string,
  audience: SetupGuideAudience,
  locale: "en" | "zh" = "en",
): RenderedSetupGuideDoc =>
  renderSetupGuide(doc(id, locale), {
    place: "connector-template",
    mode: null,
    audience,
    values,
  });
const codeBlocks = (r: RenderedSetupGuideDoc) =>
  r.blocks.flatMap((b) => (b.kind === "code" ? [b] : []));
const prose = (r: RenderedSetupGuideDoc) =>
  r.blocks.flatMap((b) => (b.kind === "markdown" ? [b.text] : [])).join("\n");

/** The permissions the GitHub App and the fine-grained token are asked for. */
const REPOSITORY_PERMISSIONS = {
  Actions: "Read and write",
  Checks: "Read-only",
  "Commit statuses": "Read-only",
  Contents: "Read and write",
  Issues: "Read and write",
  Metadata: "Read-only",
  "Pull requests": "Read and write",
  Workflows: "Read and write",
};

describe("plugin.json setupGuides", () => {
  it("declares one guide per connector template", () => {
    const m = JSON.parse(read(".capybara-plugin/plugin.json"));
    const parsed = parsePluginManifest(m);
    expect("errors" in parsed ? parsed.errors : []).toEqual([]);
    expect(m.setupGuides).toEqual([
      { id: "github-oauth", place: "connector-template", template: "github" },
      { id: "github-pat", place: "connector-template", template: "github-pat" },
    ]);
  });

  for (const id of ["github-oauth", "github-pat"]) {
    it(`${id}: en and zh validate without errors or warnings`, () => {
      const issues = validateSetupGuide({
        place: "connector-template",
        id,
        en: doc(id, "en"),
        zh: doc(id, "zh"),
        pluginChecks: [],
      });
      expect(issues).toEqual([]);
    });

    it(`${id}: the zh document renders byte-equal code blocks and the same checks`, () => {
      for (const audience of ["admin", "member"] as const) {
        const en = render(id, audience);
        const zh = render(id, audience, "zh");
        expect(codeBlocks(zh).map((b) => b.text)).toEqual(codeBlocks(en).map((b) => b.text));
        expect(zh.checks.map((c) => c.id)).toEqual(en.checks.map((c) => c.id));
      }
    });
  }
});

describe("guides/github-oauth.md", () => {
  it("admin: the GitHub App settings with the callback URL, expiring tokens and the permissions", () => {
    const r = render("github-oauth", "admin");
    expect(r.title).toBe("Set up the GitHub connector");
    expect(r.audiences).toEqual(["admin", "member"]);
    expect(r.unresolved).toEqual([]);
    const blocks = codeBlocks(r);
    expect(blocks).toHaveLength(1);
    const s = parse(blocks[0]?.text ?? "") as Record<string, unknown>;
    expect(s["Callback URL"]).toBe(values.oauthCallbackUrl);
    expect(s["Homepage URL"]).toBe(values.publicUrl);
    expect(s["Expire user authorization tokens"]).toBe("on");
    expect(s["Webhook Active"]).toBe("off");
    expect(s["Repository permissions"]).toEqual(REPOSITORY_PERMISSIONS);
    // The hostile template name stays inside the YAML comment
    expect(blocks[0]?.text.split("\n")[0]).toContain('GitHub \\"work\\" # 2\\nnext');
    expect(r.checks.map((c) => c.id)).toEqual([
      "capybara:public-url",
      "capybara:oauth-client",
      "capybara:oauth-token-endpoint",
      "capybara:connector-tools",
    ]);
  });

  it("admin: the OAuth App alternative names exactly the template's scopes", () => {
    const text = prose(render("github-oauth", "admin"));
    for (const scope of oauthTemplate.template.auth.scopes) expect(text).toContain(`\`${scope}\``);
  });

  it("member: how to connect and revoke, no settings, the connected check only", () => {
    const r = render("github-oauth", "member");
    expect(codeBlocks(r)).toEqual([]);
    expect(r.checks.map((c) => c.id)).toEqual(["capybara:connector-connected"]);
    expect(prose(r)).toContain("Connect your GitHub account");
    expect(prose(r)).not.toContain("Register a GitHub App");
  });
});

describe("guides/github-pat.md", () => {
  it("admin: when to switch the template on, no token settings", () => {
    const r = render("github-pat", "admin");
    expect(r.unresolved).toEqual([]);
    expect(codeBlocks(r)).toEqual([]);
    expect(r.checks.map((c) => c.id)).toEqual(["capybara:connector-tools"]);
  });

  it("member: a fine-grained token with the GitHub App's permissions except Checks", () => {
    const r = render("github-pat", "member");
    expect(r.unresolved).toEqual([]);
    const blocks = codeBlocks(r);
    expect(blocks).toHaveLength(1);
    const s = parse(blocks[0]?.text ?? "") as Record<string, unknown>;
    // fine-grained tokens have no Checks permission
    const { Checks: _checks, ...patPermissions } = REPOSITORY_PERMISSIONS;
    expect(s["Repository permissions"]).toEqual(patPermissions);
    expect(s["Repository access"]).toBe("Only select repositories");
    expect(r.checks.map((c) => c.id)).toEqual(["capybara:connector-connected"]);
  });
});
