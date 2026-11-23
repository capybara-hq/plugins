import { describe, expect, it, vi } from "vitest";

// A host SDK older than this provider supports: the runtime bundle without `accepted`.
vi.mock("@capybara-hq/plugin-sdk", async (load) => {
  const sdk = await load<typeof import("@capybara-hq/plugin-sdk")>();
  const { accepted: _accepted, ...older } = sdk.SANDBOX_RUNTIME_SOURCE;
  return { ...sdk, SANDBOX_RUNTIME_SOURCE: older };
});

const { acceptedRuntimeDigests, sdkRuntimeDigests, stagedDigestProblem, STAGED_SDK_DIGESTS } =
  await import("../src/runtime-source.js");

describe("a host SDK without accepted runtime digests", () => {
  it("makes restricted support unavailable and runs no operation", () => {
    const got = acceptedRuntimeDigests();
    expect(got).toEqual({
      ok: false,
      reason: "The kernel's plugin SDK lists no accepted runtime digests; upgrade the kernel",
    });
    expect(() => sdkRuntimeDigests()).toThrow(/no accepted runtime digests/);
    expect(stagedDigestProblem("native-files.py", STAGED_SDK_DIGESTS["native-files.py"])).toMatch(
      /no accepted runtime digests/,
    );
  });
});
