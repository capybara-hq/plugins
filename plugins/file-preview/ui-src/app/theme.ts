/** Maps the host's design tokens onto CSS custom properties of `:root`. */

const NAME_RE = /^[a-z0-9][a-z0-9-]*$/i;
// the properties each document got last time, so a theme event replaces them instead of piling up
const applied = new WeakMap<Document, string[]>();

/**
 * Sets `--cap-<token>` on `:root` and `data-theme`. Properties of the previous call that the new
 * token set no longer carries are removed; no DOM node is touched, so a mounted preview keeps its
 * state (scroll, selection) across a theme switch.
 */
export function applyTheme(
  doc: Document,
  theme: "dark" | "light",
  tokens: Record<string, string>,
): void {
  const style = doc.documentElement.style;
  for (const prop of applied.get(doc) ?? []) style.removeProperty(prop);
  const props: string[] = [];
  for (const [name, value] of Object.entries(tokens)) {
    if (!NAME_RE.test(name) || typeof value !== "string") continue;
    const prop = `--cap-${name}`;
    style.setProperty(prop, value);
    props.push(prop);
  }
  applied.set(doc, props);
  doc.documentElement.setAttribute("data-theme", theme);
  style.colorScheme = theme;
}
