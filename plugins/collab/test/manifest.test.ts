import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import extension from "../src/index.js";

const read = (rel: string) => JSON.parse(readFileSync(new URL(rel, import.meta.url), "utf8"));

// The kernel validates the whole manifest when it loads the extension (migration.test.ts runs a
// real kernel with it); this test pins the parts the plugin's own checks rely on.
describe("collab manifest", () => {
  it("has the same version in package.json, plugin.json and the extension", () => {
    const pkg = read("../package.json");
    const plugin = read("../.capybara-plugin/plugin.json");
    expect(plugin.version).toBe(pkg.version);
    expect(extension.version).toBe(pkg.version);
    expect(plugin.name).toBe(extension.name);
  });

  it("declares 14 tool keys and event types of valid shape", () => {
    const perms = extension.permissions;
    expect(perms?.tools).toHaveLength(14);
    for (const key of perms?.tools ?? []) expect(key.length).toBeLessThanOrEqual(64);
    for (const type of perms?.triggers?.emit ?? []) {
      expect(type).toMatch(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/);
      expect(type.length).toBeLessThanOrEqual(64);
    }
  });

  it("lists every ui component in permissions.ui.components", () => {
    const ids = (extension.ui ?? []).filter((u) => u.kind === "component").map((u) => u.id);
    expect([...(extension.permissions?.ui?.components ?? [])].sort()).toEqual([...ids].sort());
  });
});
