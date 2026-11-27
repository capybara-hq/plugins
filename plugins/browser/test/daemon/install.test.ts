import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  BrowserInstalledError,
  browserPaths,
  chromiumBuild,
  chromiumLaunchPlan,
  launchChromium,
} from "../../daemon/chromium.js";

// its own file: playwright-core reads its browsers directory once per test file's process
describe("chromium in the provider's install directory (plugins#209)", () => {
  it("installs into an unsealed install directory, seals it and never launches from it", async () => {
    // its own browsers directory: playwright-core reads it once per test file's process
    const dir = mkdtempSync(join(tmpdir(), "cbd-seal-"));
    try {
      const env = { CAPYBARA_SERVICE_INSTALL: dir };
      const { executable, marker } = await browserPaths(dir, chromiumBuild(process.platform, env));
      // something left a complete-looking "install" there (an older version, a compromised run)
      mkdirSync(dirname(executable), { recursive: true });
      writeFileSync(executable, "planted");
      writeFileSync(marker, "");
      // Playwright's installer (a download), stood in for: it is asked to install afresh
      const mod = (await import("playwright-core/lib/coreBundle")) as {
        registry?: { registry: { install: (...a: unknown[]) => Promise<void> } };
        default?: { registry: { registry: { install: (...a: unknown[]) => Promise<void> } } };
      };
      const registry = (mod.registry ?? mod.default?.registry)?.registry;
      if (registry === undefined) throw new Error("no registry");
      const log = console.log;
      const install = vi.spyOn(registry, "install").mockImplementation(async () => {
        // Playwright's progress line on stdout (no TTY): its total reaches the launch's hook
        console.log(
          "|                                                                                |   0% of 180.3 MiB",
        );
        writeFileSync(executable, "fresh");
        writeFileSync(marker, "");
      });
      const plan = chromiumLaunchPlan({
        stateDir: "/s",
        env,
        platform: process.platform,
      });
      const totals: number[] = [];
      await expect(
        launchChromium(plan, { onDownloadTotal: (b) => totals.push(b) }),
      ).rejects.toBeInstanceOf(BrowserInstalledError);
      expect(totals).toEqual([Math.round(180.3 * 1024 * 1024)]);
      expect(console.log).toBe(log);
      expect(install).toHaveBeenCalledWith(expect.anything(), { gc: false, force: true });
      expect(readFileSync(executable, "utf8")).toBe("fresh");
      expect(existsSync(join(dir, ".sealed"))).toBe(true);
      install.mockRestore();
      // sealed but incomplete: never installed into again (it is read only for the service)
      rmSync(executable);
      const sealed = chromiumLaunchPlan({
        stateDir: "/s",
        env,
        platform: process.platform,
      });
      expect(sealed.install).toEqual({ sealed: true });
      // the sealed install is the provider's: deleting the device would not help (the install may
      // be the machine's), updating capybara-device does
      await expect(launchChromium(sealed)).rejects.toThrow(
        /lacks the chromium(-headless-shell)? build it needs now.*update capybara-device/,
      );
      expect(existsSync(join(dir, "__dirlock"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
