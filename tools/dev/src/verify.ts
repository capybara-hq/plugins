import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type Plan, planAll, type Workspace } from "@capybara-hq/ci/affected";
import type { Check } from "./report.ts";

export type VerifyStep = { id: string; title: string; cmd: string[] | null; note?: string };

function git(cwd: string, args: string[]): string[] {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout.split("\n").filter((l) => l !== "");
}

/**
 * Repo-relative files changed since `base`: the committed diff `base...HEAD` plus staged, unstaged
 * and untracked files (the working tree as it is). Deletions are included, as in CI.
 */
export function changedFiles(cwd: string, base: string): string[] {
  const out = new Set<string>();
  for (const args of [
    ["diff", "--name-only", `${base}...HEAD`],
    ["diff", "--name-only", "--cached"],
    ["diff", "--name-only"],
    ["ls-files", "--others", "--exclude-standard"],
  ]) {
    for (const f of git(cwd, args)) out.add(f);
  }
  return [...out].sort();
}

/** The local equivalent of CI's required jobs for this plan, in run order. */
export function verifySteps(plan: Plan, base: string): VerifyStep[] {
  const steps: VerifyStep[] = [
    { id: "lint", title: "Lint", cmd: ["pnpm", "lint"] },
    { id: "typecheck", title: "Typecheck", cmd: ["pnpm", "typecheck"] },
    { id: "check", title: "Plugin and skill checks", cmd: ["pnpm", "check"] },
    {
      // Every public plugin version has its marketplace.json entry, and the entries at the base
      // are unchanged (append-only), as CI checks on a PR.
      id: "marketplace",
      title: "Marketplace manifest",
      cmd: ["pnpm", "exec", "capybara-plugin", "marketplace", "--check", "--base", base],
    },
    {
      id: "commitlint",
      title: "Commit messages",
      cmd: ["pnpm", "exec", "commitlint", "--from", base, "--to", "HEAD"],
    },
  ];
  if (plan.all) steps.push({ id: "test", title: "Tests", cmd: ["pnpm", "test"] });
  else if (plan.test) {
    steps.push({
      id: "test",
      title: "Tests",
      cmd: ["pnpm", "exec", "vitest", "run", ...plan.testDirs.map((d) => `${d}/`)],
    });
  } else steps.push({ id: "test", title: "Tests", cmd: null, note: "no affected tests" });
  return steps;
}

/** Warns when a published (non-private) package changed without a changeset in the diff. */
export function changesetWarning(files: string[], ws: Workspace, root: string): Check | null {
  const hasChangeset = files.some(
    (f) => /^\.changeset\/[^/]+\.md$/.test(f) && f !== ".changeset/README.md",
  );
  if (hasChangeset) return null;
  const changed = ws.packages.filter((p) => files.some((f) => f.startsWith(`${p.dir}/`)));
  const published = changed.filter((p) => {
    const file = join(root, p.dir, "package.json");
    if (!existsSync(file)) return false;
    return (JSON.parse(readFileSync(file, "utf8")) as { private?: boolean }).private !== true;
  });
  if (published.length === 0) return null;
  return {
    id: "changeset",
    title: "Changeset",
    status: "warn",
    detail: `published packages changed without a changeset: ${published.map((p) => p.name).join(", ")}`,
    fix: "pnpm changeset",
  };
}

/**
 * Interprets the outcome of `git fetch <remote> main` and `git merge-base HEAD <remote>/main`.
 * A failed fetch is a warning (the local ref may be fresh enough); a missing merge base is a
 * failure, since there is nothing to diff against. `base` is null exactly when a check failed.
 */
export function baseChecks(
  remote: string,
  fetchOk: boolean,
  mergeBase: string | null,
): { checks: Check[]; base: string | null } {
  const checks: Check[] = [];
  if (!fetchOk) {
    checks.push({
      id: "fetch",
      title: "Fetch upstream",
      status: "warn",
      detail: `git fetch ${remote} main failed; using the local ${remote}/main`,
      fix: `git fetch ${remote} main`,
    });
  }
  if (mergeBase === null || mergeBase === "") {
    checks.push({
      id: "base",
      title: "Merge base",
      status: "fail",
      detail: `cannot find a merge base between HEAD and ${remote}/main`,
      fix: `git fetch ${remote} main (in a shallow clone: git fetch --unshallow ${remote})`,
    });
    return { checks, base: null };
  }
  return { checks, base: mergeBase };
}

/** `changedFiles`, with a git failure turned into a `base` failure check instead of a throw. */
export function tryChangedFiles(
  cwd: string,
  base: string,
): { files: string[]; check: null } | { files: null; check: Check } {
  try {
    return { files: changedFiles(cwd, base), check: null };
  } catch (e) {
    return {
      files: null,
      check: {
        id: "base",
        title: "Changed files",
        status: "fail",
        detail: `could not list the changed files: ${e instanceof Error ? e.message : String(e)}`,
        fix: "git fetch --unshallow <remote> (or check that the repository is intact)",
      },
    };
  }
}

/** The CI plan for `files`; on any error falls back to running everything, as tools/ci does. */
export function safePlan(compute: () => Plan): Plan {
  try {
    return compute();
  } catch (e) {
    return planAll(`could not compute the plan: ${e instanceof Error ? e.message : String(e)}`);
  }
}
