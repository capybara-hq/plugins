import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Plan, Workspace } from "@capybara-hq/ci/affected";
import { afterEach, describe, expect, it, vi } from "vitest";
import { printReport } from "../src/report.ts";
import {
  baseChecks,
  changedFiles,
  changesetWarning,
  safePlan,
  tryChangedFiles,
  verifySteps,
} from "../src/verify.ts";

const basePlan: Plan = {
  reason: "test",
  all: false,
  testDirs: [],
  test: false,
  shards: 1,
};
const find = (plan: Plan, id: string) => verifySteps(plan, "abc").find((s) => s.id === id);

describe("verifySteps", () => {
  it("for a docs-only plan has no test command", () => {
    const test = find(basePlan, "test");
    expect(test?.cmd).toBeNull();
    expect(test?.note).toBe("no affected tests");
    expect(find(basePlan, "commitlint")?.cmd).toEqual([
      "pnpm",
      "exec",
      "commitlint",
      "--from",
      "abc",
      "--to",
      "HEAD",
    ]);
  });

  it("plan.all runs pnpm test", () => {
    expect(find({ ...basePlan, all: true, test: true }, "test")?.cmd).toEqual(["pnpm", "test"]);
  });

  it("testDirs become vitest filters", () => {
    const plan = { ...basePlan, test: true, testDirs: ["plugins/slack", "tools/dev"] };
    expect(find(plan, "test")?.cmd).toEqual([
      "pnpm",
      "exec",
      "vitest",
      "run",
      "plugins/slack/",
      "tools/dev/",
    ]);
  });

  it("runs the marketplace check against the base, as CI does on a PR", () => {
    expect(find(basePlan, "marketplace")?.cmd).toEqual([
      "pnpm",
      "exec",
      "capybara-plugin",
      "marketplace",
      "--check",
      "--base",
      "abc",
    ]);
  });

  it("runs lint, typecheck, check, marketplace and commitlint before the tests", () => {
    expect(verifySteps(basePlan, "abc").map((s) => s.id)).toEqual([
      "lint",
      "typecheck",
      "check",
      "marketplace",
      "commitlint",
      "test",
    ]);
  });
});

describe("changesetWarning", () => {
  const root = join(import.meta.dirname, "../../..");
  const ws: Workspace = {
    packages: [
      { dir: "plugins/slack", name: "@capybara-hq/plugin-slack", deps: [], hasTests: true },
      { dir: "tools/dev", name: "@capybara-hq/dev", deps: [], hasTests: true },
    ],
  };

  it("warns for a published plugin without a changeset", () => {
    const w = changesetWarning(["plugins/slack/src/a.ts"], ws, root);
    expect(w?.status).toBe("warn");
    expect(w?.detail).toContain("@capybara-hq/plugin-slack");
  });

  it("is null when a changeset is in the diff", () => {
    expect(changesetWarning(["plugins/slack/src/a.ts", ".changeset/x.md"], ws, root)).toBeNull();
  });

  it("is null for tools/dev (private)", () => {
    expect(changesetWarning(["tools/dev/src/a.ts"], ws, root)).toBeNull();
  });
});

describe("changedFiles", () => {
  let dir = "";
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args: string[]) =>
    execFileSync(
      "git",
      [
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@example.com",
        "-c",
        "commit.gpgsign=false",
        ...args,
      ],
      { cwd: dir, encoding: "utf8" },
    ).trim();

  it("includes an untracked file", () => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "cap-verify-")));
    git("init", "-q", "-b", "main");
    writeFileSync(join(dir, "a.txt"), "a\n");
    git("add", ".");
    git("commit", "-q", "-m", "init");
    const base = git("rev-parse", "HEAD");
    writeFileSync(join(dir, "b.txt"), "b\n");
    git("add", "b.txt");
    git("commit", "-q", "-m", "b");
    writeFileSync(join(dir, "a.txt"), "changed\n");
    writeFileSync(join(dir, "new.txt"), "n\n");
    expect(changedFiles(dir, base)).toEqual(["a.txt", "b.txt", "new.txt"]);
  });
});

describe("baseChecks", () => {
  it("passes through a merge base with no checks", () => {
    expect(baseChecks("origin", true, "abc123")).toEqual({ checks: [], base: "abc123" });
  });

  it("turns a failed fetch into a warning and keeps the base", () => {
    const r = baseChecks("upstream", false, "abc123");
    expect(r.base).toBe("abc123");
    expect(r.checks.map((c) => [c.id, c.status])).toEqual([["fetch", "warn"]]);
  });

  it("turns a missing merge base into a fail check with a fix, and the report is the JSON contract", () => {
    const r = baseChecks("upstream", false, null);
    expect(r.base).toBeNull();
    expect(r.checks.map((c) => [c.id, c.status])).toEqual([
      ["fetch", "warn"],
      ["base", "fail"],
    ]);
    expect(r.checks[1]?.fix).toContain("git fetch --unshallow upstream");

    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      expect(printReport(r.checks, true)).toBe(1);
      const out = JSON.parse(String(log.mock.calls[0]?.[0])) as {
        ok: boolean;
        checks: { id: string; title: string; status: string; detail: string; fix?: string }[];
      };
      expect(out.ok).toBe(false);
      expect(out.checks.find((c) => c.id === "base")).toMatchObject({
        status: "fail",
        title: expect.any(String),
        detail: expect.any(String),
        fix: expect.any(String),
      });
    } finally {
      log.mockRestore();
    }
  });
});

describe("tryChangedFiles / safePlan", () => {
  it("reports a git failure as a base fail check instead of throwing", () => {
    const dir = mkdtempSync(join(tmpdir(), "verify-nogit-"));
    try {
      const r = tryChangedFiles(dir, "deadbeef");
      expect(r.files).toBeNull();
      expect(r.check?.id).toBe("base");
      expect(r.check?.status).toBe("fail");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("falls back to running everything when the plan can't be computed", () => {
    const plan = safePlan(() => {
      throw new Error("boom");
    });
    expect(plan.all).toBe(true);
    expect(plan.reason).toBe("could not compute the plan: boom");
  });
});
