/**
 * Prints the CI plan for a diff and, under GitHub Actions, writes it to $GITHUB_OUTPUT.
 *
 *   git diff --name-only BASE...HEAD | node tools/ci/src/cli.ts
 *   node tools/ci/src/cli.ts --all "push to main"
 *
 * Fails safe: if the plan can't be computed (bad workspace file, script bug), it runs everything.
 */
import { appendFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadWorkspace, type Plan, planAll, planFromFiles, toOutputs } from "./affected.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url));

function plan(): Plan {
  const args = process.argv.slice(2);
  if (args[0] === "--all") return planAll(args[1] ?? "run everything requested");
  try {
    const files = readFileSync(0, "utf8").split("\n");
    return planFromFiles(files, loadWorkspace(root));
  } catch (e) {
    return planAll(`could not compute the plan: ${e instanceof Error ? e.message : String(e)}`);
  }
}

const outputs = toOutputs(plan());
const lines = Object.entries(outputs).map(([k, v]) => `${k}=${v.replaceAll("\n", " ")}`);
console.log(lines.join("\n"));
const out = process.env.GITHUB_OUTPUT;
if (out !== undefined && out !== "") appendFileSync(out, `${lines.join("\n")}\n`);
