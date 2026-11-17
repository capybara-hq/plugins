/**
 * Language detection and text decoding for the code previewer. Pure: no DOM, no worker globals.
 * The ids are Shiki language ids; `"text"` means plain (no highlighting).
 */

const BY_EXTENSION: Readonly<Record<string, string>> = {
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "tsx",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "jsx",
  py: "python",
  go: "go",
  rs: "rust",
  java: "java",
  kt: "kotlin",
  swift: "swift",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  cxx: "cpp",
  hh: "cpp",
  hpp: "cpp",
  cs: "csharp",
  rb: "ruby",
  sh: "shellscript",
  bash: "shellscript",
  zsh: "shellscript",
  ps1: "powershell",
  sql: "sql",
  json: "json",
  jsonl: "json",
  jsonc: "jsonc",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  ini: "ini",
  properties: "ini",
  xml: "xml",
  css: "css",
  scss: "scss",
  dockerfile: "dockerfile",
  makefile: "make",
  proto: "proto",
  html: "html",
  htm: "html",
  env: "dotenv",
  log: "log",
};

/** Whole file names that carry the language without an extension. */
const BY_NAME: Readonly<Record<string, string>> = {
  dockerfile: "dockerfile",
  makefile: "make",
  gnumakefile: "make",
};

const BY_MIME: Readonly<Record<string, string>> = {
  "text/css": "css",
  "text/javascript": "javascript",
  "application/javascript": "javascript",
  "text/x-python": "python",
  "application/json": "json",
  "application/xml": "xml",
  "text/xml": "xml",
  "application/yaml": "yaml",
  "text/yaml": "yaml",
  "application/sql": "sql",
  "text/html": "html",
};

/** The Shiki language of a file: by name, then extension, then MIME type, else `"text"`. */
export function languageFor(name: string, contentType: string): string {
  const base = (name.split(/[\\/]/).pop() ?? "").toLowerCase();
  const byName = BY_NAME[base];
  if (byName !== undefined) return byName;
  const dot = base.lastIndexOf(".");
  if (dot >= 0) {
    const byExt = BY_EXTENSION[base.slice(dot + 1)];
    if (byExt !== undefined) return byExt;
  }
  const mime = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  return BY_MIME[mime] ?? "text";
}

/** Every Shiki language id `languageFor` can return (the worker loads exactly these). */
export const LANGUAGES: readonly string[] = Object.freeze(
  [
    ...new Set([
      ...Object.values(BY_EXTENSION),
      ...Object.values(BY_NAME),
      ...Object.values(BY_MIME),
    ]),
  ].sort(),
);

/** The most text the code previewer highlights; the rest of a file is not shown (a note says so). */
export const MAX_HIGHLIGHT_CHARS = 256 * 1024;

/** `text` cut to at most `max` UTF-16 units, never between the halves of a surrogate pair. */
export function capText(
  text: string,
  max: number = MAX_HIGHLIGHT_CHARS,
): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  let end = max;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return { text: text.slice(0, end), truncated: true };
}

function replacements(s: string): number {
  let n = 0;
  for (const ch of s) if (ch === "\uFFFD") n++;
  return n;
}

/**
 * Decodes file bytes as text: UTF-16 by its BOM, else UTF-8 (a UTF-8 BOM is dropped). If more than
 * 10% of a UTF-8 decode is replacement characters, GB18030 is tried and kept when it has fewer.
 * Invalid sequences become U+FFFD and NUL bytes are shown as U+FFFD too, so a binary file reads
 * as text and never throws.
 */
export function decodeText(bytes: ArrayBuffer | Uint8Array): string {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let label = "utf-8";
  if (u8.length >= 2 && u8[0] === 0xff && u8[1] === 0xfe) label = "utf-16le";
  else if (u8.length >= 2 && u8[0] === 0xfe && u8[1] === 0xff) label = "utf-16be";
  let text = new TextDecoder(label, { fatal: false }).decode(u8);
  if (label === "utf-8" && text.length > 0) {
    const bad = replacements(text);
    if (bad / text.length > 0.1) {
      try {
        const gb = new TextDecoder("gb18030", { fatal: false }).decode(u8);
        if (replacements(gb) < bad) text = gb;
      } catch {
        // the runtime has no GB18030 decoder: keep the UTF-8 reading
      }
    }
  }
  return text.replaceAll("\u0000", "\uFFFD");
}
