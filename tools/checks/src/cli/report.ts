import { relative } from "node:path";
import { fileURLToPath } from "node:url";
import type { Finding } from "../finding.js";

/** Repository root. */
export const root = fileURLToPath(new URL("../../../../", import.meta.url));

/** Prints the findings and exits with 1 if there are any. */
export function report(name: string, findings: Finding[]): void {
  for (const f of findings) {
    console.error(`${relative(root, f.file)}:${f.line} ${f.rule} ${f.message}`);
  }
  if (findings.length > 0) {
    console.error(`\n${name} check failed: ${findings.length} finding(s)`);
    process.exit(1);
  }
  console.log(`${name} check passed`);
}
