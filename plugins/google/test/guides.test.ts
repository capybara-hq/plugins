import { readFileSync } from "node:fs";
import {
  parsePluginManifest,
  type RenderedSetupGuideDoc,
  renderSetupGuide,
  SETUP_GUIDE_LIMITS,
  type SetupGuideAudience,
  validateSetupGuide,
} from "@capybara-hq/plugin-sdk";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import extension from "../src/index.js";

/** The platform setup guide `guides/google-sign-in.md` (place `extension-deployment`). */
const doc = (locale: "en" | "zh") =>
  readFileSync(
    new URL(`../guides/google-sign-in${locale === "zh" ? ".zh" : ""}.md`, import.meta.url),
    "utf8",
  );
const values = { pluginName: "google", pluginVersion: "0.1.0", publicUrl: "https://cap.example" };

describe("setup guide google-sign-in", () => {
  it("is valid in both languages and uses only declared checks", () => {
    expect(
      validateSetupGuide({
        id: "google-sign-in",
        place: "extension-deployment",
        en: doc("en"),
        zh: doc("zh"),
        pluginChecks: extension.permissions?.setupChecks ?? [],
      }),
    ).toEqual([]);
  });

  it.each(["en", "zh"] as const)("renders (%s) with both checks and the callback URL", (locale) => {
    const r = renderSetupGuide(doc(locale), {
      place: "extension-deployment",
      mode: null,
      audience: "admin",
      values,
    });
    expect(r.title).toBeTruthy();
    const text = JSON.stringify(r.blocks);
    expect(text).toContain("google-discovery");
    expect(text).toContain("google-client");
    expect(text).toContain("https://cap.example/api/v1/auth/sso/google/callback");
    expect(text).toContain("google:consumer");
    expect(text).toContain("login-sources.update");
    expect(text).not.toContain("auth.loginSources");
  });

  it("the zh guide uses the platform terms", () => {
    const zh = doc("zh");
    expect(zh).not.toContain("企业");
    expect(zh).not.toMatch(/\bagents?\b/i);
  });
});

/**
 * The connector template guides `guides/<template id>-oauth.md` (place `connector-template`), one
 * per template, with zh documents whose code blocks are byte-equal. Only kernel checks appear.
 */
const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const guideDoc = (id: string, locale: "en" | "zh") =>
  read(locale === "en" ? `guides/${id}.md` : `guides/${id}.zh.md`);

/** [template id, the services the admin enables], in D8 order. */
const TEMPLATE_GUIDES: [string, string[]][] = [
  ["gmail", ["gmail.googleapis.com", "gmailmcp.googleapis.com"]],
  ["google-drive", ["drive.googleapis.com", "drivemcp.googleapis.com"]],
  ["google-calendar", ["calendar-json.googleapis.com", "calendarmcp.googleapis.com"]],
  ["google-sheets", ["sheets.googleapis.com", "sheetsmcp.googleapis.com"]],
  ["google-docs", ["docs.googleapis.com", "docsmcp.googleapis.com"]],
  ["google-slides", ["slides.googleapis.com", "slidesmcp.googleapis.com"]],
  ["bigquery", ["bigquery.googleapis.com"]],
];

// Names with characters that would break YAML or Markdown if a value were not escaped
const templateValues = (templateId: string) => ({
  publicUrl: "https://capybara.example.com",
  oauthCallbackUrl: "https://capybara.example.com/api/v1/oauth/callback",
  templateName: 'Google "work" # 2\nnext',
  templateId,
  connectorName: "Google",
  orgName: "Acme",
  pluginName: "google",
  pluginVersion: "0.1.0",
});

const renderTemplateGuide = (
  templateId: string,
  audience: SetupGuideAudience,
  locale: "en" | "zh" = "en",
): RenderedSetupGuideDoc =>
  renderSetupGuide(guideDoc(`${templateId}-oauth`, locale), {
    place: "connector-template",
    mode: null,
    audience,
    values: templateValues(templateId),
  });
const codeBlocks = (r: RenderedSetupGuideDoc) =>
  r.blocks.flatMap((b) => (b.kind === "code" ? [b] : []));
const prose = (r: RenderedSetupGuideDoc) =>
  r.blocks.flatMap((b) => (b.kind === "markdown" ? [b.text] : [])).join("\n");

describe("connector template guides", () => {
  it("plugin.json declares the sign-in guide and one guide per template: the limit of eight", () => {
    const m = JSON.parse(read(".capybara-plugin/plugin.json"));
    const parsed = parsePluginManifest(m);
    expect("errors" in parsed ? parsed.errors : []).toEqual([]);
    expect(m.setupGuides).toEqual([
      { id: "google-sign-in", place: "extension-deployment" },
      ...TEMPLATE_GUIDES.map(([id]) => ({
        id: `${id}-oauth`,
        place: "connector-template",
        templates: [id],
      })),
    ]);
    expect(m.setupGuides).toHaveLength(SETUP_GUIDE_LIMITS.guides);
  });

  describe.each(TEMPLATE_GUIDES)("guides/%s-oauth.md", (templateId, services) => {
    const id = `${templateId}-oauth`;
    const template = JSON.parse(read(`connectors/${templateId}.json`)) as {
      template: { auth: { scopes: string[] }; defaultToolPolicies: Record<string, string> };
    };

    it("en and zh validate without errors or warnings", () => {
      const issues = validateSetupGuide({
        place: "connector-template",
        id,
        en: guideDoc(id, "en"),
        zh: guideDoc(id, "zh"),
        pluginChecks: [],
      });
      expect(issues).toEqual([]);
    });

    it("the zh document renders byte-equal code blocks, the same checks and the platform terms", () => {
      for (const audience of ["admin", "member"] as const) {
        const en = renderTemplateGuide(templateId, audience);
        const zh = renderTemplateGuide(templateId, audience, "zh");
        expect(codeBlocks(zh).map((b) => b.text)).toEqual(codeBlocks(en).map((b) => b.text));
        expect(zh.checks.map((c) => c.id)).toEqual(en.checks.map((c) => c.id));
        // Google's setting name in the byte-equal YAML block is the only Latin "agent" allowed
        expect(prose(zh)).not.toMatch(/\bagents?\b/i);
        expect(zh.checks.map((c) => c.label).join("\n")).not.toMatch(/\bagents?\b/i);
      }
      expect(guideDoc(id, "zh")).not.toContain("企业");
    });

    it("admin: the services, the agent-flagged Web client with the callback and exactly the scopes", () => {
      const r = renderTemplateGuide(templateId, "admin");
      expect(r.title).toBeTruthy();
      expect(r.audiences).toEqual(["admin", "member"]);
      expect(r.unresolved).toEqual([]);
      const blocks = codeBlocks(r);
      expect(blocks).toHaveLength(2);
      const [sh, yaml] = blocks;
      const enable = sh?.text.trim() ?? "";
      expect(enable).toMatch(/^gcloud services enable [a-z.\- ]+ --project=PROJECT_ID$/);
      expect(
        enable
          .replace(/^gcloud services enable /, "")
          .replace(/ --project=PROJECT_ID$/, "")
          .split(" "),
      ).toEqual(services);
      const client = parse(yaml?.text ?? "") as Record<string, unknown>;
      expect(client["Application type"]).toBe("Web application");
      expect(client["Authorized redirect URIs"]).toEqual([
        templateValues(templateId).oauthCallbackUrl,
      ]);
      expect(client["Use this client for an AI-powered agent"]).toBe("on");
      expect(client["Scopes requested"]).toEqual(template.template.auth.scopes);
      // The hostile template name stays inside the YAML comment
      expect(yaml?.text.split("\n")[0]).toContain('Google \\"work\\" # 2\\nnext');
      expect(yaml?.text.split("\n")[0]?.startsWith("#")).toBe(true);
      expect(prose(r)).toContain("Use this client for an AI-powered agent");
      expect(prose(r)).toContain("separate from your Sign in with Google client");
      expect(r.checks.map((c) => c.id)).toEqual([
        "capybara:oauth-client",
        "capybara:oauth-token-endpoint",
        "capybara:connector-tools",
      ]);
    });

    it("admin: names every write tool, which asks first", () => {
      const text = prose(renderTemplateGuide(templateId, "admin"));
      const writes = Object.entries(template.template.defaultToolPolicies)
        .filter(([, p]) => p === "ask")
        .map(([t]) => t);
      for (const t of writes) expect(text, t).toContain(`\`${t}\``);
    });

    it("admin: the preview enrolment for Workspace, the roles for BigQuery", () => {
      const text = prose(renderTemplateGuide(templateId, "admin"));
      if (templateId === "bigquery") {
        expect(text).not.toContain("Developer Preview Program");
        for (const role of [
          "roles/mcp.toolUser",
          "roles/bigquery.jobUser",
          "roles/bigquery.dataViewer",
        ])
          expect(text).toContain(role);
      } else {
        expect(text).toContain("Developer Preview Program");
      }
    });

    it("member: how to connect and revoke, keep every box ticked, the connected check only", () => {
      const r = renderTemplateGuide(templateId, "member");
      expect(codeBlocks(r)).toEqual([]);
      expect(r.checks.map((c) => c.id)).toEqual(["capybara:connector-connected"]);
      expect(prose(r)).toContain("Keep every box ticked");
      expect(prose(r)).toContain("Connect your Google account");
      expect(prose(r)).not.toContain("OAuth client");
    });
  });
});
