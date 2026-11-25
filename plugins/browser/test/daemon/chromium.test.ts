import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BROWSER_UNAVAILABLE_MESSAGE,
  browserPaths,
  browserRevision,
  chromeUserAgent,
  chromiumLaunchPlan,
  ensureChromium,
  MAX_REVISION_SKEW,
  playwrightDownloadHosts,
  shippedRevisionNote,
} from "../../daemon/chromium.js";

/** The features Playwright's own launch disables (read from the playwright-core it ships). */
function playwrightDisabledFeatures(): string[] {
  const require = createRequire(import.meta.url);
  const bundle = readFileSync(
    join(dirname(require.resolve("playwright-core/package.json")), "lib", "coreBundle.js"),
    "utf8",
  );
  const list = /disabledFeatures = \[([\s\S]*?)\]/.exec(bundle)?.[1] ?? "";
  return [...list.matchAll(/^\s*"([A-Za-z0-9]+)",?\s*$/gm)].map((m) => m[1] ?? "");
}

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

  it("runs the full Chromium in new headless mode as an ordinary Chrome on Linux", () => {
    const plan = chromiumLaunchPlan(
      { stateDir: "/s", env: {}, platform: "linux" },
      { revision: "1255", version: "159.0.8154.6" },
    );
    expect(plan.build).toBe("chromium");
    expect(plan.args).toEqual(
      expect.arrayContaining([
        "--headless",
        "--window-size=1280,800",
        "--user-agent=Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/159.0.0.0 Safari/537.36",
      ]),
    );
    expect(plan.args.join(" ")).not.toMatch(/HeadlessChrome|--single-process/);
  });

  it("names the browser Chrome of its version on its platform, never HeadlessChrome", () => {
    expect(chromeUserAgent("darwin", "159.0.8154.6")).toBe(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/159.0.0.0 Safari/537.36",
    );
  });

  it("runs the headless shell in one process with the mock keychain on macOS", () => {
    const plan = chromiumLaunchPlan({ stateDir: "/s", env: {}, platform: "darwin" });
    expect(plan.build).toBe("chromium-headless-shell");
    expect(plan.args).toEqual(expect.arrayContaining(["--single-process", "--use-mock-keychain"]));
    expect(plan.args.some((a) => a.startsWith("--proxy-server"))).toBe(false);
  });

  it("disables the ACCEPT_CH frame and keeps every feature Playwright disables", () => {
    // Chromium takes only the last --disable-features flag, and Playwright passes its own first:
    // ours must carry Playwright's list as well. The ACCEPT_CH frame restarts a request on its
    // connection (www.google.com sends it), and under Playwright's proxy-credential interception
    // the restarted navigation is lost: it hangs at about:blank until the timeout.
    const plan = chromiumLaunchPlan({ stateDir: "/s", env: {}, platform: "darwin" });
    const flags = plan.args.filter((a) => a.startsWith("--disable-features="));
    expect(flags).toHaveLength(1);
    const features = (flags[0] ?? "").slice("--disable-features=".length).split(",");
    expect(features).toContain("AcceptCHFrame");
    const playwright = playwrightDisabledFeatures();
    expect(playwright.length).toBeGreaterThan(5);
    expect(features).toEqual(expect.arrayContaining(playwright));
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
  it("prefers a read-only PLAYWRIGHT_BROWSERS_PATH that already holds this revision's headless shell", () => {
    const cache = mkdtempSync(join(tmpdir(), "cbd-cache-"));
    try {
      const env = { PLAYWRIGHT_BROWSERS_PATH: cache };
      const plan = () => chromiumLaunchPlan({ stateDir: "/s", env, platform: "linux" });
      // empty: no read-only browser, and none is installed where the service could rewrite it
      expect(plan()).toMatchObject({ unavailable: BROWSER_UNAVAILABLE_MESSAGE });
      const rev = browserRevision("chromium");
      expect(rev).toMatch(/^\d+$/);
      mkdirSync(join(cache, "chromium-1"));
      mkdirSync(join(cache, `chromium-${rev}`));
      // writable by this process: something it (or an agent command) could replace, never used
      expect(plan()).toMatchObject({ unavailable: BROWSER_UNAVAILABLE_MESSAGE });
      chmodSync(cache, 0o555);
      expect(
        chromiumLaunchPlan(
          { stateDir: "/s", env, platform: "linux" },
          { revision: "1", version: "1" },
        ),
      ).toMatchObject({
        browsersPath: cache,
        shipped: true,
      });
      // another revision near this build's: the newest such one shipped runs (read only)
      expect(
        chromiumLaunchPlan(
          { stateDir: "/s", env, platform: "linux" },
          { revision: "2", version: "2" },
        ),
      ).toMatchObject({ browsersPath: cache, shipped: true, shippedDir: "chromium-1" });
      // one further than MAX_REVISION_SKEW away: an outdated (or too new) browser never runs
      expect(
        chromiumLaunchPlan(
          { stateDir: "/s", env, platform: "linux" },
          { revision: String(Number(rev) + MAX_REVISION_SKEW + 1), version: "1" },
        ),
      ).toMatchObject({ unavailable: BROWSER_UNAVAILABLE_MESSAGE });
      expect(shippedRevisionNote("chromium-1", "2")).toMatch(
        /runs chromium-1 from the device image, not revision 2/,
      );
      // this build's revision, read from playwright-core
      expect(plan().browsersPath).toBe(cache);
      // a cache in the workspace is the agent's, never trusted
      expect(
        chromiumLaunchPlan({
          stateDir: "/s",
          env: { ...env, CAPYBARA_SERVICE_WORKSPACE: dirname(cache) },
          platform: "linux",
        }).browsersPath,
      ).toBe("/s/browsers");
    } finally {
      chmodSync(cache, 0o755);
      rmSync(cache, { recursive: true, force: true });
    }
  });

  it("uses the provider's install directory, sealed once a regular seal file is there", () => {
    const install = mkdtempSync(join(tmpdir(), "cbd-install-dir-"));
    try {
      const env = { CAPYBARA_SERVICE_INSTALL: install, PLAYWRIGHT_BROWSERS_PATH: "/opt/x" };
      const plan = () => chromiumLaunchPlan({ stateDir: "/s", env, platform: "darwin" });
      expect(plan()).toMatchObject({ browsersPath: install, install: { sealed: false } });
      // a link is no seal
      writeFileSync(join(install, "elsewhere"), "");
      symlinkSync(join(install, "elsewhere"), join(install, ".sealed"));
      expect(plan().install).toEqual({ sealed: false });
      rmSync(join(install, ".sealed"));
      writeFileSync(join(install, ".sealed"), "");
      expect(plan().install).toEqual({ sealed: true });
    } finally {
      rmSync(install, { recursive: true, force: true });
    }
  });

  it("names Playwright's download hosts, or the configured one", () => {
    expect(playwrightDownloadHosts({})).toEqual([
      "cdn.playwright.dev",
      "playwright.download.prss.microsoft.com",
      "storage.googleapis.com",
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
      const { executable, marker } = await browserPaths(dir);
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
