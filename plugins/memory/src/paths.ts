/**
 * Memory paths: `<type>/…/<name>.md`. The first segment is the memory's type; deeper directories
 * are allowed; every segment is lowercase ASCII letters, digits, `-`, `_`, `.` or CJK characters.
 * Errors are English and tell the model how to fix the path.
 */

/** The four memory types, in the order the index lists them. */
// capybara:allow-module-state read-only list of the memory types
export const MEMORY_TYPES = ["user", "feedback", "project", "reference"] as const;
export type MemoryType = (typeof MEMORY_TYPES)[number];

/** Longest path, counted in characters after normalisation (including `.md`). */
export const MAX_PATH_LENGTH = 200;
/** Most `[[…]]` links kept per memory body. */
export const MAX_LINKS = 50;

export type ParsedPath =
  | { ok: true; path: string; type: MemoryType; dirs: string[]; name: string }
  | { ok: false; error: string };

// capybara:allow-module-state read-only character class
const SEGMENT_RE =
  /^[a-z0-9\-_.\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+$/u;

const TYPE_LIST = MEMORY_TYPES.map((t) => `${t}/`).join(", ");
const EXAMPLE = '"feedback/reply-in-chinese.md"';

const isType = (s: string): s is MemoryType => (MEMORY_TYPES as readonly string[]).includes(s);

/** Lowercases ASCII letters only (CJK and other scripts are left as they are). */
const lowerAscii = (s: string): string => s.replace(/[A-Z]/g, (c) => c.toLowerCase());

/** Checks one segment; returns an error text or null. */
function segmentError(seg: string, original: string): string | null {
  if (seg === "") {
    return `Path "${original}" has an empty segment (a doubled or trailing "/"); write it like ${EXAMPLE}.`;
  }
  if (seg === "." || seg === "..") {
    return `Path "${original}" may not contain "${seg}" segments; write the full path from the type, like ${EXAMPLE}.`;
  }
  if (!SEGMENT_RE.test(seg)) {
    return `Path "${original}" has a character that is not allowed in "${seg}": use lowercase letters, digits, "-", "_", "." or Chinese / Japanese / Korean characters, like ${EXAMPLE}.`;
  }
  return null;
}

/**
 * Parses and normalises a memory path: trims, lowercases ASCII, strips leading `/`, appends `.md`
 * when missing. `dirs` are the directory segments, the type first (`["project", "github"]` for
 * `project/github/probe.md`); `name` is the file name without `.md`.
 */
export function parsePath(input: string): ParsedPath {
  const original = input.trim();
  let p = lowerAscii(original).replace(/^\/+/, "");
  if (p === "") {
    return {
      ok: false,
      error: `The path is empty; give a memory path like ${EXAMPLE}.`,
    };
  }
  const segments = p.split("/");
  for (const seg of segments) {
    const e = segmentError(seg, original);
    if (e !== null) return { ok: false, error: e };
  }
  const type = segments[0] ?? "";
  if (!isType(type)) {
    return {
      ok: false,
      error: `Path "${original}" must start with one of the memory types ${TYPE_LIST} (e.g. ${EXAMPLE}).`,
    };
  }
  if (segments.length < 2) {
    return {
      ok: false,
      error: `Path "${original}" names only the type directory; add a file name after it, like ${EXAMPLE}.`,
    };
  }
  if (!p.endsWith(".md")) p = `${p}.md`;
  const parts = p.split("/");
  const file = parts[parts.length - 1] ?? "";
  const name = file.slice(0, -".md".length);
  if (name === "" || name === "." || name === "..") {
    return {
      ok: false,
      error: `Path "${original}" has no file name before ".md"; write it like ${EXAMPLE}.`,
    };
  }
  if (p.length > MAX_PATH_LENGTH) {
    return {
      ok: false,
      error: `Path "${original}" is longer than ${MAX_PATH_LENGTH} characters; use a shorter name.`,
    };
  }
  return { ok: true, path: p, type, dirs: parts.slice(0, -1), name };
}

/** Normalises a bare link target (a memory name without directories); null when invalid. */
function bareName(target: string): string | null {
  let n = lowerAscii(target.trim());
  if (n.endsWith(".md")) n = n.slice(0, -".md".length);
  if (n === "" || segmentError(n, target) !== null) return null;
  return n;
}

/**
 * The `[[…]]` link targets of a body, in order of first appearance, deduplicated, at most
 * {@link MAX_LINKS}. A target with a `/` is normalised as a path ({@link parsePath}); a bare name
 * stays a name (lowercased, without `.md`) and is resolved by file name when read. Invalid targets
 * are dropped.
 */
export function parseLinks(body: string): string[] {
  const out: string[] = [];
  for (const m of body.matchAll(/\[\[([^[\]\n]+)\]\]/g)) {
    const raw = m[1] ?? "";
    let target: string | null;
    if (raw.includes("/")) {
      const r = parsePath(raw);
      target = r.ok ? r.path : null;
    } else {
      target = bareName(raw);
    }
    if (target === null || out.includes(target)) continue;
    out.push(target);
    if (out.length === MAX_LINKS) break;
  }
  return out;
}
