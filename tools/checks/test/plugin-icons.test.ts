import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GLYPH_PATHS, LOGO_PATH } from "@capybara-hq/icons/bitmaps";
import { buildIconSvg } from "@capybara-hq/icons/compose";
import { afterEach, describe, expect, it } from "vitest";
import { checkPluginIcons } from "../src/plugin-icons.js";

const roots: string[] = [];

afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A throwaway repository root with `plugins/<name>/{.capybara-plugin/plugin.json,icon.svg}` files. */
function repo(
  plugins: Record<string, { icon?: string; iconField?: string; files?: Record<string, string> }>,
): string {
  const root = mkdtempSync(join(tmpdir(), "plugin-icons-"));
  roots.push(root);
  for (const [name, plugin] of Object.entries(plugins)) {
    const dir = join(root, "plugins", name);
    mkdirSync(join(dir, ".capybara-plugin"), { recursive: true });
    const manifest: Record<string, string> = { name };
    const iconField = plugin.iconField === undefined ? "./icon.svg" : plugin.iconField;
    if (iconField !== "") manifest.icon = iconField;
    writeFileSync(join(dir, ".capybara-plugin/plugin.json"), JSON.stringify(manifest, null, 2));
    if (plugin.icon !== undefined) writeFileSync(join(dir, "icon.svg"), plugin.icon);
    for (const [file, content] of Object.entries(plugin.files ?? {})) {
      writeFileSync(join(dir, file), content);
    }
  }
  return root;
}

const composed = (name: string): string => buildIconSvg({ title: name, glyph: "memory" });

describe("checkPluginIcons", () => {
  it("accepts a composed icon and its plugin.json reference", () => {
    const root = repo({ memory: { icon: composed("Memory") } });
    expect(checkPluginIcons(root)).toEqual([]);
  });

  it("fails a functional plugin whose icon is the old line drawing", () => {
    const old =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" ' +
      'stroke="#3D3D3A" stroke-width="1.75"><title>Memory</title><circle cx="12" cy="5" r="2"/></svg>\n';
    const root = repo({ memory: { icon: old } });
    const rules = checkPluginIcons(root).map((f) => f.rule);
    expect(rules).toContain("plugin-icon-logo");
    expect(rules).toContain("plugin-icon-glyph");
    expect(rules).toContain("plugin-icon-color");
    expect(rules).toContain("plugin-icon-dark-mode");
  });

  it("fails a functional plugin that points at another icon file", () => {
    const root = repo({
      memory: {
        icon: composed("Memory"),
        iconField: "./favicon.svg",
        files: { "favicon.svg": '<svg xmlns="http://www.w3.org/2000/svg"/>' },
      },
    });
    expect(checkPluginIcons(root).map((f) => f.rule)).toEqual(["plugin-icon-reference"]);
  });

  it("fails a published plugin without an icon reference", () => {
    const root = repo({ memory: { iconField: "" } });
    expect(checkPluginIcons(root).map((f) => f.rule)).toEqual(["plugin-icon-reference"]);
  });

  it("fails a plugin whose icon field points outside the plugin", () => {
    const root = repo({ memory: { icon: composed("Memory"), iconField: "../../escape.svg" } });
    expect(checkPluginIcons(root).map((f) => f.rule)).toEqual(["plugin-icon-file"]);
  });

  it("fails a functional plugin with two function glyphs", () => {
    const two = composed("Memory").replace(
      "</svg>",
      `<path fill="#CC4609" d="${GLYPH_PATHS.todo}"/></svg>`,
    );
    const root = repo({ memory: { icon: two } });
    expect(checkPluginIcons(root).map((f) => f.rule)).toEqual(["plugin-icon-glyph"]);
  });

  it("fails an icon without the dark-mode media query", () => {
    const lightOnly = composed("Memory").replace(
      "@media (prefers-color-scheme: dark){path{fill:#FF6A13}}",
      "",
    );
    const root = repo({ memory: { icon: lightOnly } });
    const rules = checkPluginIcons(root).map((f) => f.rule);
    expect(rules).toContain("plugin-icon-dark-mode");
    expect(rules).toContain("plugin-icon-color");
  });

  it("fails a brand plugin's icon reference when the file is missing, but not its own mark", () => {
    const missing = repo({ anthropic: { iconField: "./icon.svg" } });
    expect(checkPluginIcons(missing).map((f) => f.rule)).toEqual(["plugin-icon-file"]);

    const brand = repo({ anthropic: { icon: '<svg xmlns="http://www.w3.org/2000/svg"/>' } });
    expect(checkPluginIcons(brand)).toEqual([]);
  });

  it("does not check the private example plugins", () => {
    const root = repo({
      "example-board": { icon: composed("example-board"), iconField: "./favicon.svg" },
    });
    expect(checkPluginIcons(root)).toEqual([]);
  });

  it("reports the missing logo path with the generator command", () => {
    const noLogo = composed("Memory").replace(`d="${LOGO_PATH}"`, 'd=""');
    const root = repo({ memory: { icon: noLogo } });
    const finding = checkPluginIcons(root).find((f) => f.rule === "plugin-icon-logo");
    expect(finding?.message).toContain("pnpm icons:generate");
  });
});
