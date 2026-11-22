import type { GlyphKey } from "./bitmaps.js";

/**
 * Every functional official plugin and the glyph that carries its function. Brand plugins keep
 * their own mark and are not generated. `example-board` / `example-counter` are private reference
 * plugins and are not part of the rule at all.
 *
 * Three mappings are approximations, because the seven glyphs do not cover every function:
 * - the file previewer uses `storage` (files, no file glyph);
 * - the sandboxes use `storage`: a sandbox's file system and volumes are what persists, and there is
 *   no sandbox glyph;
 * - the cyberpunk theme uses `skills`: a theme is the decorative layer over the interface, and there
 *   is no theme/appearance glyph.
 */
export const PLUGIN_GLYPHS: Readonly<Record<string, GlyphKey>> = {
  "connector-mcp": "connector",
  "connector-openapi": "connector",
  "file-preview": "storage",
  memory: "memory",
  "object-store-s3": "storage",
  "openai-compatible": "model",
  "push-apns": "channel",
  "push-fcm": "channel",
  "push-jpush": "channel",
  "device-docker": "storage",
  "device-e2b": "storage",
  "skills-core": "skills",
  "theme-cyberpunk": "skills",
  todo: "todo",
};
