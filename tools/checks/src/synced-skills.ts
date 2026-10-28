import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { Finding } from "./finding.js";

/**
 * Skills under `.agents/skills/` that were synced from capybara-hq/.github carry
 * `metadata.source: capybara-hq/.github`, `metadata.version` and `metadata.sha256`. The hash covers
 * every file of the skill directory, so a hand edit is caught: change the skill in
 * capybara-hq/.github, then run its sync command. Skills without that source are this repo's own
 * and are ignored.
 *
 * The algorithm is pinned in the shared spec (sync side: capybara-hq/.github src/sync/hash.ts):
 * files sorted by path; text read as UTF-8 with CRLF turned into LF; inside the SKILL.md
 * frontmatter every `  sha256: <hex>` line is removed; sha256 over `${path}\0${content}\0` per file.
 */

export const SYNCED_SOURCE = "capybara-hq/.github";
const SHA_LINE = /^ {2}sha256: [0-9a-f]*$/;

export interface SkillFile {
  path: string;
  content: string;
}

function dropShaLines(content: string): string {
  const lines = content.split("\n");
  if (lines[0] !== "---") return content;
  const end = lines.indexOf("---", 1);
  if (end < 0) return content;
  return [...lines.slice(0, end).filter((l) => !SHA_LINE.test(l)), ...lines.slice(end)].join("\n");
}

export function skillHash(files: SkillFile[]): string {
  const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const hash = createHash("sha256");
  for (const f of sorted) {
    const content = f.path === "SKILL.md" ? dropShaLines(f.content) : f.content;
    hash.update(`${f.path}\0${content}\0`);
  }
  return hash.digest("hex");
}

function readFiles(dir: string, prefix = ""): SkillFile[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? readFiles(join(dir, e.name), `${prefix}${e.name}/`)
      : [
          {
            path: `${prefix}${e.name}`,
            content: readFileSync(join(dir, e.name), "utf8").replaceAll("\r\n", "\n"),
          },
        ],
  );
}

/**
 * The synced skill's files for hashing: only git-tracked ones (the sync side hashes the committed
 * tree, so an untracked `.DS_Store` or editor file must not matter). Outside a git work tree
 * (temp dirs in tests) every file counts.
 */
function skillFiles(root: string, dir: string): SkillFile[] {
  const r = spawnSync("git", ["ls-files", "-z", "--", relative(root, dir) || "."], {
    cwd: root,
    encoding: "utf8",
  });
  if (r.status !== 0) return readFiles(dir);
  const prefix = relative(root, dir);
  const tracked = r.stdout
    .split("\0")
    .filter((f) => f !== "")
    .map((f) => ({ path: f.slice(prefix.length + 1), abs: join(root, f) }))
    .filter((f) => existsSync(f.abs));
  // `git ls-files` run from a root that is not a work tree of its own lists the enclosing repo's
  // files, which is still correct; an empty answer means nothing is tracked here (temp dir).
  if (tracked.length === 0) return readFiles(dir);
  return tracked.map((f) => ({
    path: f.path.split(sep).join("/"),
    content: readFileSync(f.abs, "utf8").replaceAll("\r\n", "\n"),
  }));
}

/** metadata.* values of the frontmatter, with the 1-based line of each. */
function metadata(skillMd: string): Map<string, { value: string; line: number }> {
  const out = new Map<string, { value: string; line: number }>();
  const lines = skillMd.split("\n");
  if (lines[0] !== "---") return out;
  let inMeta = false;
  for (let i = 1; i < lines.length && lines[i] !== "---"; i++) {
    const l = lines[i] ?? "";
    if (/^metadata:\s*$/.test(l)) inMeta = true;
    else if (/^\S/.test(l)) inMeta = false;
    else if (inMeta) {
      const m = /^ {2}([\w-]+):\s*(.*?)\s*$/.exec(l);
      if (m) out.set(m[1] ?? "", { value: (m[2] ?? "").replace(/^["']|["']$/g, ""), line: i + 1 });
    }
  }
  return out;
}

export interface SyncedSkillsResult {
  findings: Finding[];
  /** Names of the synced skills that were verified. */
  checked: string[];
}

export function inspectSyncedSkills(root: string): SyncedSkillsResult {
  const base = join(root, ".agents/skills");
  const result: SyncedSkillsResult = { findings: [], checked: [] };
  if (!existsSync(base)) return result;
  for (const e of readdirSync(base, { withFileTypes: true })) {
    const dir = join(base, e.name);
    const skillFile = join(dir, "SKILL.md");
    if (!e.isDirectory() || !existsSync(skillFile)) continue;
    const text = readFileSync(skillFile, "utf8").replaceAll("\r\n", "\n");
    const meta = metadata(text);
    if (meta.get("source")?.value !== SYNCED_SOURCE) continue;
    result.checked.push(e.name);
    const sha = meta.get("sha256");
    const line = sha?.line ?? meta.get("source")?.line ?? 1;
    if (!meta.get("version")?.value || !sha?.value) {
      result.findings.push({
        file: skillFile,
        line,
        rule: "synced-skill-metadata",
        message: "a synced skill needs metadata.version and metadata.sha256; run the sync command",
      });
      continue;
    }
    if (skillHash(skillFiles(root, dir)) !== sha.value) {
      result.findings.push({
        file: skillFile,
        line,
        rule: "synced-skill-edited",
        message: `edited in place (${relative(root, dir)}): change it in capybara-hq/.github and run the sync command`,
      });
    }
  }
  return result;
}

export function checkSyncedSkills(root: string): Finding[] {
  return inspectSyncedSkills(root).findings;
}
