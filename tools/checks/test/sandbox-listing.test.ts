import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The sandbox plugins share no code package, so their list / scan script is duplicated: the two
// copies must stay byte for byte the same (src/listing.ts says so in its header).
const read = (rel: string) =>
  readFileSync(fileURLToPath(new URL(`../../../${rel}`, import.meta.url)));

describe("sandbox list / scan script", () => {
  it("is the same file in sandbox-docker and sandbox-e2b", () => {
    const docker = read("plugins/sandbox-docker/src/listing.ts");
    const e2b = read("plugins/sandbox-e2b/src/listing.ts");
    expect(docker.length).toBeGreaterThan(0);
    expect(e2b.equals(docker)).toBe(true);
  });
});
