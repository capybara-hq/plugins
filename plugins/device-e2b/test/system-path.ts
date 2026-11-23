import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The system PATH the provider gets in the fake E2B tests (`E2BSandboxTestOptions.systemPath`):
 * the fake runs commands on this machine as one user, so `runuser` and `setsid` are shims that
 * only exec the rest (like the fake's own), `timeout` is the machine's GNU timeout (`gtimeout` on
 * macOS), then the machine's PATH. In a real VM it is the root-owned system directories.
 * The shims live under the plugin's node_modules, not the OS temp directory: the fake maps env
 * values starting with `/tmp` (Linux's temp directory) into the sandbox root.
 */
export function fakeSystemPath(): string {
  const base = fileURLToPath(new URL("../node_modules/.cache", import.meta.url));
  mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(join(base, "device-e2b-sys-"));
  const shim = (name: string, body: string) => {
    writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`);
    chmodSync(join(dir, name), 0o755);
  };
  shim(
    "runuser",
    'while [ $# -gt 0 ]; do case "$1" in -u|-g) shift 2 ;; --) shift; break ;; -*) shift ;; *) break ;; esac; done\nexec "$@"',
  );
  shim(
    "setsid",
    'while [ $# -gt 0 ]; do case "$1" in -w|-f|-c|--wait|--fork|--ctty) shift ;; *) break ;; esac; done\nexec "$@"',
  );
  const timeout = execFileSync("/bin/sh", ["-c", "command -v gtimeout || command -v timeout"], {
    encoding: "utf8",
  }).trim();
  symlinkSync(timeout, join(dir, "timeout"));
  return `${dir}:${process.env.PATH ?? "/usr/bin:/bin"}`;
}
