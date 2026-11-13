/**
 * Builds the composed plugin icon: the pixel capybara with the plugin's function glyph, one accent
 * colour (the composition and colours are documented in `bitmaps.ts`). The result is a standalone
 * SVG because the kernel and the web app load plugin icons as images.
 */
import {
  ACCENT_DARK,
  ACCENT_LIGHT,
  GLYPH_PATHS,
  type GlyphKey,
  ICON_VIEWBOX,
  LOGO_PATH,
} from "./bitmaps.js";

function escapeXml(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

export function buildIconSvg(options: { title: string; glyph: GlyphKey }): string {
  const title = escapeXml(options.title);
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${ICON_VIEWBOX}" ` +
    `shape-rendering="crispEdges"><title>${title}</title>` +
    `<style>@media (prefers-color-scheme: dark){path{fill:${ACCENT_DARK}}}</style>` +
    `<path fill="${ACCENT_LIGHT}" d="${LOGO_PATH}"/>` +
    `<path fill="${ACCENT_LIGHT}" d="${GLYPH_PATHS[options.glyph]}"/>` +
    `</svg>\n`
  );
}
