/**
 * The pixel capybara and the seven function glyphs of the composed plugin icon.
 *
 * `CAPYBARA_BITMAP` is copied verbatim from capybara-hq/core
 * `packages/design/src/display/logo.tsx` (the mark the app's sidebar uses). Do not redraw it: this
 * file is the one source of truth for the icon generator and the `plugin-icons` check.
 *
 * Composition (24x24 viewBox, `shape-rendering="crispEdges"`):
 * - the logo's 14x10 cells are 1.35 units, first cell at x=0.5, y=1.4 (18.9 x 13.5);
 * - a 7x7 function glyph is 1.15 units, first cell at x=14.8, y=15.1 (8.05 x 8.05), tucked at the
 *   logo's bottom-right.
 * `X` is filled; `O` is the knocked-out eye (left empty).
 *
 * One colour only: the accent. Light theme #CC4609; dark theme #FF6A13, switched inside the SVG
 * with `@media (prefers-color-scheme: dark)` because icons are loaded as images and cannot read the
 * page's CSS variables.
 */

export const CAPYBARA_BITMAP: readonly string[] = [
  "..........X...",
  ".........XXX..",
  "...XXXXXXXXXXX",
  "..XXXXXXXXXOXX",
  ".XXXXXXXXXXXXX",
  ".XXXXXXXXXXXXX",
  ".XXXXXXXXXXXXX",
  "..XXXXXXXXXX..",
  "..XX..X..XX...",
  "..XX..X..XX...",
];

/** The glyphs that carry a plugin's function; `X` is filled. */
export const GLYPH_KEYS = [
  "memory",
  "storage",
  "connector",
  "todo",
  "model",
  "skills",
  "channel",
] as const;

export type GlyphKey = (typeof GLYPH_KEYS)[number];

export const GLYPHS: Record<GlyphKey, readonly string[]> = {
  memory: ["..XXX..", "..XXX..", ".......", "XX...XX", "XX...XX", ".......", "......."],
  storage: [".XXXXX.", "X.....X", "X.....X", ".XXXXX.", "X.....X", "X.....X", ".XXXXX."],
  connector: [".XX.XX.", ".XX.XX.", "XXXXXXX", "XXXXXXX", ".XXXXX.", "..XXX..", "...X..."],
  todo: ["......X", ".....XX", "X...XX.", "XX.XX..", ".XXX...", "..X....", "......."],
  model: [".X...X.", "XXXXXXX", "X.XXX.X", "X.XXX.X", "X.XXX.X", "XXXXXXX", ".X...X."],
  skills: ["...X...", "..XXX..", ".XXXXX.", "XXXXXXX", ".XXXXX.", "..XXX..", "...X..."],
  channel: [".XXXXX.", "XXXXXXX", "XXXXXXX", "XXXXXXX", ".XXXXX.", "..XX...", "..X...."],
};

export const ICON_VIEWBOX = "0 0 24 24";
export const ACCENT_LIGHT = "#CC4609";
export const ACCENT_DARK = "#FF6A13";

export const LOGO_CELL = 1.35;
export const LOGO_X = 0.5;
export const LOGO_Y = 1.4;
export const GLYPH_CELL = 1.15;
export const GLYPH_X = 14.8;
export const GLYPH_Y = 15.1;

/** Two decimals is exactly how the composition lands; trailing zeros are dropped. */
function fmt(n: number): string {
  return String(Math.round(n * 100) / 100);
}

/**
 * The `X` cells of `rows` as one SVG path of `cell`-sized squares, the first at `x0`, `y0`.
 * Consecutive filled cells in a row become one rectangle; `O` and `.` stay empty.
 */
export function pixelPath(rows: readonly string[], cell: number, x0: number, y0: number): string {
  const parts: string[] = [];
  rows.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      if (row[x] !== "X") {
        x++;
        continue;
      }
      let end = x;
      while (row[end] === "X") end++;
      const width = (end - x) * cell;
      parts.push(
        `M${fmt(x0 + x * cell)} ${fmt(y0 + y * cell)}` +
          `h${fmt(width)}v${fmt(cell)}h-${fmt(width)}z`,
      );
      x = end;
    }
  });
  return parts.join("");
}

export const LOGO_PATH = pixelPath(CAPYBARA_BITMAP, LOGO_CELL, LOGO_X, LOGO_Y);

export const GLYPH_PATHS: Record<GlyphKey, string> = Object.fromEntries(
  GLYPH_KEYS.map((key) => [key, pixelPath(GLYPHS[key], GLYPH_CELL, GLYPH_X, GLYPH_Y)]),
) as Record<GlyphKey, string>;
