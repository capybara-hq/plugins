import { createHash } from "node:crypto";
import { SANDBOX_RUNTIME_SOURCE } from "@capybara-hq/plugin-sdk";

/**
 * The operation runtime staged in the sandbox image (`image/runtime`, copied root-owned to
 * {@link RUNTIME_DIR} by the Dockerfile, which checks `SHA256SUMS` at build time):
 *
 * - `native-files.py` and `linux-sandbox.py`: the SDK's `SANDBOX_RUNTIME_SOURCE` bytes, unchanged
 *   (the native helper; the launcher is staged with its bundle but never run: the container is the
 *   sandbox, and the agent refuses restricted requests);
 * - `capybara-operation.py`: this provider's trusted consumer (admission records, the native
 *   helper on `/`, the whole-instance exec admission, background supervision).
 *
 * `test/permission-scopes.test.ts` asserts the staged copies equal the SDK bytes and these digests.
 */
export const RUNTIME_DIR = "/opt/capybara-runtime";

/** The provider's consumer script inside {@link RUNTIME_DIR}. */
export const OPERATION_AGENT = `${RUNTIME_DIR}/capybara-operation.py`;

/** SHA-256 of `image/runtime/capybara-operation.py` (asserted by the tests). */
export const OPERATION_AGENT_SHA256 =
  "0459ca268c00950cfaf0838a9d505dc25d40b0b5b1e23ca6a042804b6c48417a";

/** The SDK bundle version the staged files come from. */
export const RUNTIME_BUNDLE_VERSION = 2;

/** The SDK files the provider stages, by name. */
// capybara:allow-module-state read-only list of staged file names, never mutated
export const SDK_RUNTIME_FILES = Object.freeze(["native-files.py", "linux-sandbox.py"] as const);

/**
 * The SDK digests of the staged files, checked against the bundle's own bytes: a bundle whose
 * version, file set or bytes differ from what this provider stages makes restricted support
 * unavailable rather than running different code than was reviewed.
 */
export function sdkRuntimeDigests(): Record<(typeof SDK_RUNTIME_FILES)[number], string> {
  if (SANDBOX_RUNTIME_SOURCE.version !== RUNTIME_BUNDLE_VERSION) {
    throw new Error(
      `device-docker stages runtime bundle v${RUNTIME_BUNDLE_VERSION}, the SDK has v${SANDBOX_RUNTIME_SOURCE.version}`,
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

/** Every staged file and its expected SHA-256 (the image's `SHA256SUMS`). */
export function stagedRuntimeDigests(): Record<string, string> {
  return { ...sdkRuntimeDigests(), "capybara-operation.py": OPERATION_AGENT_SHA256 };
}

/** The `SHA256SUMS` file the Dockerfile checks (`sha256sum -c`), in name order. */
export function runtimeChecksums(): string {
  return Object.entries(stagedRuntimeDigests())
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, digest]) => `${digest}  ${name}\n`)
    .join("");
}
