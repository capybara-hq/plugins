import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * device-docker and device-e2b share their device services code (the service manager, the socket
 * relay and the relay stream) as one file kept identical in both plugins: a plugin's tests may not
 * import another plugin's files, so the comparison lives here, at the repository level.
 */
const servicesOf = (plugin: string) =>
  readFileSync(
    fileURLToPath(new URL(`../../../plugins/${plugin}/src/services.ts`, import.meta.url)),
    "utf8",
  );

describe("shared device services code", () => {
  it("device-docker and device-e2b have the same src/services.ts, byte for byte", () => {
    expect(servicesOf("device-e2b")).toBe(servicesOf("device-docker"));
  });
});
