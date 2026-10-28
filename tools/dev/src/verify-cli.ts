/**
 * Runs locally what CI's required checks run for this branch's diff (`pnpm verify`).
 *
 *   tsx tools/dev/src/verify-cli.ts [--json]
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadWorkspace, planFromFiles, type Workspace } from "@capybara-hq/ci/affected";
import { findUpstream, readRemotes } from "./remotes.ts";
import { type Check, printReport } from "./report.ts";
import { baseChecks, changesetWarning, safePlan, tryChangedFiles, verifySteps } from "./verify.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url)).replace(/\/$/, "");
const json = process.argv.includes("--json");
// In --json mode stdout carries only the report; progress goes to stderr.
const say = (s: string) => (json ? console.error(s) : console.log(s));

const upstream = findUpstream(readRemotes(root), "plugins");
if (upstream === null) {
  process.exitCode = printReport(
    [
      {
        id: "remotes",
        title: "Upstream remote",
        status: "fail",
        detail: "no remote points to github.com/capybara-hq/plugins",
        fix: "git remote add upstream https://github.com/capybara-hq/plugins.git",
      },
    ],
    json,
  );
} else {
  const fetched = spawnSync("git", ["fetch", upstream.remote, "main"], {
    cwd: root,
    stdio: "pipe",
  });
  const mb = spawnSync("git", ["merge-base", "HEAD", `${upstream.remote}/main`], {
    cwd: root,
    encoding: "utf8",
  });
  const resolved = baseChecks(
    upstream.remote,
    fetched.status === 0,
    mb.status === 0 ? mb.stdout.trim() : null,
  );
  const listed = resolved.base === null ? null : tryChangedFiles(root, resolved.base);
  if (resolved.base === null || listed === null || listed.files === null) {
    const checks = [...resolved.checks, ...(listed?.check ? [listed.check] : [])];
    process.exitCode = printReport(checks, json);
  } else {
    const base = resolved.base;
    const files = listed.files;
    let ws: Workspace | null = null;
    const plan = safePlan(() => {
      ws = loadWorkspace(root);
      return planFromFiles(files, ws);
    });
    say(`base: ${base}`);
    say(`changed files: ${files.length}`);
    say(`plan: ${plan.reason}`);

    const checks: Check[] = [...resolved.checks];
    for (const step of verifySteps(plan, base)) {
      if (step.cmd === null) {
        checks.push({ id: step.id, title: step.title, status: "skip", detail: step.note ?? "" });
        continue;
      }
      say(`\n==> ${step.title}: ${step.cmd.join(" ")}`);
      const [cmd, ...args] = step.cmd as [string, ...string[]];
      const r = spawnSync(cmd, args, {
        cwd: root,
        encoding: "utf8",
        stdio: json ? "pipe" : "inherit",
        maxBuffer: 256 * 1024 * 1024,
      });
      const ok = r.status === 0;
      const tail = json
        ? `${r.stdout ?? ""}${r.stderr ?? ""}`.trimEnd().split("\n").slice(-20).join("\n")
        : "";
      checks.push({
        id: step.id,
        title: step.title,
        status: ok ? "pass" : "fail",
        detail: ok ? step.cmd.join(" ") : `exit ${r.status ?? "signal"}${tail ? `\n${tail}` : ""}`,
      });
    }
    const warning = ws === null ? null : changesetWarning(files, ws, root);
    if (warning !== null) checks.push(warning);
    say("");
    process.exitCode = printReport(checks, json);
  }
}
