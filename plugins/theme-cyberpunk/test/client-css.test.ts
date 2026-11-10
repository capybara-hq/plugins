import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** Properties of the decoration stylesheet that jsdom cannot render (no layout, no corner-shape). */
const css = readFileSync(new URL("../client/styles/cyberpunk.css", import.meta.url), "utf8");
const THEME = '[data-cap-state~="theme=theme-cyberpunk/cyberpunk"]';
const ROOT = `:root:has(${THEME})`;

/** A rule with the chain of preludes it is nested in (outermost first) and its own declarations. */
interface Rule {
  chain: string[];
  body: string;
}

/** The declarations of a block, without its nested blocks (and their preludes). */
function ownDeclarations(inner: string): string {
  let out = "";
  let depth = 0;
  let pending = "";
  for (const c of inner) {
    if (depth === 0) {
      if (c === "{") {
        depth = 1;
        pending = "";
      } else if (c === ";") {
        out += `${pending};`;
        pending = "";
      } else pending += c;
    } else if (c === "{") depth++;
    else if (c === "}") depth--;
  }
  return out + pending;
}

/** Every block of the stylesheet, nested ones included (comments dropped; no braces in strings). */
function rules(text: string): Rule[] {
  const src = text.replace(/\/\*[\s\S]*?\*\//g, "");
  const out: Rule[] = [];
  const walk = (from: number, to: number, chain: string[]) => {
    let start = from;
    let i = from;
    while (i < to) {
      const c = src[i];
      if (c === ";") start = i + 1;
      else if (c === "}") start = i + 1;
      else if (c === "{") {
        let depth = 1;
        let j = i + 1;
        while (j < to && depth > 0) {
          if (src[j] === "{") depth++;
          else if (src[j] === "}") depth--;
          j++;
        }
        const prelude = src.slice(start, i).replace(/\s+/g, " ").trim();
        const inner = src.slice(i + 1, j - 1);
        const own = ownDeclarations(inner);
        out.push({ chain: [...chain, prelude], body: own });
        walk(i + 1, j - 1, [...chain, prelude]);
        start = j;
        i = j;
        continue;
      }
      i++;
    }
  };
  walk(0, src.length, []);
  return out;
}

const all = rules(css);
const styleRules = all.filter((r) => !r.chain.some((p) => p.startsWith("@keyframes")));
const with_ = (decl: string) => styleRules.filter((r) => r.body.includes(decl));
const flat = (r: Rule) => r.chain.join(" > ");

describe("cyberpunk.css", () => {
  it("scopes every rule through :root:has(the theme token), so portaled parts get it too", () => {
    for (const r of styleRules) {
      const top = r.chain.find((p) => !p.startsWith("@"));
      if (top === undefined) continue; // an at-rule wrapper itself
      expect(top, flat(r)).toMatch(/^:root:has\(/);
      expect(top, flat(r)).toContain(THEME);
    }
    // the custom properties (the bevel size, the run colour) live on :root, not on the shell
    const vars = styleRules.find((r) => r.chain.length === 1 && r.chain[0] === ROOT);
    expect(vars?.body).toContain("--cx-theme-cyberpunk-cut:");
    expect(vars?.body).toContain("--cx-theme-cyberpunk-hud:");
    // the run states the same way
    for (const run of ["running", "waiting", "failed"]) {
      const r = styleRules.find(
        (x) => x.chain.length === 1 && x.chain[0]?.includes(`[data-cap-state~="run=${run}"]`),
      );
      expect(r?.chain[0], run).toMatch(/^:root:has\(/);
      expect(r?.body, run).toContain("--cx-theme-cyberpunk-hud:");
    }
  });

  it("bevels every chamfered part with corner-shape, so outlines and focus rings stay whole", () => {
    // clip-path would cut the border and the outer focus ring at the corners: parts never use it
    for (const r of with_("clip-path")) expect(flat(r)).not.toContain("data-cap-part");
    const bevelled = with_("corner-shape: bevel")
      .filter((r) => r.chain.includes("@supports (corner-shape: bevel)"))
      .map(flat)
      .join(",");
    for (const p of ["card", "section", "composer", "dialog", "button", "input"]) {
      expect(bevelled).toContain(`[data-cap-part~="${p}"]`);
    }
  });

  it("never rewrites what a button says (no uppercase transform)", () => {
    expect(css).not.toMatch(/text-transform:\s*uppercase/);
  });

  it("keeps the run-state edges soft: no solid line on the title bar, a fading edge", () => {
    for (const r of with_("box-shadow"))
      expect(flat(r)).not.toContain('[data-cap-part~="title-bar"] ');
    expect(css).toMatch(/var\(--cx-theme-cyberpunk-edge\) 30% 70%,\s*transparent/);
  });

  it("moves only transform and opacity in the run animations", () => {
    for (const name of ["edge-x", "eq", "comet", "beam", "head", "breathe", "sweep"]) {
      const kf = all.filter((r) => r.chain[0] === `@keyframes cx-theme-cyberpunk-${name}`);
      expect(kf.length, name).toBeGreaterThan(0);
      for (const step of kf.slice(1)) {
        for (const decl of step.body
          .split(";")
          .map((d) => d.trim())
          .filter((d) => d !== "")) {
          expect(decl.split(":")[0]?.trim(), `${name}: ${decl}`).toMatch(/^(transform|opacity)$/);
        }
      }
    }
  });

  it("stops every animation under reduced motion, outweighing the run-state rules", () => {
    const media = styleRules.filter(
      (r) => r.chain[0] === "@media (prefers-reduced-motion: reduce)",
    );
    const heavy = `:root:has(${THEME}[data-cap-state])`;
    expect(media.some((r) => r.chain[1] === heavy)).toBe(true);
    const stopped = media
      .filter((r) => r.body.includes("animation: none"))
      .map(flat)
      .join(",");
    const token = styleRules
      .filter((r) => r.chain[0]?.includes('[data-cap-state~="motion=reduced"]'))
      .filter((r) => r.body.includes("animation: none"))
      .map(flat)
      .join(",");
    const hidden = (rules: Rule[]) =>
      rules
        .filter((r) => r.body.includes("display: none"))
        .map(flat)
        .join(",");
    const reducedMedia = { stopped, hidden: hidden(media) };
    const reducedToken = {
      stopped: token,
      hidden: hidden(
        styleRules.filter((r) => r.chain[0]?.includes('[data-cap-state~="motion=reduced"]')),
      ),
    };
    // Every animated selector (outside the keyframes and the reduced-motion blocks) is stopped or
    // hidden by both blocks: through itself, or through the element that hides or stops it.
    const animated = styleRules.filter(
      (r) =>
        /(^|;)\s*animation:\s*(?!none)/.test(r.body) &&
        r.chain[0] !== "@media (prefers-reduced-motion: reduce)" &&
        !r.chain[0]?.includes("motion=reduced"),
    );
    expect(animated.length).toBeGreaterThan(10);
    for (const r of animated) {
      const target = (r.chain[r.chain.length - 1] ?? "")
        .replace(/^& /, "")
        .replace(/:nth-child\([^)]*\)/g, "");
      const via = target.startsWith(".cx-theme-cyberpunk-boot")
        ? ".cx-theme-cyberpunk-boot"
        : /glitch-[ab]$/.test(target)
          ? ".cx-theme-cyberpunk-glitch-layer"
          : target;
      for (const block of [reducedMedia, reducedToken]) {
        const covered = block.stopped.includes(via) || block.hidden.includes(via);
        expect(covered, `${flat(r)} via ${via}`).toBe(true);
      }
    }
  });
});
