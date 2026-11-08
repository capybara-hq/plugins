import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { afterAll, describe, expect, it } from "vitest";

/**
 * The plugin through the published toolchain (`capybara-plugin` from the workspace root, where
 * vitest runs): `check` is clean and `pack` ships the theme, its fonts, the logo and the font
 * licenses.
 */
const pluginDir = fileURLToPath(new URL("../", import.meta.url));
const out = mkdtempSync(join(tmpdir(), "theme-cyberpunk-pack-"));
afterAll(() => rmSync(out, { recursive: true, force: true }));

const cli = (...args: string[]) =>
  execFileSync("pnpm", ["exec", "capybara-plugin", ...args], { encoding: "utf8" });

/** The file names in a gzipped tar (ustar headers; enough for npm-pack tarballs). */
function tarEntries(tgz: Buffer): string[] {
  const tar = gunzipSync(tgz);
  const names: string[] = [];
  for (let at = 0; at + 512 <= tar.length; ) {
    const header = tar.subarray(at, at + 512);
    if (header.every((b) => b === 0)) break;
    const field = (from: number, len: number) =>
      header
        .subarray(from, from + len)
        .toString("utf8")
        .replace(/\0.*$/s, "");
    const prefix = field(345, 155);
    const name = field(0, 100);
    names.push(prefix === "" ? name : `${prefix}/${name}`);
    const size = Number.parseInt(field(124, 12).trim() || "0", 8);
    at += 512 + Math.ceil(size / 512) * 512;
  }
  return names;
}

describe("theme-cyberpunk package", () => {
  it("passes capybara-plugin check", () => {
    const report = cli("check", "--plugins", "plugins/theme-cyberpunk");
    expect(report).toContain("[Themes] passed");
    expect(report).toContain("All plugin checks passed");
    expect(report).not.toMatch(/warning/);
  }, 60_000);

  it("packs the theme, fonts, logo, favicon and font licenses", () => {
    cli("pack", pluginDir, "--out", out);
    const tgzs = readdirSync(out).filter((f) => f.endsWith(".tgz"));
    expect(tgzs).toEqual([expect.stringMatching(/^capybara-hq-plugin-theme-cyberpunk-.*\.tgz$/)]);
    const entries = tarEntries(readFileSync(join(out, tgzs[0] ?? "")));
    expect(entries).toEqual(
      expect.arrayContaining([
        "package/.capybara-plugin/plugin.json",
        "package/themes/cyberpunk.json",
        "package/logo.svg",
        "package/favicon.svg",
        "package/fonts/JetBrainsMono-400.woff2",
        "package/fonts/JetBrainsMono-500.woff2",
        "package/fonts/JetBrainsMono-600.woff2",
        "package/fonts/JetBrainsMono-700.woff2",
        "package/fonts/ChakraPetch-400.woff2",
        "package/fonts/ChakraPetch-600.woff2",
        "package/fonts/ChakraPetch-700.woff2",
        "package/OFL-JetBrainsMono.txt",
        "package/OFL-ChakraPetch.txt",
        "package/README.md",
        "package/LICENSE",
      ]),
    );
    // declarative: no extension bundle
    expect(entries.some((e) => e.startsWith("package/dist/"))).toBe(false);
  }, 60_000);
});
