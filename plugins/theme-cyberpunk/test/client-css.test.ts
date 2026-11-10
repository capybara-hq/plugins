import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** Properties of the decoration stylesheet that jsdom cannot render (no layout, no corner-shape). */
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
  it("bevels every chamfered part with corner-shape, so outlines and focus rings stay whole", () => {
    // clip-path would cut the border and the outer focus ring at the corners: parts never use it
    // (the glitch layers' keyframes clip their own copies of the text, not parts)
    for (const sel of selectorsWith("clip-path")) expect(sel).not.toContain("data-cap-part");
    const bevelled = selectorsWith("corner-shape: bevel").join(",");
    for (const part of ["card", "section", "composer", "button"]) {
      expect(bevelled).toContain(`${THEME} [data-cap-part~="${part}"]`);
    }
    expect(bevelled).toContain(`:root:has(${THEME}) [data-cap-part~="dialog"]`);
    expect(css).toContain("@supports (corner-shape: bevel)");
  });

  it("keeps the run-state edges soft: no full-strength solid line on the title bar", () => {
    const titleBar = selectorsWith("box-shadow")
      .filter((sel) => sel.includes('[data-cap-part~="title-bar"]'))
      .join(",");
    expect(titleBar).toBe("");
    // the line fades out toward both ends
    expect(css).toMatch(/var\(--cx-theme-cyberpunk-edge\) 30% 70%,\s*transparent/);
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
    expect(block).toContain(`${THEME}[data-cap-state] [data-cap-part~="title-bar"]`);
    expect(block).not.toMatch(new RegExp(`${THEME.replace(/[[\]~=/.]/g, "\\$&")} \\.`));
  });
});
