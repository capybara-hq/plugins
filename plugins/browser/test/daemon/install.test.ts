import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BrowserInstalledError,
  browserPaths,
  chromiumLaunchPlan,
  launchChromium,
} from "../../daemon/chromium.js";

// its own file: playwright-core reads its browsers directory once per test file's process
describe("chromium in the provider's install directory (plugins#209)", () => {
  it("installs into an unsealed install directory, seals it and never launches from it", async () => {
    // its own browsers directory: playwright-core reads it once per test file's process
    const dir = mkdtempSync(join(tmpdir(), "cbd-seal-"));
    try {
      const { executable, marker } = await browserPaths(dir);
      // installed already (the download itself is Playwright's): only the seal is new
      mkdirSync(dirname(executable), { recursive: true });
      writeFileSync(executable, "");
      writeFileSync(marker, "");
      const plan = chromiumLaunchPlan({
        stateDir: "/s",
        env: { CAPYBARA_SERVICE_INSTALL: dir },
        platform: process.platform,
      });
      await expect(launchChromium(plan)).rejects.toBeInstanceOf(BrowserInstalledError);
      expect(existsSync(join(dir, ".sealed"))).toBe(true);
      // sealed but incomplete: never installed into again (it is read only for the service)
      rmSync(executable);
      const sealed = chromiumLaunchPlan({
        stateDir: "/s",
        env: { CAPYBARA_SERVICE_INSTALL: dir },
        platform: process.platform,
      });
      expect(sealed.install).toEqual({ sealed: true });
      await expect(launchChromium(sealed)).rejects.toThrow(/incomplete and read only/);
      expect(existsSync(join(dir, "__dirlock"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
