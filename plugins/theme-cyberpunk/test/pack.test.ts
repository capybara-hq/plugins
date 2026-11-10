import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { CLIENT_API_VERSION, parsePluginManifest } from "@capybara-hq/plugin-sdk";
import { afterAll, describe, expect, it } from "vitest";

/**
 * The plugin through the published toolchain (`capybara-plugin` from the workspace root, where
 * vitest runs): `check` is clean (no warning either, so no client-css-selector or ui-part-unknown)
 * and `pack` ships the theme, its fonts, the logo, the font licenses and the client build.
 */
const pluginDir = fileURLToPath(new URL("../", import.meta.url));
const out = mkdtempSync(join(tmpdir(), "theme-cyberpunk-pack-"));
afterAll(() => rmSync(out, { recursive: true, force: true }));

const cli = (...args: string[]) =>
  execFileSync("pnpm", ["exec", "capybara-plugin", ...args], { encoding: "utf8" });

/** stdout and stderr of a command (check prints its warnings on stderr). */
const cliAll = (...args: string[]) => {
  const r = spawnSync("pnpm", ["exec", "capybara-plugin", ...args], { encoding: "utf8" });
  return `${r.stdout}${r.stderr}`;
};

/** The files of a gzipped tar by name (ustar headers; enough for npm-pack tarballs). */
function tarFiles(tgz: Buffer): Map<string, Buffer> {
  const tar = gunzipSync(tgz);
  const files = new Map<string, Buffer>();
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
    const size = Number.parseInt(field(124, 12).trim() || "0", 8);
    files.set(prefix === "" ? name : `${prefix}/${name}`, tar.subarray(at + 512, at + 512 + size));
    at += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}

describe("theme-cyberpunk package", () => {
  it("passes capybara-plugin check", () => {
    const report = cliAll("check", "--plugins", "plugins/theme-cyberpunk");
    expect(report).toContain("[Themes] passed");
    expect(report).toContain("All plugin checks passed");
    // check prints its findings, warnings included, on stderr: none at all
    expect(report.split("\n").filter((l) => /^\s+\S+:\d+ \S+ /.test(l))).toEqual([]);
    expect(report).not.toMatch(/warning/);
  }, 60_000);

  it("packs the theme, fonts, logo, favicon, font licenses and the client build", () => {
    cli("pack", pluginDir, "--out", out);
    const tgzs = readdirSync(out).filter((f) => f.endsWith(".tgz"));
    expect(tgzs).toEqual([expect.stringMatching(/^capybara-hq-plugin-theme-cyberpunk-.*\.tgz$/)]);
    const files = tarFiles(readFileSync(join(out, tgzs[0] ?? "")));
    const entries = [...files.keys()];
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
    // the extension and its client build (entry and the wrapped stylesheet), no other dist files
    expect(entries.filter((e) => e.startsWith("package/dist/")).sort()).toEqual([
      "package/dist/client/client.mjs",
      "package/dist/client/styles/cyberpunk.css",
      "package/dist/index.mjs",
    ]);

    // the packed manifest parses: the theme, the client section pack wrote and the suggestion
    const parsed = parsePluginManifest(
      JSON.parse(files.get("package/.capybara-plugin/plugin.json")?.toString("utf8") ?? "{}"),
    );
    if ("errors" in parsed) throw new Error(parsed.errors.join("\n"));
    expect(parsed.themes).toEqual([{ path: "./themes/cyberpunk.json" }]);
    expect(parsed.suggestedAppearance).toEqual({
      theme: "cyberpunk",
      replacements: { "shell.brand": "brand", "conversation.empty": "hero" },
    });
    const client = parsed.extension?.client;
    expect(client?.entry).toBe("./dist/client/client.mjs");
    expect(client?.styles).toEqual(["./dist/client/styles/cyberpunk.css"]);
    expect(client?.apiVersion).toBe(CLIENT_API_VERSION);
    expect(parsed.extension?.manifest.permissions?.client).toBe(true);
    // the stylesheet is stored wrapped in the extensions layer
    expect(files.get("package/dist/client/styles/cyberpunk.css")?.toString("utf8")).toMatch(
      /^@layer extensions \{/,
    );
  }, 60_000);
});
