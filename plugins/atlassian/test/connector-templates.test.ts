import { existsSync, readFileSync, statSync } from "node:fs";
import {
  ConnectorAuthSchema,
  parseConnectorTemplateFile,
  parsePluginManifest,
  validateConnectorTemplate,
} from "@capybara-hq/plugin-sdk";
import { describe, expect, it } from "vitest";

/**
 * The three Atlassian connector templates `connectors/<id>.json`: per-person OAuth with MCP
 * discovery and dynamic client registration, on connector-mcp against Atlassian's remote MCP
 * server with the flat tool list (`?tools=all`). The policies come from the tool groups recorded
 * from Atlassian's supported-tools page in `test/fixtures/<id>-tools.json`.
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
    auth: Record<string, unknown> & { scopes: string[] };
    defaultToolPolicies: Record<string, Policy>;
  };
}
interface Fixture {
  source: string;
  recordedAt: string;
  common: string[];
  groups: Record<string, { scope: string; tools: string[] }>;
}

const ENDPOINT = "https://mcp.atlassian.com/v2/mcp?tools=all";
/** Identity and refresh scopes every template requests besides its product's. */
const IDENTITY = ["read:me", "read:account", "offline_access"];

/** [template id, display name, product scopes, permission groups, on by default]. */
const TEMPLATES: [string, string, string[], string[], boolean][] = [
  [
    "jira",
    "Jira",
    ["read:jira:agent-interface", "write:jira:agent-interface", "search:jira:agent-interface"],
    ["read_jira", "search_jira", "write_jira"],
    true,
  ],
  [
    "confluence",
    "Confluence",
    [
      "read:confluence:agent-interface",
      "write:confluence:agent-interface",
      "search:confluence:agent-interface",
    ],
    ["read_confluence", "search_confluence", "write_confluence"],
    true,
  ],
  [
    "bitbucket",
    "Bitbucket",
    ["read:bitbucket:agent-interface", "write:bitbucket:agent-interface"],
    ["read_bitbucket", "write_bitbucket"],
    false,
  ],
];

/** The tools outside any permission group, with their policies. */
const COMMON: Record<string, Policy> = {
  atlassianUserInfo: "allow",
  getAccessibleAtlassianResources: "allow",
  getContentFormatGuide: "allow",
  discover: "allow",
  executeRead: "allow",
  executeWrite: "ask",
  executeDestructive: "ask",
};

/**
 * Writes with a wider reach, named by hand: a re-recorded fixture that moved one of them into a
 * read group would otherwise allow it.
 */
const MUST_ASK: Record<string, string[]> = {
  jira: ["createJiraIssue", "editJiraIssue", "transitionJiraIssue", "addOrEditJiraIssueComment"],
  confluence: [
    "createConfluenceContent",
    "updateConfluenceContent",
    "moveConfluenceContent",
    "archiveConfluenceContent",
    "addConfluenceContentPermissions",
    "removeConfluenceContentPermissions",
    "replaceConfluenceContentPermissions",
    "setConfluenceContentRestrictionState",
    "enableConfluencePublicLink",
    "createConfluenceSpace",
  ],
  bitbucket: [
    "createBitbucketRepoPullRequest",
    "mergeBitbucketRepoPullRequest",
    "approveBitbucketRepoPullRequest",
    "createBitbucketRepoCommit",
    "createBitbucketRepoBranch",
    "runBitbucketRepoPipeline",
  ],
};

/** Name prefixes that mean a write; such a tool never becomes allow. */
const WRITE_LIKE =
  /^(create|update|edit|delete|add|addOrEdit|remove|replace|set|enable|disable|archive|unarchive|move|copy|restore|convert|transition|manage|watch|unwatch|star|unstar|upload|complete|reopen|resolve|merge|approve|request|run|execute(Write|Destructive))/;

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

describe.each(TEMPLATES)("connectors/%s.json", (id, name, scopes, groups, on) => {
  it("is a valid connector template file whose auth the SDK accepts", () => {
    const file = load(id);
    const parsed = parseConnectorTemplateFile(file);
    expect("errors" in parsed ? parsed.errors : []).toEqual([]);
    expect(validateConnectorTemplate(file.template)).toEqual([]);
    expect(ConnectorAuthSchema.safeParse(file.template.auth).success).toBe(true);
  });

  it("connector-mcp against Atlassian's flat tool list, fixed for every org", () => {
    const file = load(id);
    expect(file.template).toMatchObject({
      plugin: "connector-mcp",
      connector: "mcp",
      endpoint: { url: ENDPOINT },
    });
    expect(Object.keys(file.template.endpoint)).toEqual(["url"]);
    expect(file.template.editableEndpoint).toBeUndefined();
    const u = new URL(ENDPOINT);
    expect(u.protocol).toBe("https:");
    expect(u.host).toBe("mcp.atlassian.com");
    // the query asks for the flat list and carries nothing credential-like
    expect([...u.searchParams.entries()]).toEqual([["tools", "all"]]);
    expect(file.displayName).toEqual({ zh: name, en: name });
    expect(file.defaultEnabled).toBe(on ? undefined : false);
  });

  it("ships its own product icon (svg, at most 64 KiB)", () => {
    const file = load(id);
    expect(file.icon).toBe(`./icons/${id}.svg`);
    const url = new URL(`icons/${id}.svg`, root);
    expect(existsSync(url)).toBe(true);
    expect(statSync(url).size).toBeLessThanOrEqual(64 * 1024);
    expect(read(`icons/${id}.svg`)).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  });

  it("the auth preset is per-person OAuth with MCP discovery, DCR and only its product's scopes", () => {
    const { auth } = load(id).template;
    expect(auth).toEqual({
      type: "oauth_code",
      ownership: "personal",
      discovery: "mcp",
      client: "dcr",
      scopes: [...scopes, ...IDENTITY],
    });
    // never the admin-gated delete / manage scopes, never another product's
    for (const s of auth.scopes) expect(s).not.toMatch(/^(delete|manage):/);
    const product = id === "jira" ? ":jira:" : `:${id}:`;
    for (const s of auth.scopes.filter((x) => x.includes(":agent-interface")))
      expect(s).toContain(product);
    // the recorded groups need exactly these scopes
    expect(groups.map((g) => fixture(id).groups[g]?.scope).sort()).toEqual([...scopes].sort());
  });

  it("reads and searches are allowed, every write asks, nothing is denied", () => {
    const policies = load(id).template.defaultToolPolicies;
    const fx = fixture(id);
    expect(Object.keys(fx.groups).sort()).toEqual([...groups].sort());
    const expected: Record<string, Policy> = { ...COMMON };
    for (const [g, { tools }] of Object.entries(fx.groups)) {
      for (const t of tools) expected[t] = g.startsWith("write_") ? "ask" : "allow";
    }
    expect(fx.common.sort()).toEqual(Object.keys(COMMON).sort());
    expect(policies).toEqual(expected);
    expect(Object.values(policies)).not.toContain("deny");
    for (const t of MUST_ASK[id] ?? []) expect(policies[t], t).toBe("ask");
    for (const [t, p] of Object.entries(policies)) {
      // resolveConfluenceContentMacros only renders macros to HTML
      if (WRITE_LIKE.test(t) && t !== "resolveConfluenceContentMacros") expect(p, t).toBe("ask");
    }
  });

  it("lists no tool of another product", () => {
    const others = ["Jira", "Confluence", "Bitbucket"].filter((p) => p !== name);
    for (const t of Object.keys(load(id).template.defaultToolPolicies)) {
      for (const o of others) expect(t, t).not.toContain(o);
    }
  });

  it("every tool name makes a valid tool key (no dots; mcp__<slug>__<name> fits 64)", () => {
    const slug = defaultSlug(name);
    expect(slug).toBe(id);
    for (const t of Object.keys(load(id).template.defaultToolPolicies)) {
      expect(t).toMatch(/^[A-Za-z0-9_]+$/);
      expect(`mcp__${slug}__${t}`.length, t).toBeLessThanOrEqual(64);
    }
  });
});

describe("recorded tool counts", () => {
  it("match Atlassian's supported-tools page of 2026-11-23", () => {
    const counts = Object.fromEntries(
      TEMPLATES.map(([id]) => [
        id,
        Object.fromEntries(
          Object.entries(fixture(id).groups).map(([g, { tools }]) => [g, tools.length]),
        ),
      ]),
    );
    expect(counts).toEqual({
      jira: { read_jira: 27, search_jira: 1, write_jira: 15 },
      confluence: { read_confluence: 26, search_confluence: 1, write_confluence: 41 },
      bitbucket: { read_bitbucket: 25, write_bitbucket: 13 },
    });
    for (const [id] of TEMPLATES) expect(fixture(id).recordedAt).toBe("2026-11-23");
  });
});

describe("plugin.json", () => {
  it("lists the three templates in order and depends on connector-mcp at their range", () => {
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
    expect(m.icon).toBe("./icon.svg");
    expect(statSync(new URL("icon.svg", root)).size).toBeLessThanOrEqual(64 * 1024);
  });
});
