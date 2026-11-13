import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import {
  ACCENT_DARK,
  ACCENT_LIGHT,
  GLYPH_KEYS,
  GLYPH_PATHS,
  ICON_VIEWBOX,
  LOGO_PATH,
} from "@capybara-hq/icons/bitmaps";
import type { Finding } from "./finding.js";

/**
 * Brand plugins keep their own mark, so the composed-icon rule does not apply to them. Each is
 * exempt by name with its reason; a new brand plugin must be added here deliberately.
 */
export const BRAND_ICON_EXEMPTIONS: Readonly<Record<string, string>> = {
  anthropic: "vendor brand: the Anthropic press-kit symbol",
  ark: "vendor-specific provider (Volcengine Ark): keeps its own provider mark",
  bailian: "vendor-specific provider (Alibaba Cloud Model Studio): keeps its own provider mark",
  deepseek: "vendor brand: the DeepSeek whale",
  github: "vendor brand: the GitHub mark",
  jina: "vendor brand: the Jina logo",
  lark: "vendor brand: the Lark mark",
  openai: "vendor brand: the OpenAI knot",
  slack: "vendor brand: the Slack mark",
  telegram: "vendor brand: the Telegram paper plane",
};

/** Private reference plugins, never published: not part of the icon rule at all. */
export const PRIVATE_ICON_PLUGINS: readonly string[] = ["example-board", "example-counter"];

/** The composed icon a functional published plugin must reference from its plugin.json. */
export const COMPOSED_ICON = "./icon.svg";

function lineOf(text: string, pattern: RegExp): number {
  const index = text.split(/\r?\n/).findIndex((line) => pattern.test(line));
  return index === -1 ? 1 : index + 1;
}

function hasPathData(svg: string, d: string): boolean {
  return svg.includes(`d="${d}"`) || svg.includes(`d='${d}'`);
}

function checkComposedIcon(file: string): Finding[] {
  const svg = readFileSync(file, "utf8");
  const findings: Finding[] = [];
  const at = (rule: string, message: string): void => {
    findings.push({ file, line: 1, rule, message });
  };

  if (!/<svg[\s>]/.test(svg) || !/xmlns\s*=\s*["']http:\/\/www\.w3\.org\/2000\/svg["']/.test(svg)) {
    at(
      "plugin-icon-standalone",
      'the icon must be a standalone SVG: start with <svg xmlns="http://www.w3.org/2000/svg">.',
    );
  }
  if (!/viewBox\s*=\s*["']0 0 24 24["']/.test(svg)) {
    at("plugin-icon-viewbox", `the composed icon uses viewBox="${ICON_VIEWBOX}".`);
  }
  if (!/shape-rendering\s*=\s*["']crispEdges["']/.test(svg)) {
    at("plugin-icon-shape-rendering", 'the composed icon sets shape-rendering="crispEdges".');
  }
  if (!hasPathData(svg, LOGO_PATH)) {
    at(
      "plugin-icon-logo",
      "the pixel capybara logo path is missing: regenerate the icon with `pnpm icons:generate`.",
    );
  }
  const glyphs = GLYPH_KEYS.filter((key) => hasPathData(svg, GLYPH_PATHS[key]));
  if (glyphs.length !== 1) {
    at(
      "plugin-icon-glyph",
      glyphs.length === 0
        ? `no function glyph is present; use exactly one of: ${GLYPH_KEYS.join(", ")}.`
        : `more than one function glyph is present (${glyphs.join(", ")}); use exactly one.`,
    );
  }
  if (!svg.includes(ACCENT_LIGHT) || !svg.includes(ACCENT_DARK)) {
    at(
      "plugin-icon-color",
      `use the accent only: ${ACCENT_LIGHT} in the light theme and ${ACCENT_DARK} in the dark theme.`,
    );
  }
  if (!/@media\s*\(\s*prefers-color-scheme\s*:\s*dark\s*\)/.test(svg)) {
    at(
      "plugin-icon-dark-mode",
      "the dark theme is missing: add @media (prefers-color-scheme: dark) to the SVG's <style>.",
    );
  }
  if (!/<title>[^<]+<\/title>/.test(svg)) {
    at("plugin-icon-title", "the icon needs a <title> carrying the plugin name.");
  }
  return findings;
}

/**
 * The composed-icon rule for the official plugins.
 *
 * - every published plugin (brand or functional) must reference an existing icon file from its
 *   plugin.json (`"icon": "./icon.svg"`);
 * - a functional plugin must reference `./icon.svg` and that file must be the composed form: a 24x24
 *   standalone SVG with `shape-rendering="crispEdges"`, the capybara logo bitmap path, exactly one
 *   of the seven function glyph paths, both accent colours and the dark-mode media query;
 * - brand plugins (the explicit list above, each with its reason) are exempt from the composed form;
 * - the private example plugins are not checked.
 */
export function checkPluginIcons(root: string): Finding[] {
  const pluginsDir = join(root, "plugins");
  if (!existsSync(pluginsDir)) return [];
  const findings: Finding[] = [];

  for (const entry of readdirSync(pluginsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const plugin = entry.name;
    if (PRIVATE_ICON_PLUGINS.includes(plugin)) continue;
    const dir = join(pluginsDir, plugin);
    const manifestFile = join(dir, ".capybara-plugin/plugin.json");
    if (!existsSync(manifestFile)) continue;

    const manifestText = readFileSync(manifestFile, "utf8");
    let manifest: { icon?: unknown };
    try {
      manifest = JSON.parse(manifestText) as { icon?: unknown };
    } catch {
      findings.push({
        file: manifestFile,
        line: 1,
        rule: "plugin-icon-manifest",
        message: "plugin.json is not valid JSON, so its icon reference cannot be checked.",
      });
      continue;
    }

    const iconLine = lineOf(manifestText, /"icon"\s*:/);
    const icon = manifest.icon;
    if (typeof icon !== "string" || icon.trim() === "") {
      findings.push({
        file: manifestFile,
        line: iconLine,
        rule: "plugin-icon-reference",
        message: `plugin.json must reference its icon: add "icon": "${COMPOSED_ICON}".`,
      });
      continue;
    }

    const target = resolve(dir, icon);
    const rel = relative(dir, target);
    if (rel.startsWith("..") || !existsSync(target)) {
      findings.push({
        file: manifestFile,
        line: iconLine,
        rule: "plugin-icon-file",
        message: `plugin.json icon ${icon} does not resolve to a file inside the plugin.`,
      });
      continue;
    }

    if (BRAND_ICON_EXEMPTIONS[plugin] !== undefined) continue;

    if (icon !== COMPOSED_ICON) {
      findings.push({
        file: manifestFile,
        line: iconLine,
        rule: "plugin-icon-reference",
        message: `functional plugins use the composed icon; point "icon" at ${COMPOSED_ICON} (found ${icon}).`,
      });
      continue;
    }

    findings.push(...checkComposedIcon(target));
  }

  return findings;
}
