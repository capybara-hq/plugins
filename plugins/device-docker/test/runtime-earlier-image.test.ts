import { describe, expect, it, vi } from "vitest";

// A host SDK right after a runtime promotion (core's "Changing the SDK runtime sources", step 3):
// `accepted` keeps the previous revision of each file for one revision. The digests stand for the
// bytes an earlier image of this provider staged.
const EARLIER_LAUNCHER = "1".repeat(64);
const EARLIER_HELPER = "2".repeat(64);
vi.mock("@capybara-hq/plugin-sdk", async (load) => {
  const sdk = await load<typeof import("@capybara-hq/plugin-sdk")>();
  const source = sdk.SANDBOX_RUNTIME_SOURCE;
  return {
    ...sdk,
    SANDBOX_RUNTIME_SOURCE: {
      ...source,
      accepted: {
        ...source.accepted,
        "linux-sandbox.py": [...(source.accepted["linux-sandbox.py"] ?? []), EARLIER_LAUNCHER],
        "native-files.py": [...(source.accepted["native-files.py"] ?? []), EARLIER_HELPER],
      },
    },
  };
});

const { sdkRuntimeDigests, stagedDigestProblem, STAGED_SDK_DIGESTS } = await import(
  "../src/runtime-source.js"
);

describe("an instance of an earlier image, on a host SDK that keeps the previous revision", () => {
  it("stays available while the host SDK accepts the launcher it staged", () => {
    expect(stagedDigestProblem("linux-sandbox.py", EARLIER_LAUNCHER)).toBeUndefined();
    expect(stagedDigestProblem("linux-sandbox.py", "3".repeat(64))).toBe(
      "The staged linux-sandbox.py does not match its digest",
    );
  });

  it("is unavailable with an earlier native helper: a file the agent runs must be the staged one", () => {
    expect(stagedDigestProblem("native-files.py", EARLIER_HELPER)).toBe(
      "The staged native-files.py does not match its digest",
    );
    // operations still expect exactly the helper this image stages
    expect(sdkRuntimeDigests()).toEqual({
      "native-files.py": STAGED_SDK_DIGESTS["native-files.py"],
    });
  });
});
