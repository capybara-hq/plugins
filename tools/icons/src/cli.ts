/**
 * `pnpm icons:generate`: writes the composed `icon.svg` of the functional official plugins.
 *
 * - `pnpm icons:generate` regenerates every plugin in `PLUGIN_GLYPHS`;
 * - `pnpm icons:generate <plugin> <glyph>` writes one plugin (glyph: memory, storage, connector,
 *   todo, model, skills, channel).
 *
 * The title is kept from the existing icon.svg; a plugin without one uses its English display name.
 * A brand plugin's icon is never touched: it is not in `PLUGIN_GLYPHS`.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { GLYPH_KEYS, type GlyphKey } from "./bitmaps.js";
import { buildIconSvg } from "./compose.js";
import { PLUGIN_GLYPHS } from "./plugins.js";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const USAGE =
  "usage: pnpm icons:generate [<plugin> <glyph>]\n" +
  `  glyphs: ${GLYPH_KEYS.join(", ")}\n` +
  "  without arguments: regenerate every plugin in PLUGIN_GLYPHS";

function isGlyph(value: string): value is GlyphKey {
  return (GLYPH_KEYS as readonly string[]).includes(value);
}

function titleOf(plugin: string, iconFile: string, manifest: Record<string, unknown>): string {
  if (existsSync(iconFile)) {
    const match = /<title>([^<]+)<\/title>/.exec(readFileSync(iconFile, "utf8"));
    if (match?.[1]) return match[1];
  }
  const display = manifest.displayName as { en?: unknown } | undefined;
  if (typeof display?.en === "string" && display.en !== "") return display.en;
  return plugin;
}

function generate(plugin: string, glyph: GlyphKey): string {
  const dir = join(root, "plugins", plugin);
  const manifestFile = join(dir, ".capybara-plugin/plugin.json");
  if (!existsSync(manifestFile)) {
    throw new Error(`no plugin at plugins/${plugin} (missing .capybara-plugin/plugin.json)`);
  }
  const manifest = JSON.parse(readFileSync(manifestFile, "utf8")) as Record<string, unknown>;
  const iconFile = join(dir, "icon.svg");
  const svg = buildIconSvg({ title: titleOf(plugin, iconFile, manifest), glyph });
  writeFileSync(iconFile, svg);
  return `plugins/${plugin}/icon.svg  ${glyph}`;
}

function main(argv: string[]): number {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(USAGE);
    return 0;
  }
  if (argv.length === 0) {
    for (const [plugin, glyph] of Object.entries(PLUGIN_GLYPHS)) {
      console.log(generate(plugin, glyph));
    }
    return 0;
  }
  if (argv.length !== 2) {
    console.error(USAGE);
    return 2;
  }
  const [plugin, glyph] = argv as [string, string];
  if (!isGlyph(glyph)) {
    console.error(`unknown glyph \`${glyph}\`\n${USAGE}`);
    return 2;
  }
  console.log(generate(plugin, glyph));
  return 0;
}

process.exitCode = main(process.argv.slice(2));
