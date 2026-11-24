import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  chromiumLaunchPlan,
  ensureChromium,
  headlessShellPaths,
  headlessShellRevision,
  playwrightDownloadHosts,
} from "../../daemon/chromium.js";

describe("chromium launch plan", () => {
  it("keeps the profile and browsers in the state directory and passes the proxy", () => {
    const plan = chromiumLaunchPlan({
      stateDir: "/s",
      env: { https_proxy: "http://egress:3128", NO_PROXY: "a.test,b.test" },
      platform: "linux",
    });
    expect(plan.profileDir).toBe("/s/profile");
    expect(plan.browsersPath).toBe("/s/browsers");
    expect(plan.args).toContain("--proxy-server=http://egress:3128");
    expect(plan.args).toContain("--proxy-bypass-list=a.test;b.test");
    expect(plan.args).not.toContain("--single-process");
    expect(plan.args.some((a) => a.startsWith("--remote-debugging-port"))).toBe(false);
  });

  it("runs the headless shell in one process with the mock keychain on macOS", () => {
    const plan = chromiumLaunchPlan({ stateDir: "/s", env: {}, platform: "darwin" });
    expect(plan.args).toEqual(expect.arrayContaining(["--single-process", "--use-mock-keychain"]));
    expect(plan.args.some((a) => a.startsWith("--proxy-server"))).toBe(false);
  });

  it("gives proxy credentials to Playwright, not to the flag", () => {
    const plan = chromiumLaunchPlan({
      stateDir: "/s",
      env: { HTTPS_PROXY: "http://u%40x:p%3Aw@egress:3128" },
      platform: "linux",
    });
    expect(plan.args.some((a) => a.startsWith("--proxy-server"))).toBe(false);
    expect(plan.proxyAuth).toEqual({
      server: "http://egress:3128",
      username: "u@x",
      password: "p:w",
    });
  });
});

describe("chromium browsers directory", () => {
  it("prefers a PLAYWRIGHT_BROWSERS_PATH that already holds this revision's headless shell", () => {
    const cache = mkdtempSync(join(tmpdir(), "cbd-cache-"));
    try {
      const env = { PLAYWRIGHT_BROWSERS_PATH: cache };
      const plan = () => chromiumLaunchPlan({ stateDir: "/s", env, platform: "linux" });
      // empty: the state directory's own download
      expect(plan().browsersPath).toBe("/s/browsers");
      mkdirSync(join(cache, "chromium_headless_shell-1"));
      expect(chromiumLaunchPlan({ stateDir: "/s", env, platform: "linux" }, "1").browsersPath).toBe(
        cache,
      );
      // another revision: not usable, so not used
      expect(chromiumLaunchPlan({ stateDir: "/s", env, platform: "linux" }, "2").browsersPath).toBe(
        "/s/browsers",
      );
      // this build's revision, read from playwright-core
      const rev = headlessShellRevision();
      expect(rev).toMatch(/^\d+$/);
      mkdirSync(join(cache, `chromium_headless_shell-${rev}`));
      expect(plan().browsersPath).toBe(cache);
    } finally {
      rmSync(cache, { recursive: true, force: true });
    }
  });

  it("names Playwright's download hosts, or the configured one", () => {
    expect(playwrightDownloadHosts({})).toEqual([
      "cdn.playwright.dev",
      "playwright.download.prss.microsoft.com",
    ]);
    expect(
      playwrightDownloadHosts({ PLAYWRIGHT_DOWNLOAD_HOST: "https://mirror.example.com/pw" }),
    ).toEqual(["mirror.example.com"]);
  });
});

describe("chromium install", () => {
  it("takes a headless shell as installed only with Playwright's marker, never its half-written files", async () => {
    // its own browsers directory: playwright-core reads it once per test file's process
    const dir = mkdtempSync(join(tmpdir(), "cbd-install-"));
    try {
      const { executable, marker } = await headlessShellPaths(dir);
      // another daemon mid-install: it holds the registry's lock and has written the executable,
      // not yet the rest nor the marker
      mkdirSync(dirname(executable), { recursive: true });
      writeFileSync(executable, "");
      mkdirSync(join(dir, "__dirlock"));
      const ensured = ensureChromium(dir).then((path) => ({ path, marker: existsSync(marker) }));
      // that install finishes
      await new Promise((r) => setImmediate(r));
      writeFileSync(marker, "");
      rmSync(join(dir, "__dirlock"), { recursive: true });
      expect(await ensured).toEqual({ path: executable, marker: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
