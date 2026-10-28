export type CheckStatus = "pass" | "fail" | "warn" | "skip";

export type Check = {
  id: string;
  title: string;
  status: CheckStatus;
  detail: string;
  fix?: string;
};

/** Prints the checks (human-readable or the JSON contract) and returns the exit code: 0 iff no `fail`. */
export function printReport(checks: Check[], json: boolean): number {
  const ok = checks.every((c) => c.status !== "fail");
  if (json) {
    console.log(JSON.stringify({ ok, checks }, null, 2));
    return ok ? 0 : 1;
  }
  for (const c of checks) {
    console.log(`${c.status.toUpperCase().padEnd(4)} ${c.title}: ${c.detail}`);
    if (c.fix !== undefined) console.log(`     fix: ${c.fix}`);
  }
  const count = (s: CheckStatus) => checks.filter((c) => c.status === s).length;
  console.log(
    `\n${ok ? "OK" : "NOT OK"}: ${count("pass")} passed, ${count("fail")} failed, ${count("warn")} warnings, ${count("skip")} skipped`,
  );
  return ok ? 0 : 1;
}
