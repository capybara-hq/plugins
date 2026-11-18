/**
 * Maps the host's design tokens onto the CSS custom properties the renderers use.
 *
 * The host (core `apps/web/src/lib/embed-bridge.ts`, `readDesignTokens`) sends every `--cb-*`
 * custom property of its document under its full name (`"--cb-bg": "#0A0A0A"`); the values are in
 * core `packages/design/src/styles/tokens.css`. Renderers never read `--cb-*` themselves: they use
 * the small set below, set on `:root` by `applyTheme`, so the one mapping lives in this file.
 *
 * | variable                  | host token       | use                              |
 * |---------------------------|------------------|----------------------------------|
 * | `--cap-background`        | `--cb-bg`        | page and sticky bars             |
 * | `--cap-panel`             | `--cb-panel`     | recessed areas (pdf page well)   |
 * | `--cap-hover`             | `--cb-hover`     | hover / subtle fills             |
 * | `--cap-border`            | `--cb-line`      | hairlines                        |
 * | `--cap-foreground`        | `--cb-ink`       | text                             |
 * | `--cap-muted-foreground`  | `--cb-muted`     | secondary text                   |
 * | `--cap-accent`            | `--cb-accent`    | active / selected                |
 * | `--cap-danger`            | `--cb-fail`      | errors                           |
 * | `--cap-font`              | `--cb-font-prose`| UI text                          |
 * | `--cap-font-mono`         | `--cb-font`      | code, tabular numbers            |
 * | `--cap-radius`            | `--cb-radius-sm` | buttons, small boxes             |
 * | `--cap-scroll-thumb`      | `--cb-scroll-thumb` | scrollbar thumb (track clear) |
 *
 * `applyTheme` also sets `color-scheme` from the host theme, so native controls and scrollbars
 * follow it; the shell's `scrollbar-color` (thumb on a transparent track, as the host draws its
 * own) keeps a light track off a dark panel where the browser's scheme alone does not.
 */

/** The variables renderers may use, by role. */
export const THEME_VARS = {
  background: "--cap-background",
  panel: "--cap-panel",
  hover: "--cap-hover",
  border: "--cap-border",
  foreground: "--cap-foreground",
  mutedForeground: "--cap-muted-foreground",
  accent: "--cap-accent",
  danger: "--cap-danger",
  font: "--cap-font",
  fontMono: "--cap-font-mono",
  radius: "--cap-radius",
  scrollThumb: "--cap-scroll-thumb",
} as const;

export type ThemeKey = keyof typeof THEME_VARS;

interface Entry {
  /** The host token the variable is read from. */
  token: string;
  /** Used when the host did not send the token (before `init`, an old host). */
  dark: string;
  light: string;
  /** The `var()` fallback in renderer CSS, for the moments before `applyTheme` ran. */
  css: string;
}

const MONO = '"Sarasa Mono SC", ui-monospace, monospace';
const PROSE = '"Inter", "Source Han Sans SC", system-ui, sans-serif';

const TABLE: Record<ThemeKey, Entry> = {
  background: { token: "--cb-bg", dark: "#0A0A0A", light: "#FAF9F6", css: "Canvas" },
  panel: { token: "--cb-panel", dark: "#111110", light: "#FFFFFF", css: "Canvas" },
  hover: {
    token: "--cb-hover",
    dark: "#171716",
    light: "rgba(26,26,24,0.04)",
    css: "rgba(127,127,127,.12)",
  },
  border: { token: "--cb-line", dark: "#2A2A28", light: "#D9D8D2", css: "rgba(127,127,127,.3)" },
  foreground: { token: "--cb-ink", dark: "#E6E6E3", light: "#1A1A18", css: "CanvasText" },
  mutedForeground: { token: "--cb-muted", dark: "#8E8E89", light: "#5E5E5A", css: "GrayText" },
  accent: { token: "--cb-accent", dark: "#FF6A13", light: "#CC4609", css: "Highlight" },
  danger: { token: "--cb-fail", dark: "#FF5C52", light: "#C8302A", css: "#c8302a" },
  font: { token: "--cb-font-prose", dark: PROSE, light: PROSE, css: "system-ui, sans-serif" },
  fontMono: { token: "--cb-font", dark: MONO, light: MONO, css: "ui-monospace, monospace" },
  radius: { token: "--cb-radius-sm", dark: "4px", light: "4px", css: "4px" },
  scrollThumb: {
    token: "--cb-scroll-thumb",
    dark: "rgba(255,255,255,0.15)",
    light: "rgba(26,26,24,0.20)",
    css: "rgba(127,127,127,.35)",
  },
};

/** `var(--cap-…, fallback)` per role, for template-string CSS in the renderers. */
export const THEME = Object.fromEntries(
  (Object.keys(THEME_VARS) as ThemeKey[]).map((k) => [k, `var(${THEME_VARS[k]}, ${TABLE[k].css})`]),
) as Record<ThemeKey, string>;

// a token value lands in a stylesheet property: nothing that can fetch, escape or end the declaration
const HOSTILE_VALUE = /url\(|[;{}\\]|@import|expression\(/i;
const MAX_VALUE_LENGTH = 200;
const usable = (v: unknown): v is string =>
  typeof v === "string" &&
  v.trim() !== "" &&
  v.trim().length <= MAX_VALUE_LENGTH &&
  !HOSTILE_VALUE.test(v);

const TOKEN_RE = /^--cb-[a-z0-9-]+$/i;
// the properties each document got last time, so a theme event replaces them instead of piling up
const applied = new WeakMap<Document, string[]>();

/**
 * Sets the `--cap-*` variables on `:root` from the host's tokens (a missing token takes the
 * theme's default) and `data-theme`. Properties of the previous call are replaced; no DOM node is
 * touched, so a mounted preview keeps its state (scroll, selection) across a theme switch.
 */
export function applyTheme(
  doc: Document,
  theme: "dark" | "light",
  tokens: Record<string, string>,
): void {
  const style = doc.documentElement.style;
  for (const prop of applied.get(doc) ?? []) style.removeProperty(prop);
  const props: string[] = [];
  for (const key of Object.keys(THEME_VARS) as ThemeKey[]) {
    const entry = TABLE[key];
    const sent = TOKEN_RE.test(entry.token) ? tokens[entry.token] : undefined;
    const value = usable(sent) ? sent.trim() : entry[theme];
    style.setProperty(THEME_VARS[key], value);
    props.push(THEME_VARS[key]);
  }
  applied.set(doc, props);
  doc.documentElement.setAttribute("data-theme", theme);
  style.colorScheme = theme;
}
