import { SANDBOX_RUNTIME_SOURCE } from "@capybara-hq/plugin-sdk";

/**
 * The operation runtime staged in the sandbox image (`image/runtime`, copied root-owned to
 * {@link RUNTIME_DIR} by the Dockerfile, which checks `SHA256SUMS` at build time):
 *
 * - `native-files.py` and `linux-sandbox.py`: the SDK's `SANDBOX_RUNTIME_SOURCE.current` bytes,
 *   unchanged, as of the SDK release this provider was restaged from ({@link STAGED_SDK_DIGESTS}).
 *   The native helper runs; the launcher is staged with its bundle but never run (the container is
 *   the sandbox, and the agent refuses restricted requests);
 * - `capybara-operation.py`: this provider's trusted consumer (admission records, the native
 *   helper on `/`, the whole-instance exec admission, background supervision).
 *
 * The image is built in this repository while the host SDK moves with the kernel, so staged copies
 * are checked against the host SDK's `SANDBOX_RUNTIME_SOURCE.accepted` (by name, every digest a
 * staged copy may have: its staged set, its current bytes and at most one previous revision),
 * never against one exact digest: an instance made from an earlier image of this provider stays
 * available while the host SDK still accepts the launcher it staged (a file the agent runs,
 * `native-files.py`, must be exactly the one operations expect), and a host SDK without `accepted`
 * (older than this provider supports) makes restricted support unavailable. Changing these files
 * follows core's "Changing the SDK runtime sources" (tools/checks/README.md in capybara-hq/core).
 *
 * `test/permission-scopes.test.ts` asserts the staged copies equal the SDK's `current` bytes and
 * these digests.
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
type SdkRuntimeFile = (typeof SDK_RUNTIME_FILES)[number];

/** The SDK files the agent runs, so every operation checks their staged digests. */
// capybara:allow-module-state read-only list of file names, never mutated
const RUN_FILES = Object.freeze(["native-files.py"] as const);

/**
 * SHA-256 of the SDK files staged in `image/runtime` (the SDK's `current` when this provider was
 * restaged; asserted by the tests against the installed SDK and the image's files).
 */
// capybara:allow-module-state read-only digests of the staged files, never mutated
export const STAGED_SDK_DIGESTS: Readonly<Record<SdkRuntimeFile, string>> = Object.freeze({
  "native-files.py": "c1712198af4ffedc0b48f789c28ed4233dc9008521b897300731c4f903168950",
  "linux-sandbox.py": "ceb5bb0971437978a7695091792bfafcf3dbf2e7c74e8425d8aceb76e442f848",
});

/**
 * By staged file name, the digests the host SDK accepts for a staged copy, or a reason why
 * restricted support is unavailable: an SDK bundle of another version, or one without
 * `accepted` (older than this provider supports).
 */
export function acceptedRuntimeDigests():
  | { ok: true; accepted: Readonly<Record<SdkRuntimeFile, readonly string[]>> }
  | { ok: false; reason: string } {
  if (SANDBOX_RUNTIME_SOURCE.version !== RUNTIME_BUNDLE_VERSION) {
    return {
      ok: false,
      reason: `device-docker stages runtime bundle v${RUNTIME_BUNDLE_VERSION}, the SDK has v${SANDBOX_RUNTIME_SOURCE.version}`,
    };
  }
  const listed = (SANDBOX_RUNTIME_SOURCE as { accepted?: Readonly<Record<string, unknown>> })
    .accepted;
  if (listed === undefined || listed === null || typeof listed !== "object") {
    return {
      ok: false,
      reason: "The kernel's plugin SDK lists no accepted runtime digests; upgrade the kernel",
    };
  }
  const out: Partial<Record<SdkRuntimeFile, readonly string[]>> = {};
  for (const name of SDK_RUNTIME_FILES) {
    const digests = listed[name];
    if (
      !Array.isArray(digests) ||
      !digests.every((d) => typeof d === "string" && /^[0-9a-f]{64}$/.test(d))
    ) {
      return { ok: false, reason: `The kernel's plugin SDK lists no accepted digests for ${name}` };
    }
    out[name] = digests;
  }
  return { ok: true, accepted: out as Record<SdkRuntimeFile, readonly string[]> };
}

/**
 * The digests every operation sends the agent (`expect`): the SDK files the agent runs, as this
 * image stages them, each one the host SDK accepts. The launcher is not among them: it is never
 * run, and an instance made from an earlier image keeps the launcher it staged. Throws when the
 * host SDK does not accept the staged bytes: no operation runs code the kernel's SDK disowns.
 */
export function sdkRuntimeDigests(): Record<string, string> {
  const accepted = acceptedRuntimeDigests();
  if (!accepted.ok) throw new Error(accepted.reason);
  const out: Record<string, string> = {};
  for (const name of RUN_FILES) {
    const digest = STAGED_SDK_DIGESTS[name];
    if (!accepted.accepted[name].includes(digest))
      throw new Error(`The kernel's plugin SDK does not accept the staged ${name}`);
    out[name] = digest;
  }
  return out;
}

/** Every staged file and its SHA-256 as this image stages it (the image's `SHA256SUMS`). */
export function stagedRuntimeDigests(): Record<string, string> {
  return { ...STAGED_SDK_DIGESTS, "capybara-operation.py": OPERATION_AGENT_SHA256 };
}

/**
 * Whether one staged file's digest (as an instance reports it) may be used: the provider's own
 * consumer exactly, an SDK file when the host SDK accepts it; otherwise why not.
 */
export function stagedDigestProblem(name: string, digest: string): string | undefined {
  if (name === "capybara-operation.py")
    return digest === OPERATION_AGENT_SHA256
      ? undefined
      : `The staged ${name} does not match its digest`;
  const accepted = acceptedRuntimeDigests();
  if (!accepted.ok) return accepted.reason;
  const list = (accepted.accepted as Record<string, readonly string[] | undefined>)[name];
  if (!list) return `The staged ${name} is not part of the runtime`;
  if (!list.includes(digest)) return `The staged ${name} does not match its digest`;
  // a file the agent runs must be the one every operation expects
  if (
    (RUN_FILES as readonly string[]).includes(name) &&
    digest !== STAGED_SDK_DIGESTS[name as SdkRuntimeFile]
  )
    return `The staged ${name} does not match its digest`;
  return undefined;
}

/** The `SHA256SUMS` file the Dockerfile checks (`sha256sum -c`), in name order. */
export function runtimeChecksums(): string {
  return Object.entries(stagedRuntimeDigests())
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, digest]) => `${digest}  ${name}\n`)
    .join("");
}
