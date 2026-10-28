import { execFileSync } from "node:child_process";
import {
  cpSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { checkSyncedSkills, inspectSyncedSkills, skillHash } from "../src/synced-skills.js";

const fixtures = fileURLToPath(new URL("../fixtures/synced-skills/", import.meta.url));
const fixture = (name: string) => join(fixtures, name);

// Shared vectors, pinned in capybara-hq/.github as well.
const FIXTURE_SHA256 = "cef1a6784ece247858b9144b07a58ac47ffa8c51520e2b1d817421a3d73090dd";
const STAMPED_FIXTURE_SHA256 = "7571c66c01170d67878bb2d691f6c7980ae762412c65e1a602077baa2f9b5a4b";

const load = (dir: string) =>
  ["SKILL.md", "extra.md"].map((path) => ({
    path,
    content: readFileSync(join(fixtures, dir, path), "utf8"),
  }));

describe("skillHash", () => {
  it("matches the shared vectors", () => {
    expect(skillHash(load("vector"))).toBe(FIXTURE_SHA256);
    expect(skillHash(load("vector-stamped"))).toBe(STAMPED_FIXTURE_SHA256);
  });

  it("is independent of file order and of CRLF checkouts", () => {
    const files = load("vector-stamped");
    const crlf = files.map((f) => ({ ...f, content: f.content.replaceAll("\n", "\r\n") }));
    expect(
      skillHash(
        [...crlf].reverse().map((f) => ({ ...f, content: f.content.replaceAll("\r\n", "\n") })),
      ),
    ).toBe(STAMPED_FIXTURE_SHA256);
  });
});

describe("checkSyncedSkills", () => {
  it("passes an untouched synced skill and counts it", () => {
    expect(checkSyncedSkills(fixture("clean"))).toEqual([]);
    expect(inspectSyncedSkills(fixture("clean")).checked).toEqual(["demo"]);
  });

  it("reports an edited synced skill at the sha256 line", () => {
    const f = checkSyncedSkills(fixture("edited"));
    expect(f.map((x) => [x.rule, x.line])).toEqual([["synced-skill-edited", 8]]);
    expect(f[0]?.message).toContain("capybara-hq/.github");
  });

  it("reports missing version / sha256", () => {
    expect(checkSyncedSkills(fixture("metadata")).map((x) => x.rule)).toEqual([
      "synced-skill-metadata",
    ]);
  });

  it("ignores skills without the synced source", () => {
    const r = inspectSyncedSkills(fixture("ignored"));
    expect(r.findings).toEqual([]);
    expect(r.checked).toEqual([]);
  });
});

describe("checkSyncedSkills on a copy", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const copyClean = () => {
    const d = realpathSync(mkdtempSync(join(tmpdir(), "synced-skills-")));
    dirs.push(d);
    cpSync(fixture("clean"), d, { recursive: true });
    return d;
  };

  it("is unaffected by CRLF line endings in the checked-out files", () => {
    const d = copyClean();
    const skill = join(d, ".agents/skills/demo");
    for (const f of readdirSync(skill)) {
      const file = join(skill, f);
      writeFileSync(file, readFileSync(file, "utf8").replaceAll("\n", "\r\n"));
    }
    expect(checkSyncedSkills(d)).toEqual([]);
  });

  it("ignores untracked files next to a clean synced copy in a git repo", () => {
    const d = copyClean();
    const git = (...args: string[]) => execFileSync("git", args, { cwd: d, stdio: "pipe" });
    git("init", "-q");
    git("add", ".");
    writeFileSync(join(d, ".agents/skills/demo/.DS_Store"), "junk");
    expect(checkSyncedSkills(d)).toEqual([]);
  });

  it("still catches an edit to a tracked file in a git repo", () => {
    const d = copyClean();
    const git = (...args: string[]) => execFileSync("git", args, { cwd: d, stdio: "pipe" });
    git("init", "-q");
    git("add", ".");
    writeFileSync(join(d, ".agents/skills/demo/extra.md"), "edited\n");
    expect(checkSyncedSkills(d).map((x) => x.rule)).toEqual(["synced-skill-edited"]);
  });
});
