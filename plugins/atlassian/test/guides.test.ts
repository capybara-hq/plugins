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
 * The setup guides of the three connector templates: `guides/<id>-oauth.md` (template `<id>`),
 * each with a zh document whose code blocks are byte-equal. The plugin has no extension, so only
 * kernel checks appear, and none of them is about a manually entered client: the templates
 * register their client with dynamic client registration.
 */
const root = new URL("../", import.meta.url);
const read = (p: string) => readFileSync(new URL(p, root), "utf8");
const doc = (id: string, locale: "en" | "zh") =>
  read(locale === "en" ? `guides/${id}.md` : `guides/${id}.zh.md`);

// Names with characters that would break YAML or Markdown if a value were not escaped
const values = {
  publicUrl: "https://capybara.example.com",
  signInCallbackUrl: "https://capybara.example.com/api/v1/auth/sso/x/callback",
  oauthCallbackUrl: "https://capybara.example.com/api/v1/oauth/callback",
  templateName: 'Jira "work" # 2\nnext',
  templateId: "jira",
  connectorName: "Jira",
  orgName: "Acme",
  pluginName: "atlassian",
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

/** [template id, product name]. */
const TEMPLATES: [string, string][] = [
  ["jira", "Jira"],
  ["confluence", "Confluence"],
  ["bitbucket", "Bitbucket"],
];

describe("plugin.json setupGuides", () => {
  it("declares one guide per connector template", () => {
    const m = JSON.parse(read(".capybara-plugin/plugin.json"));
    const parsed = parsePluginManifest(m);
    expect("errors" in parsed ? parsed.errors : []).toEqual([]);
    expect(m.setupGuides).toEqual(
      TEMPLATES.map(([id]) => ({
        id: `${id}-oauth`,
        place: "connector-template",
        templates: [id],
      })),
    );
  });
});

describe.each(TEMPLATES)("guides/%s-oauth.md", (template, name) => {
  const id = `${template}-oauth`;
  const scopes = (
    JSON.parse(read(`connectors/${template}.json`)) as { template: { auth: { scopes: string[] } } }
  ).template.auth.scopes;

  it("en and zh validate without errors or warnings", () => {
    const issues = validateSetupGuide({
      place: "connector-template",
      id,
      en: doc(id, "en"),
      zh: doc(id, "zh"),
      pluginChecks: [],
    });
    expect(issues).toEqual([]);
  });

  it("the zh document renders byte-equal code blocks and the same checks", () => {
    for (const audience of ["admin", "member"] as const) {
      const en = render(id, audience);
      const zh = render(id, audience, "zh");
      expect(codeBlocks(zh).map((b) => b.text)).toEqual(codeBlocks(en).map((b) => b.text));
      expect(zh.checks.map((c) => c.id)).toEqual(en.checks.map((c) => c.id));
    }
  });

  it("zh uses the platform's terms", () => {
    const zh = doc(id, "zh");
    expect(zh).not.toContain("企业");
    expect(zh.replace(/agent-interface/g, "")).not.toMatch(/\bagents?\b/i);
  });

  it("admin: nothing to enter, the Atlassian domain rule with the callback URL, DCR-only checks", () => {
    const r = render(id, "admin");
    expect(r.title).toBe(`Set up the ${name} connector`);
    expect(r.audiences).toEqual(["admin", "member"]);
    expect(r.unresolved).toEqual([]);
    const blocks = codeBlocks(r);
    expect(blocks).toHaveLength(1);
    const s = parse(blocks[0]?.text ?? "") as Record<string, unknown>;
    expect(s.Domain).toBe(values.oauthCallbackUrl);
    expect(s.Where).toContain("Atlassian MCP server");
    // The hostile template name stays inside the YAML comment
    expect(blocks[0]?.text.split("\n")[0]).toContain('Jira \\"work\\" # 2\\nnext');
    expect(r.checks.map((c) => c.id)).toEqual(["capybara:public-url", "capybara:connector-tools"]);
    const text = prose(r);
    expect(text).toContain("dynamic client registration");
    for (const scope of scopes) expect(text, scope).toContain(`\`${scope}\``);
    expect(text).toContain("?tools=all");
  });

  it("member: how to connect and revoke, no settings, the connected check only", () => {
    const r = render(id, "member");
    expect(codeBlocks(r)).toEqual([]);
    expect(r.checks.map((c) => c.id)).toEqual(["capybara:connector-connected"]);
    expect(prose(r)).toContain("Connect your Atlassian account");
    expect(prose(r)).not.toContain("Allow Capybara in your Atlassian organization");
  });
});

describe("guides/bitbucket-oauth.md", () => {
  it("states the workspace link and that OAuth access is unconfirmed", () => {
    for (const locale of ["en", "zh"] as const) {
      const text = prose(render("bitbucket-oauth", "admin", locale));
      expect(text).toContain(
        locale === "en" ? "linked to an Atlassian organization" : "关联到 Atlassian 组织",
      );
      expect(text).toContain(locale === "en" ? "not been confirmed" : "还没有在真实工作区上验证过");
    }
  });
});
