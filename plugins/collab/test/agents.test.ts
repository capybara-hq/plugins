import { existsSync, readFileSync } from "node:fs";
import {
  BUILTIN_TOOL_NAME_RE,
  extensionToolKey,
  parseAgentTemplate,
  parsePluginManifest,
  parseSkillMd,
} from "@capybara-hq/plugin-sdk";
import { describe, expect, it } from "vitest";
import { TOOL_KEYS } from "../src/constants.js";

const root = new URL("../", import.meta.url);
const read = (rel: string) => readFileSync(new URL(rel, root), "utf8");

const COLLAB_KEYS = new Set<string>(TOOL_KEYS.map((t) => extensionToolKey("collab", t)));
const SANDBOX = ["Bash", "Read", "Write", "Edit", "Glob", "Grep"];

const EXPECTED = {
  product: { model: "capable", skills: ["collab-workflow", "prd-writing"], sandbox: false },
  engineer: { model: "capable", skills: ["collab-workflow"], sandbox: true },
  qa: { model: "standard", skills: ["collab-workflow", "test-planning"], sandbox: true },
} as const;

function manifest() {
  const parsed = parsePluginManifest(JSON.parse(read(".capybara-plugin/plugin.json")));
  if ("errors" in parsed) throw new Error(parsed.errors.join("\n"));
  return parsed;
}

function skills() {
  return (manifest().skills ?? []).map((ref) => {
    const parsed = parseSkillMd(read(`${ref.path}/SKILL.md`));
    if ("errors" in parsed) throw new Error(`${ref.path}: ${parsed.errors.join("; ")}`);
    return { path: ref.path, ...parsed };
  });
}

function template(name: string) {
  const parsed = parseAgentTemplate(read(`agents/${name}.md`));
  if ("errors" in parsed) throw new Error(`${name}: ${parsed.errors.join("; ")}`);
  return parsed.template;
}

describe("collab agent templates and skills", () => {
  it("plugin.json lists the three templates and three skills, and the files exist", () => {
    const m = manifest();
    expect(m.agents?.map((a) => a.path).sort()).toEqual([
      "./agents/engineer.md",
      "./agents/product.md",
      "./agents/qa.md",
    ]);
    expect(m.skills?.map((s) => s.path).sort()).toEqual([
      "./skills/collab-workflow",
      "./skills/prd-writing",
      "./skills/test-planning",
    ]);
    for (const ref of [...(m.agents ?? []), ...(m.skills ?? [])]) {
      expect(existsSync(new URL(ref.path, root))).toBe(true);
    }
  });

  it("every skill passes the SDK frontmatter checks and its name matches its folder", () => {
    for (const s of skills()) {
      expect(s.path.endsWith(`/${s.name}`)).toBe(true);
      expect(s.description.length).toBeGreaterThan(40);
      expect(s.description.startsWith("Use when")).toBe(true);
      expect(s.body.trim().length).toBeGreaterThan(200);
    }
  });

  for (const [name, want] of Object.entries(EXPECTED)) {
    it(`${name} parses with its tier, skills and tools`, () => {
      const t = template(name);
      expect(t.name).toBe(name);
      expect(t.model).toBe(want.model);
      expect(t.skills).toEqual([...want.skills]);
      const names = new Set(skills().map((s) => s.name));
      for (const s of t.skills ?? []) expect(names.has(s)).toBe(true);

      const tools = t.tools ?? [];
      for (const key of COLLAB_KEYS) expect(tools).toContain(key);
      for (const key of tools) {
        // every key is a builtin or one of this plugin's registered tools
        expect(COLLAB_KEYS.has(key) || BUILTIN_TOOL_NAME_RE.test(key)).toBe(true);
      }
      for (const key of SANDBOX) expect(tools.includes(key)).toBe(want.sandbox);
      expect(t.instructions.trim().length).toBeGreaterThan(200);
    });
  }

  it("collab-workflow states the mechanism: events, item_get, records, decisions, gates, handoff", () => {
    const body = skills().find((s) => s.name === "collab-workflow")?.body ?? "";
    for (const word of [
      "item_get",
      "item_comment",
      "artifact_attach",
      "decision_ask",
      "recommendation",
      "item_transition",
      "gate",
      "no longer assigned",
      "decision_list",
    ]) {
      expect(body).toContain(word);
    }
  });

  it("model-facing text names only tools that exist", () => {
    const texts = [
      ...skills().map((s) => s.body),
      ...Object.keys(EXPECTED).map((n) => template(n).instructions),
    ].join("\n");
    const mentioned = new Set(texts.match(/\b(?:project|item|artifact|decision)_[a-z]+\b/g) ?? []);
    for (const tool of mentioned) expect(TOOL_KEYS as readonly string[]).toContain(tool);
  });
});
