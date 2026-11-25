import { describe, expect, it } from "vitest";
import { parseManagerReply, serviceFilesDigest } from "../src/services.js";

/**
 * The SDK's pinned digest vector (`DEVICE_SERVICE_FILES_DIGEST_VECTOR`, capybara-hq/core#879),
 * copied until this package's SDK range includes it: the manager's digest, prefixed `sha256:`, is
 * the `filesDigest` the kernel compares with its own; one that disagreed would roll the service at
 * every ensure.
 */
const VECTOR = {
  files: { "main.js": "console.log(1)\n", "lib/a.js": "export const a = 1;\n", empty: "" },
  digest: "sha256:7b3959ff2e10237b9f1a255bbecb5dacebd31422fe734b2867403e42913432a5",
};

const reply = (o: Record<string, unknown>) => ({
  exitCode: 0,
  stdout: `${JSON.stringify(o)}\n`,
  stderr: "",
});

describe("service files digest", () => {
  it("matches the SDK's pinned vector", () => {
    const files = Object.fromEntries(
      Object.entries(VECTOR.files).map(([k, v]) => [k, new TextEncoder().encode(v)]),
    );
    expect(`sha256:${serviceFilesDigest(files).digest}`).toBe(VECTOR.digest);
  });

  it("passes a running service's files digest on, and nothing malformed", () => {
    const base = { name: "tx.echo", state: "running", startedAt: "t", stateDir: "/s" };
    expect(parseManagerReply("tx.echo", reply({ ...base, filesDigest: VECTOR.digest }))).toEqual({
      ...base,
      filesDigest: VECTOR.digest,
    });
    for (const bad of ["sha256:xyz", 7, `${VECTOR.digest}\n`])
      expect(parseManagerReply("tx.echo", reply({ ...base, filesDigest: bad }))).toEqual(base);
    expect(
      parseManagerReply(
        "tx.echo",
        reply({ ...base, state: "stopped", startedAt: null, filesDigest: VECTOR.digest }),
      ),
    ).toEqual({ ...base, state: "stopped", startedAt: null });
  });
});
