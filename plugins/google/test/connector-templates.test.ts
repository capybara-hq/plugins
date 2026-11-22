import { existsSync, readFileSync } from "node:fs";
import {
  ConnectorAuthSchema,
  OAUTH_RESERVED_AUTHORIZATION_PARAMS,
  parseConnectorTemplateFile,
  parsePluginManifest,
  validateConnectorTemplate,
} from "@capybara-hq/plugin-sdk";
import { describe, expect, it } from "vitest";
import { GOOGLE_ENDPOINTS } from "../src/config.js";

/**
 * The seven Google connector templates `connectors/<id>.json`: per-person OAuth with Google's
 * fixed endpoints, on connector-mcp against Google's hosted remote MCP servers. The auth preset is
 * the trust boundary (an org edits none of it), and the policies come from the recorded
 * `tools/list` fixtures in `test/fixtures/<id>-tools.json`.
 */
const root = new URL("../", import.meta.url);
const read = (p: string) => readFileSync(new URL(p, root), "utf8");
type Policy = "allow" | "ask" | "deny";
interface TemplateFile {
  displayName: { zh: string; en: string };
  description: string;
  defaultEnabled?: boolean;
  icon?: string;
  template: {
    plugin: string;
    pluginVersion: string;
    connector: string;
    endpoint: Record<string, unknown>;
    editableEndpoint?: string[];
    auth: Record<string, unknown> & {
      scopes: string[];
      authorizationParams?: Record<string, string>;
    };
    defaultToolPolicies: Record<string, Policy>;
  };
}
interface Fixture {
  endpoint: string;
  recordedAt: string;
  tools: { name: string; readOnlyHint: boolean; destructiveHint: boolean; scopes: string[] }[];
}

const S = (...names: string[]) => names.map((n) => `https://www.googleapis.com/auth/${n}`);

/** [template id, endpoint, scopes, zh / en display name], in D8 order. */
const TEMPLATES: [string, string, string[], [string, string]][] = [
  [
    "gmail",
    "https://gmailmcp.googleapis.com/mcp/v1",
    S("gmail.readonly", "gmail.compose", "gmail.modify"),
    ["Gmail", "Gmail"],
  ],
  [
    "google-drive",
    "https://drivemcp.googleapis.com/mcp/v1",
    S("drive.readonly", "drive.file"),
    ["Google 云端硬盘", "Google Drive"],
  ],
  [
    "google-calendar",
    "https://calendarmcp.googleapis.com/mcp/v1",
    S(
      "calendar.calendarlist.readonly",
      "calendar.events.freebusy",
      "calendar.events.readonly",
      "calendar.events",
    ),
    ["Google 日历", "Google Calendar"],
  ],
  [
    "google-sheets",
    "https://sheetsmcp.googleapis.com/mcp/v1",
    S("drive.readonly", "drive.file", "spreadsheets.readonly", "spreadsheets"),
    ["Google 表格", "Google Sheets"],
  ],
  [
    "google-docs",
    "https://docsmcp.googleapis.com/mcp/v1",
    S("drive.readonly", "drive.file", "documents.readonly", "documents"),
    ["Google 文档", "Google Docs"],
  ],
  [
    "google-slides",
    "https://slidesmcp.googleapis.com/mcp/v1",
    S("drive.readonly", "drive.file", "presentations.readonly", "presentations"),
    ["Google 幻灯片", "Google Slides"],
  ],
  ["bigquery", "https://bigquery.googleapis.com/mcp", S("bigquery"), ["BigQuery", "BigQuery"]],
];

/** The only hosts a template may point at. */
const GOOGLE_HOSTS = new Set([
  "gmailmcp.googleapis.com",
  "drivemcp.googleapis.com",
  "calendarmcp.googleapis.com",
  "sheetsmcp.googleapis.com",
  "docsmcp.googleapis.com",
  "slidesmcp.googleapis.com",
  "bigquery.googleapis.com",
]);

/**
 * Writes named by hand, independent of the fixtures' hints: a fixture recorded with a wrong
 * `readOnlyHint` from Google would otherwise allow a write.
 */
const MUST_ASK: Record<string, string[]> = {
  gmail: [
    "create_draft",
    "label_thread",
    "unlabel_thread",
    "apply_sensitive_thread_label",
    "trash_thread",
    "untrash_thread",
    "mark_thread_spam",
    "unmark_thread_spam",
    "label_message",
    "update_message_labels",
    "unlabel_message",
    "apply_sensitive_message_label",
    "trash_message",
    "untrash_message",
    "mark_message_spam",
    "unmark_message_spam",
    "create_label",
  ],
  "google-drive": ["create_file", "copy_file", "upload_file_revision"],
  "google-calendar": ["create_event", "update_event", "delete_event", "respond_to_event"],
  "google-sheets": ["update_spreadsheet", "update_values", "update_formulas", "insert_dimension"],
  "google-docs": ["update_doc"],
  "google-slides": ["update_presentation"],
  bigquery: ["execute_sql", "cancel_job"],
};

/** Name parts that mean a write in any Google server; such a tool always asks. */
const WRITE_LIKE =
  /(^|_)(create|update|delete|trash|untrash|label|unlabel|spam|send|copy|upload|insert|cancel|respond|move|share|modify|clear|append|batch|apply|remove|execute|write|import|patch)(_|$)/;

/** The kernel's `deriveSlug`: lower case, every run of other characters one `_`. */
const defaultSlug = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^[^a-z]+/, "")
    .slice(0, 24)
    .replace(/_+$/, "");

const load = (id: string) => JSON.parse(read(`connectors/${id}.json`)) as TemplateFile;
const fixture = (id: string) => JSON.parse(read(`test/fixtures/${id}-tools.json`)) as Fixture;

describe.each(TEMPLATES)("connectors/%s.json", (id, endpoint, scopes, [zh, en]) => {
  it("is a valid connector template file whose auth the SDK accepts", () => {
    const file = load(id);
    const parsed = parseConnectorTemplateFile(file);
    expect("errors" in parsed ? parsed.errors : []).toEqual([]);
    expect(validateConnectorTemplate(file.template)).toEqual([]);
    expect(ConnectorAuthSchema.safeParse(file.template.auth).success).toBe(true);
  });

  it("connector-mcp against the fixed Google endpoint, switched off by default", () => {
    const file = load(id);
    expect(file.template).toMatchObject({
      plugin: "connector-mcp",
      connector: "mcp",
      endpoint: { url: endpoint },
    });
    // no other template key (e.g. `git`, which would hand the member's token to sandbox git)
    expect(Object.keys(file).sort()).toEqual([
      "defaultEnabled",
      "description",
      "displayName",
      "icon",
      "template",
    ]);
    expect(Object.keys(file.template).sort()).toEqual([
      "auth",
      "connector",
      "defaultToolPolicies",
      "endpoint",
      "plugin",
      "pluginVersion",
    ]);
    expect(Object.keys(file.template.endpoint)).toEqual(["url"]);
    expect(GOOGLE_HOSTS.has(new URL(endpoint).host)).toBe(true);
    expect(new URL(endpoint).protocol).toBe("https:");
    expect(file.template.editableEndpoint).toBeUndefined();
    expect(file.defaultEnabled).toBe(false);
    expect(file.displayName).toEqual({ zh, en });
    expect(file.icon).toBe(`./icons/${id}.svg`);
    expect(existsSync(new URL(`icons/${id}.svg`, root))).toBe(true);
    expect(fixture(id).endpoint).toBe(endpoint);
  });

  it("the auth preset is exactly per-person OAuth with Google's endpoints and offline access", () => {
    const { auth } = load(id).template;
    expect(auth).toEqual({
      type: "oauth_code",
      ownership: "personal",
      discovery: "manual",
      authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenUrl: "https://oauth2.googleapis.com/token",
      client: "manual",
      tokenAuthMethod: "client_secret_post",
      scopes,
      authorizationParams: { access_type: "offline", prompt: "consent" },
    });
    expect(auth.authorizationUrl).toBe(GOOGLE_ENDPOINTS.authorizationUrl);
    expect(auth.tokenUrl).toBe(GOOGLE_ENDPOINTS.tokenUrl);
    const params = auth.authorizationParams ?? {};
    expect(Object.keys(params).sort()).toEqual(["access_type", "prompt"]);
    const reserved = new Set<string>(OAUTH_RESERVED_AUTHORIZATION_PARAMS);
    for (const k of Object.keys(params)) expect(reserved.has(k), k).toBe(false);
    // incremental authorization would widen every token to the union of the member's grants
    expect(params).not.toHaveProperty("include_granted_scopes");
    for (const s of auth.scopes)
      expect(s).toMatch(/^https:\/\/www\.googleapis\.com\/auth\/[a-z.]+$/);
  });

  it("reads (Google's readOnlyHint) are allowed, every other tool asks, nothing is denied", () => {
    const policies = load(id).template.defaultToolPolicies;
    const tools = fixture(id).tools;
    expect(Object.keys(policies).sort()).toEqual(tools.map((t) => t.name).sort());
    for (const t of tools) expect(policies[t.name], t.name).toBe(t.readOnlyHint ? "allow" : "ask");
    expect(Object.values(policies)).not.toContain("deny");
    for (const t of MUST_ASK[id] ?? []) expect(policies[t], t).toBe("ask");
    // a tool Google adds later with a write-like name never becomes allow through a re-recorded
    // fixture with a wrong hint
    for (const t of Object.keys(policies)) {
      if (WRITE_LIKE.test(t) && t !== "execute_sql_readonly") expect(policies[t], t).toBe("ask");
    }
  });

  it("every recorded tool is callable with the requested scopes", () => {
    const granted = new Set(load(id).template.auth.scopes);
    for (const t of fixture(id).tools) {
      expect(
        t.scopes.some((s) => granted.has(s)),
        t.name,
      ).toBe(true);
    }
  });

  it("every tool name makes a valid tool key (no dots; mcp__<slug>__<name> fits 64)", () => {
    // the kernel derives a template connector's default slug from the English display name
    const slug = defaultSlug(en);
    expect(slug).toMatch(/^[a-z][a-z0-9_]{0,23}$/);
    for (const t of Object.keys(load(id).template.defaultToolPolicies)) {
      expect(t).toMatch(/^[a-z0-9_]+$/);
      expect(`mcp__${slug}__${t}`.length, t).toBeLessThanOrEqual(64);
    }
  });
});

describe("recorded tool counts", () => {
  it("match the live lists of 2026-11-22", () => {
    const counts = Object.fromEntries(TEMPLATES.map(([id]) => [id, fixture(id).tools.length]));
    expect(counts).toEqual({
      gmail: 23,
      "google-drive": 9,
      "google-calendar": 9,
      "google-sheets": 6,
      "google-docs": 2,
      "google-slides": 4,
      bigquery: 9,
    });
  });
});

describe("plugin.json", () => {
  it("lists the seven templates in order and depends on connector-mcp at their range", () => {
    const m = JSON.parse(read(".capybara-plugin/plugin.json"));
    const parsed = parsePluginManifest(m);
    expect("errors" in parsed ? parsed.errors : []).toEqual([]);
    expect(m.connectorTemplates).toEqual(
      TEMPLATES.map(([id]) => ({ path: `./connectors/${id}.json` })),
    );
    const versions = new Set(TEMPLATES.map(([id]) => load(id).template.pluginVersion));
    expect(versions.size).toBe(1);
    const [version] = [...versions];
    expect(version).toMatch(/^\^0\.1\.0-rc\.\d+$/);
    expect(m.dependencies).toEqual([{ name: "connector-mcp", version }]);
  });
});
