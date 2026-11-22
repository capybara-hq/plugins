import { createHash } from "node:crypto";
import { SANDBOX_RUNTIME_SOURCE } from "@capybara-hq/plugin-sdk";
import { OPERATION_AGENT_SHA256, OPERATION_AGENT_SOURCE } from "./operation-agent-source.js";

export { OPERATION_AGENT_SHA256 } from "./operation-agent-source.js";

/**
 * The operation runtime the provider stages in the VM itself (an E2B template is built from the
 * published image, and templates built before the runtime existed have none): the provider
 * uploads these files as root to its root-only staging area, root checks them against
 * `SHA256SUMS` and moves them into {@link RUNTIME_DIR} (root-owned, 0755 / 0644). The directory is
 * named after the digest of every staged file (its `SHA256SUMS`), so a provider version only ever
 * runs its own agent next to its own SDK bytes (an SDK upgrade that changes them stages a fresh
 * directory instead of meeting old bytes), and `verify_runtime` re-checks the SDK files on each
 * launch.
 *
 * - `native-files.py`, `linux-sandbox.py`: the SDK's `SANDBOX_RUNTIME_SOURCE` bytes, unchanged.
 *   The launcher only answers the template probe here (the microVM is the sandbox: no restricted
 *   filters are offered, see the agent header and README "Permission profiles").
 * - `capybara-operation.py`: this provider's agent (`runtime/capybara-operation.py`).
 */
export const RUNTIME_BASE = "/opt/capybara-e2b-runtime";

/** The root-owned record directory (consume records, tombstones, background records). */
export const OPS_DIR = "/opt/capybara-e2b-ops";

/** The SDK bundle version the staged files come from. */
export const RUNTIME_BUNDLE_VERSION = 2;

/** The SDK files the provider stages, by name. */
// capybara:allow-module-state read-only list of staged file names, never mutated
export const SDK_RUNTIME_FILES = Object.freeze(["native-files.py", "linux-sandbox.py"] as const);

/**
 * The SDK digests of the staged files, checked against the bundle's own bytes: a bundle whose
 * version, file set or bytes differ from what this provider stages makes the runtime unavailable
 * rather than running different code than was reviewed.
 */
export function sdkRuntimeDigests(): Record<(typeof SDK_RUNTIME_FILES)[number], string> {
  if (SANDBOX_RUNTIME_SOURCE.version !== RUNTIME_BUNDLE_VERSION) {
    throw new Error(
      `device-e2b stages runtime bundle v${RUNTIME_BUNDLE_VERSION}, the SDK has v${SANDBOX_RUNTIME_SOURCE.version}`,
    );
  }
  const out: Partial<Record<(typeof SDK_RUNTIME_FILES)[number], string>> = {};
  for (const name of SDK_RUNTIME_FILES) {
    const file = SANDBOX_RUNTIME_SOURCE.files.find((f) => f.name === name);
    if (!file) throw new Error(`the SDK runtime bundle has no ${name}`);
    const digest = createHash("sha256").update(file.source).digest("hex");
    if (digest !== file.sha256)
      throw new Error(`the SDK runtime ${name} does not match its digest`);
    out[name] = digest;
  }
  return out as Record<(typeof SDK_RUNTIME_FILES)[number], string>;
}

export interface RuntimeFile {
  name: string;
  data: Uint8Array;
  sha256: string;
}

/** Every staged file with its bytes and expected SHA-256, in name order. */
export function runtimeFiles(): RuntimeFile[] {
  const sdk = sdkRuntimeDigests();
  const agent = Buffer.from(OPERATION_AGENT_SOURCE, "utf8");
  if (createHash("sha256").update(agent).digest("hex") !== OPERATION_AGENT_SHA256) {
    throw new Error("the operation agent does not match its digest");
  }
  const files: RuntimeFile[] = [
    { name: "capybara-operation.py", data: agent, sha256: OPERATION_AGENT_SHA256 },
  ];
  for (const name of SDK_RUNTIME_FILES) {
    const file = SANDBOX_RUNTIME_SOURCE.files.find((f) => f.name === name);
    files.push({ name, data: Buffer.from(file?.source ?? "", "utf8"), sha256: sdk[name] });
  }
  return files.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** The `SHA256SUMS` file root checks (`sha256sum -c`) before installing, in name order. */
export function runtimeChecksums(): string {
  return runtimeFiles()
    .map((f) => `${f.sha256}  ${f.name}\n`)
    .join("");
}

// Declared after the staged files they are named by (module initialisation order).
/** This provider version's runtime directory (named after the digest of every staged file). */
export const RUNTIME_DIR = `${RUNTIME_BASE}/${createHash("sha256").update(runtimeChecksums()).digest("hex").slice(0, 16)}`;

/** The agent inside {@link RUNTIME_DIR}. */
export const OPERATION_AGENT = `${RUNTIME_DIR}/capybara-operation.py`;
