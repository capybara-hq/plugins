/**
 * Checks a contributor's environment (`pnpm doctor:env`; plain `pnpm doctor` is pnpm's own command).
 *
 *   node tools/dev/src/doctor-cli.ts [--json] [--fix]
 *
 * Runs before `pnpm install`, so it imports only Node built-ins and relative files.
 * `--fix` only runs `pnpm install` when the `deps` check fails.
 */
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, readlinkSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { type DoctorEnv, runDoctor } from "./doctor.ts";
import { printReport } from "./report.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url)).replace(/\/$/, "");

const env: DoctorEnv = {
  root,
  exec(cmd, args) {
    const r = spawnSync(cmd, args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return { status: r.status ?? 1, stdout: r.stdout ?? "" };
  },
  fileExists: (p) => existsSync(p),
  readFile(p) {
    try {
      return readFileSync(p, "utf8");
    } catch {
      return null;
    }
  },
  isSymlinkTo(p, target) {
    try {
      return lstatSync(p).isSymbolicLink() && readlinkSync(p) === target;
    } catch {
      return false;
    }
  },
  home: homedir(),
  nodeVersion: process.version,
};

const args = process.argv.slice(2);
const json = args.includes("--json");
let checks = await runDoctor(env);
if (args.includes("--fix") && checks.some((c) => c.id === "deps" && c.status === "fail")) {
  console.error("Running pnpm install ...");
  spawnSync("pnpm", ["install"], { cwd: root, stdio: ["ignore", json ? 2 : 1, 2] });
  checks = await runDoctor(env);
}
process.exitCode = printReport(checks, json);
