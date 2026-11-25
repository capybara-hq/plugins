import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The sandbox image (device-docker, also the E2B template) ships the browser plugin's Chromium in
 * /opt/capybara-browsers, read only for device services (plugins#209): its PLAYWRIGHT_VERSION must
 * be the browser plugin's playwright-core, or the daemon finds no headless shell of its revision
 * there and falls back to installing one into its writable state directory. A plugin's tests may
 * not read another plugin's files, so the comparison lives here, at the repository level.
 */
const read = (path: string) =>
  readFileSync(fileURLToPath(new URL(`../../../${path}`, import.meta.url)), "utf8");

describe("pinned browser in the sandbox image", () => {
  it("matches the browser plugin's playwright-core", () => {
    const pinned = /^ARG PLAYWRIGHT_VERSION=(\S+)$/m.exec(
      read("plugins/device-docker/image/Dockerfile"),
    )?.[1];
    const pkg = JSON.parse(read("plugins/browser/package.json")) as {
      devDependencies?: Record<string, string>;
    };
    expect(pinned).toBeDefined();
    expect(pkg.devDependencies?.["playwright-core"]).toBe(pinned);
  });
});
