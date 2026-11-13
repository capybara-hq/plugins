import { describe, expect, it } from "vitest";
import { CAPYBARA_BITMAP, GLYPH_KEYS, GLYPH_PATHS, LOGO_PATH } from "../src/bitmaps.js";
import { buildIconSvg } from "../src/compose.js";

describe("composed icon", () => {
  it("keeps the capybara bitmap verbatim: 14x10, X filled, O the knocked-out eye", () => {
    expect(CAPYBARA_BITMAP).toHaveLength(10);
    expect(CAPYBARA_BITMAP.every((row) => row.length === 14)).toBe(true);
    expect(CAPYBARA_BITMAP[3]?.[11]).toBe("O");
    // The eye cell's top-left is x=15.35, y=5.45 (0.5 + 11 * 1.35, 1.4 + 3 * 1.35): left empty.
    expect(LOGO_PATH).not.toContain("M15.35 5.45");
    expect(LOGO_PATH).toContain("M16.7 5.45");
  });

  it("gives each of the seven function glyphs a distinct path", () => {
    expect(GLYPH_KEYS).toHaveLength(7);
    expect(new Set(Object.values(GLYPH_PATHS)).size).toBe(7);
  });

  it("writes a 24x24 standalone icon with the logo, one glyph and both accent colours", () => {
    const svg = buildIconSvg({ title: "Memory", glyph: "memory" });
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(svg).toContain('viewBox="0 0 24 24"');
    expect(svg).toContain('shape-rendering="crispEdges"');
    expect(svg).toContain(`d="${LOGO_PATH}"`);
    expect(svg).toContain(`d="${GLYPH_PATHS.memory}"`);
    expect(svg).toContain("#CC4609");
    expect(svg).toContain("#FF6A13");
    expect(svg).toContain("@media (prefers-color-scheme: dark)");
    expect(svg).toContain("<title>Memory</title>");
  });
});
