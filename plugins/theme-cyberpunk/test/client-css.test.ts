import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** Properties of the decoration stylesheet that jsdom cannot render (no layout, no clip-path). */
const css = readFileSync(new URL("../client/styles/cyberpunk.css", import.meta.url), "utf8");
const THEME = '[data-cap-state~="theme=theme-cyberpunk/cyberpunk"]';

/** The selector lists of the rules whose declarations contain `declaration`. */
function selectorsWith(declaration: string): string[] {
  const out: string[] = [];
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if ((m[2] ?? "").includes(declaration)) out.push((m[1] ?? "").replace(/\s+/g, " ").trim());
  }
  return out;
}

describe("cyberpunk.css", () => {
  it("never clips a focus ring: cards, sections and buttons drop the chamfer while focused", () => {
    const unclipped = selectorsWith("clip-path: none").join(",");
    expect(unclipped).toContain(`${THEME} [data-cap-part~="card"]:has(:focus-visible)`);
    expect(unclipped).toContain(`${THEME} [data-cap-part~="section"]:has(:focus-visible)`);
    expect(unclipped).toContain(`${THEME} [data-cap-part~="button"]:focus-visible`);
  });

  it("scopes every style rule to the cyberpunk theme", () => {
    for (const m of css.matchAll(/([^{}]+)\{[^{}]*\}/g)) {
      const prelude = (m[1] ?? "").replace(/\/\*[\s\S]*?\*\//g, "").trim();
      // keyframe steps (from, to, 0%, 50%, …) are not selectors
      if (/^(from|to|[\d.]+%)(\s*,\s*(from|to|[\d.]+%))*$/.test(prelude)) continue;
      for (const sel of prelude.split(",")) expect(sel, sel).toContain(THEME);
    }
  });

  it("the reduced-motion media block outweighs the run-state animations", () => {
    const media = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"));
    const block = media.slice(0, media.indexOf("}\n}\n")).replace(/\s+/g, " ");
    // [theme][data-cap-state] .x has the specificity of [theme][run=…] .x and comes later
    expect(block).toContain(`${THEME}[data-cap-state] .cx-theme-cyberpunk-hud-meter > span`);
    expect(block).not.toMatch(new RegExp(`${THEME.replace(/[[\]~=/.]/g, "\\$&")} \\.`));
  });
});
