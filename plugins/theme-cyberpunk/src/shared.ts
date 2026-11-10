/**
 * Names shared by the extension (server) and its client entry. No React and no DOM here: the
 * server bundle imports this file too.
 */

/** The plugin (and extension) name. */
export const PLUGIN = "theme-cyberpunk";

/** `ThemeRef.key` of the theme this plugin carries: decoration shows only while it is active. */
export const THEME_KEY = "theme-cyberpunk/cyberpunk";

/** The wordmark (the theme's logo wordmark too). */
export const WORDMARK = "CYBERBARA";

/** `useClientStorage` key (local scope) of the sound toggle: "on" or absent (off, the default). */
export const SOUND_KEY = "sound";

/**
 * `useClientStorage` key (session scope) set once the boot screen has played in this browser
 * session: the gate while the host has no sign-in id.
 */
export const BOOT_KEY = "booted";

/** `useClientStorage` key (local scope): the sign-in id the boot screen last played for. */
export const BOOT_SIGN_IN_KEY = "booted-sign-in";

/** A class of this plugin (the `cx-<plugin>-` prefix the client CSS rules expect). */
export const cx = (name: string): string => `cx-theme-cyberpunk-${name}`;

/** The `data` of the `run-hud` component's server view. */
export interface HudData {
  /** The viewer's role in the org (owner, admin, member, guest). */
  operator: string;
  /** When the kernel rendered the view (ISO time). */
  uplink: string;
}

/** Reads a `run-hud` view's `data`; null when absent or not of this shape. */
export function parseHudData(data: unknown): HudData | null {
  if (typeof data !== "object" || data === null) return null;
  const d = data as Record<string, unknown>;
  if (typeof d.operator !== "string" || typeof d.uplink !== "string") return null;
  return { operator: d.operator, uplink: d.uplink };
}
