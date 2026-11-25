/// <reference path="./playwright-registry.d.ts" />
// Chromium for the daemon (spec §5), launched with the profile `<state>/profile`
// (launchPersistentContext, the only way Playwright takes a user data directory) over a CDP pipe,
// never a debugging port. Where it comes from (capybara-hq/plugins#209: never from a place the
// service, or an agent command, could write once the browser runs), in this order:
// - the provider's install directory (CAPYBARA_SERVICE_INSTALL, device-local): installed there
//   through playwright-core's registry on the first start, sealed, and the daemon restarts, so
//   every later start runs it read only;
// - a browsers cache the device ships (PLAYWRIGHT_BROWSERS_PATH: device-docker / device-e2b's
//   image) that this process cannot write and that lies outside the workspace: this build's
//   revision, else the newest revision of the same build there (an image pinned to another
//   playwright-core release: the browser still runs, read only);
// - else nothing: the launch fails with BROWSER_UNAVAILABLE_MESSAGE (never a browser installed
//   where the service could rewrite it).

import {
  accessSync,
  constants,
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { DEVICE_SERVICE_MACH_CHROMIUM, DEVICE_SERVICE_MACH_ENV } from "@capybara-hq/plugin-sdk";
import type { BrowserContext } from "playwright-core";
import { VIEWPORT } from "./protocol.js";

/**
 * The Chromium build the daemon runs: the full Chromium in its (new) headless mode, so the
 * browser presents as an ordinary Chrome. On macOS only where the device says its sandbox lets
 * the full build start ({@link SERVICE_MACH_ENV} = `chromium`: a capybara-device with
 * capybara-hq/core#843); elsewhere on macOS the headless shell in one process, which an older
 * capybara-device runs (and nothing larger is downloaded before that is known).
 */
export type ChromiumBuild = "chromium" | "chromium-headless-shell";

/** Names the Mach allowances of the service's sandbox. */
export const SERVICE_MACH_ENV = DEVICE_SERVICE_MACH_ENV;

/** The note a tool result carries while macOS runs the headless shell (an older capybara-device). */
export const HEADLESS_SHELL_NOTE =
  "The browser runs as a headless shell, which sites flag as a bot more often: the machine's capybara-device predates the full browser; ask the user to update capybara-device on that machine.";

/** The build for a platform and the service's environment ({@link ChromiumBuild}). */
export function chromiumBuild(
  platform: NodeJS.Platform,
  env: Record<string, string | undefined> = process.env,
): ChromiumBuild {
  if (platform !== "darwin") return "chromium";
  return env[SERVICE_MACH_ENV] === DEVICE_SERVICE_MACH_CHROMIUM
    ? "chromium"
    : "chromium-headless-shell";
}

/** A build's directory name in a browsers directory, before `-<revision>`. */
export const BUILD_DIR: Record<ChromiumBuild, string> = {
  chromium: "chromium",
  "chromium-headless-shell": "chromium_headless_shell",
};

export interface LaunchPlan {
  browsersPath: string;
  build: ChromiumBuild;
  /** Extra environment of the browser process (macOS: its temporary directory). */
  env?: Record<string, string>;
  /**
   * The browsers are the provider's install directory: installed and sealed on the first start
   * (`sealed` false; the launch then fails with {@link BrowserInstalledError} and the daemon
   * restarts), launched read only once sealed. Absent: never installed into anything but the
   * state directory.
   */
  install?: { sealed: boolean };
  /** The browsers are a read-only cache the device ships: launched, never installed into. */
  shipped?: boolean;
  /**
   * The shipped cache's revision directory when it is not this build's revision (an image pinned
   * to another playwright-core release): its executable is launched by path.
   */
  shippedDir?: string;
  /** No read-only place for the browser: the launch fails with this text. */
  unavailable?: string;
  profileDir: string;
  /** Where Chromium writes downloads in progress (saved into the workspace when done). */
  downloadsTmp: string;
  /** Extra Chromium flags (Playwright adds --headless and --remote-debugging-pipe itself). */
  args: string[];
  /** The proxy Chromium uses, when the device's environment names one (credentials included). */
  proxy: string | undefined;
  /**
   * A proxy whose URL carries credentials: given to Playwright's `proxy` option instead of the
   * --proxy-server flag (Chromium takes no credentials in the flag; Playwright answers the
   * proxy's auth challenge).
   */
  proxyAuth?: { server: string; username: string; password: string; bypass?: string };
}

function envValue(env: Record<string, string | undefined>, name: string): string | undefined {
  const v = env[name] ?? env[name.toLowerCase()];
  return v === undefined || v === "" ? undefined : v;
}

/**
 * The revision and version of a Chromium build this build's playwright-core installs (its
 * browsers.json): next to the bundle (`vendor/playwright-core/`), else the installed package.
 */
export function browserRelease(
  build: ChromiumBuild,
): { revision: string; version: string } | undefined {
  const candidates = [new URL("./vendor/playwright-core/browsers.json", import.meta.url)];
  try {
    const pkg = createRequire(import.meta.url).resolve("playwright-core/package.json");
    candidates.push(new URL(`file://${join(dirname(pkg), "browsers.json")}`));
  } catch {
    // not installed beside the source either
  }
  for (const file of candidates) {
    try {
      const json = JSON.parse(readFileSync(fileURLToPath(file), "utf8")) as {
        browsers?: { name?: unknown; revision?: unknown; browserVersion?: unknown }[];
      };
      const b = json.browsers?.find((x) => x.name === build);
      if (typeof b?.revision === "string" && b.revision !== "")
        return {
          revision: b.revision,
          version: typeof b.browserVersion === "string" ? b.browserVersion : "",
        };
    } catch {
      // try the next one
    }
  }
  return undefined;
}

/** The revision of a build ({@link browserRelease}). */
export function browserRevision(build: ChromiumBuild): string | undefined {
  return browserRelease(build)?.revision;
}

/**
 * The browser's user agent: Chrome's own reduced user agent for the platform (the form every
 * Chrome sends since the user agent reduction: frozen OS part, `<major>.0.0.0`), so headless mode
 * does not announce itself as "HeadlessChrome". It is the browser's true identity (Chromium of
 * that version on that platform); the client hints (UA-CH) stay the browser's own.
 */
export function chromeUserAgent(platform: NodeJS.Platform, version: string): string {
  const major = /^\d+/.exec(version)?.[0] ?? "0";
  const os =
    platform === "darwin"
      ? "Macintosh; Intel Mac OS X 10_15_7"
      : platform === "win32"
        ? "Windows NT 10.0; Win64; x64"
        : "X11; Linux x86_64";
  return `Mozilla/5.0 (${os}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}

/**
 * The hosts Playwright downloads Chromium from: the configured mirror
 * (PLAYWRIGHT_CHROMIUM_DOWNLOAD_HOST / PLAYWRIGHT_DOWNLOAD_HOST), else its CDN and fallback. A
 * device whose network refuses them cannot install the browser; the daemon reports them as
 * blocked hosts, so the person is asked to allow them.
 */
export function playwrightDownloadHosts(env: Record<string, string | undefined>): string[] {
  const custom =
    envValue(env, "PLAYWRIGHT_CHROMIUM_DOWNLOAD_HOST") ?? envValue(env, "PLAYWRIGHT_DOWNLOAD_HOST");
  if (custom !== undefined) {
    try {
      return [new URL(custom.includes("://") ? custom : `https://${custom}`).hostname];
    } catch {
      return [];
    }
  }
  // the CDN redirects Chrome for Testing builds (the headless shell) to Google's storage
  return ["cdn.playwright.dev", "playwright.download.prss.microsoft.com", "storage.googleapis.com"];
}

/**
 * How far (in Playwright browser revisions, one per Chromium roll) a shipped browser may be from
 * this build's own and still run: about two months of rolls.
 */
export const MAX_REVISION_SKEW = 10;

/** The note a tool result carries while the browser runs a shipped revision not its own. */
export function shippedRevisionNote(dir: string, revision: string | undefined): string {
  return `The browser runs ${dir} from the device image, not ${revision === undefined ? "this plugin's" : `revision ${revision}`}: ask the user to recreate the device on the current image when convenient.`;
}

/** Why the browser cannot start when the device offers no read-only place for it. */
export const BROWSER_UNAVAILABLE_MESSAGE =
  "This device offers the browser no place it cannot rewrite: on a local device, update capybara-device on that machine; on a cloud device, its image predates the pinned browser, so ask the user to delete the device and create it again (or wait until it is recreated after a period without use).";

/** Names the provider's install directory (the SDK's DEVICE_SERVICE_INSTALL_ENV). */
export const SERVICE_INSTALL_ENV = "CAPYBARA_SERVICE_INSTALL";
/** The file that seals it (the SDK's DEVICE_SERVICE_INSTALL_SEAL). */
export const SERVICE_INSTALL_SEAL = ".sealed";

/** The first start installed the browser and sealed the install: the daemon restarts to run it. */
export class BrowserInstalledError extends Error {
  constructor() {
    super("The browser was installed; the browser service restarts to run it read only.");
    this.name = "BrowserInstalledError";
  }
}

/** Whether `dir` lies inside (or is) `root`. */
function inside(dir: string, root: string): boolean {
  const rel = relative(root, dir);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** Whether this process cannot write `dir` (a read-only cache of the device). */
function readOnlyForUs(dir: string): boolean {
  try {
    accessSync(dir, constants.W_OK);
    return false;
  } catch {
    return true;
  }
}

/**
 * Where the browsers live (see the file comment): the provider's install directory; a
 * PLAYWRIGHT_BROWSERS_PATH this process cannot write, outside the workspace, holding this
 * revision's headless shell; else the state directory.
 */
function browsersPathFor(
  stateDir: string,
  env: Record<string, string | undefined>,
  revision: string | undefined,
  build: ChromiumBuild,
): Pick<LaunchPlan, "browsersPath" | "install" | "shipped" | "shippedDir" | "unavailable"> {
  const install = envValue(env, SERVICE_INSTALL_ENV);
  if (install !== undefined && isAbsolute(install)) {
    let sealed = false;
    try {
      sealed = lstatSync(join(install, SERVICE_INSTALL_SEAL)).isFile();
    } catch {
      sealed = false;
    }
    return { browsersPath: install, install: { sealed } };
  }
  const cache = envValue(env, "PLAYWRIGHT_BROWSERS_PATH");
  const workspace = envValue(env, "CAPYBARA_SERVICE_WORKSPACE");
  if (
    cache !== undefined &&
    isAbsolute(cache) &&
    (workspace === undefined || !inside(cache, workspace)) &&
    readOnlyForUs(cache)
  ) {
    if (revision !== undefined && existsSync(join(cache, `${BUILD_DIR[build]}-${revision}`)))
      return { browsersPath: cache, shipped: true };
    // another revision only within MAX_REVISION_SKEW of this build's: an image far behind would
    // run an outdated browser, one far ahead a protocol this playwright-core may not speak
    const near = shippedRevisions(cache, build).filter(
      (d) =>
        revision !== undefined &&
        Math.abs(Number(d.slice(BUILD_DIR[build].length + 1)) - Number(revision)) <=
          MAX_REVISION_SKEW,
    );
    const newest = near.at(-1);
    if (newest !== undefined) return { browsersPath: cache, shipped: true, shippedDir: newest };
  }
  return { browsersPath: join(stateDir, "browsers"), unavailable: BROWSER_UNAVAILABLE_MESSAGE };
}

/** The revision directories of `build` in `cache`, oldest first. */
function shippedRevisions(cache: string, build: ChromiumBuild): string[] {
  const re = new RegExp(`^${BUILD_DIR[build]}-(\\d+)$`);
  let names: string[];
  try {
    names = readdirSync(cache);
  } catch {
    return [];
  }
  return names
    .map((n) => ({ n, rev: Number(re.exec(n)?.[1] ?? Number.NaN) }))
    .filter((x) => Number.isFinite(x.rev))
    .sort((a, b) => a.rev - b.rev)
    .map((x) => x.n);
}

/**
 * The features Playwright 1.65's own launch disables (its `chromiumSwitches`). Chromium takes only
 * the last `--disable-features` flag and ours comes after Playwright's, so ours repeats its list
 * (a test compares it with the playwright-core in use).
 */
// capybara:allow-module-state read-only constant (device service process, not the kernel)
const PLAYWRIGHT_DISABLED_FEATURES = [
  "AvoidUnnecessaryBeforeUnloadCheckSync",
  "DestroyProfileOnBrowserClose",
  "HttpsUpgrades",
  "HttpsFirstBalancedModeAutoEnable",
  "LensOverlay",
  "MediaRouter",
  "PaintHolding",
  "ThirdPartyStoragePartitioning",
  "AvoidCorsURLLoaderRestartOnRedirect",
  "TcpPortRandomizationWin",
  "OptimizationHints",
  "NetworkTimeServiceQuerying",
  "AimEnabled",
  "PreconnectToSearch",
  "msForceBrowserSignIn",
  "msEdgeUpdateLaunchServicesPreferredVersion",
];

/**
 * The features this daemon disables besides Playwright's. `AcceptCHFrame`: a server's ACCEPT_CH
 * frame (sent in the TLS handshake, as www.google.com does) makes Chromium restart the request
 * with the client hints it asks for, and while Playwright intercepts requests to answer the
 * device proxy's credential challenge the restarted navigation is lost: the tab stays at
 * about:blank until the navigation times out. Without the frame the hints follow from the
 * response's Accept-CH header, as in a browser that never saw the site.
 */
// capybara:allow-module-state read-only constant (device service process, not the kernel)
const DISABLED_FEATURES = [...PLAYWRIGHT_DISABLED_FEATURES, "AcceptCHFrame"];

/** The launch for a state directory and environment (pure apart from the browsers cache check). */
export function chromiumLaunchPlan(
  opts: {
    stateDir: string;
    env: Record<string, string | undefined>;
    platform: NodeJS.Platform;
    browsersPath?: string;
  },
  release: { revision: string; version: string } | undefined = browserRelease(
    chromiumBuild(opts.platform, opts.env),
  ),
): LaunchPlan {
  const build = chromiumBuild(opts.platform, opts.env);
  // `--headless` on the full build is its new headless mode (the old one lives on only in the
  // headless shell); the window is the viewport, so the page's window and screen sizes agree
  const args = [
    "--headless",
    "--use-mock-keychain",
    `--window-size=${VIEWPORT.width},${VIEWPORT.height}`,
    `--user-agent=${chromeUserAgent(opts.platform, release?.version ?? "")}`,
    `--disable-features=${DISABLED_FEATURES.join(",")}`,
    // Chrome reloads a network error page by itself (after 1 s, then backing off): that reload
    // aborts the agent's next navigation in the tab and asks the proxy for the failed host again
    "--disable-auto-reload",
  ];
  if (build === "chromium-headless-shell") args.push("--single-process");
  // macOS: Crashpad would write under ~/Library (outside the service's roots), and Chromium takes
  // its temporary directory (the process singleton's socket) from MAC_CHROMIUM_TMPDIR, not TMPDIR
  let env: Record<string, string> | undefined;
  if (opts.platform === "darwin") {
    args.push("--disable-crash-reporter", "--disable-breakpad");
    const tmp = envValue(opts.env, "TMPDIR");
    if (tmp !== undefined) env = { MAC_CHROMIUM_TMPDIR: tmp };
  }
  const proxy = envValue(opts.env, "HTTPS_PROXY") ?? envValue(opts.env, "HTTP_PROXY");
  // Chromium sends loopback (localhost, 127.0.0.1, [::1]) direct, never through the proxy; the
  // provider's network rules keep the device's host services closed.
  let proxyAuth: LaunchPlan["proxyAuth"];
  if (proxy !== undefined) {
    const noProxy = envValue(opts.env, "NO_PROXY");
    const bypass = (noProxy ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s !== "");
    let url: URL | undefined;
    try {
      url = new URL(proxy.includes("://") ? proxy : `http://${proxy}`);
    } catch {
      url = undefined;
    }
    if (url !== undefined && (url.username !== "" || url.password !== "")) {
      proxyAuth = {
        server: `${url.protocol}//${url.host}`,
        username: decodeURIComponent(url.username),
        password: decodeURIComponent(url.password),
        ...(bypass.length > 0 ? { bypass: bypass.join(",") } : {}),
      };
    } else {
      args.push(`--proxy-server=${proxy}`);
      if (bypass.length > 0) args.push(`--proxy-bypass-list=${bypass.join(";")}`);
    }
  }
  return {
    ...(opts.browsersPath === undefined
      ? browsersPathFor(opts.stateDir, opts.env, release?.revision, build)
      : { browsersPath: opts.browsersPath }),
    build,
    ...(env === undefined ? {} : { env }),
    profileDir: join(opts.stateDir, "profile"),
    downloadsTmp: join(opts.stateDir, "downloads-tmp"),
    args,
    proxy,
    ...(proxyAuth === undefined ? {} : { proxyAuth }),
  };
}

type Playwright = typeof import("playwright-core");

// capybara:allow-module-state playwright-core loads once per daemon process (device service)
let loaded: { browsersPath: string; pw: Playwright } | undefined;

/**
 * Loads playwright-core with its registry at `browsersPath` (read once, when the module first
 * loads, from PLAYWRIGHT_BROWSERS_PATH).
 */
async function loadPlaywright(browsersPath: string): Promise<Playwright> {
  if (loaded !== undefined) {
    if (loaded.browsersPath !== browsersPath) {
      throw new Error(
        `playwright-core is already loaded with browsers in ${loaded.browsersPath}, not ${browsersPath}`,
      );
    }
    return loaded.pw;
  }
  process.env.PLAYWRIGHT_BROWSERS_PATH = browsersPath;
  const pw = (await import("playwright-core")) as Playwright & { default?: Playwright };
  loaded = { browsersPath, pw: pw.default ?? pw };
  return loaded.pw;
}

type Registry = typeof import("playwright-core/lib/coreBundle")["registry"]["registry"];
type Executable = NonNullable<ReturnType<Registry["findExecutable"]>>;

/** playwright-core's registry and a Chromium build, for browsers in `browsersPath`. */
async function registryBrowser(
  browsersPath: string,
  build: ChromiumBuild,
): Promise<{ registry: Registry; exe: Executable; executablePath: string; directory: string }> {
  await loadPlaywright(browsersPath);
  const mod = (await import("playwright-core/lib/coreBundle")) as {
    registry?: typeof import("playwright-core/lib/coreBundle").registry;
    default?: { registry: typeof import("playwright-core/lib/coreBundle").registry };
  };
  const registry = (mod.registry ?? mod.default?.registry)?.registry;
  if (registry === undefined) throw new Error("playwright-core has no browser registry");
  const exe = registry.findExecutable(build);
  if (exe === undefined) throw new Error(`playwright-core does not know ${build}`);
  const executablePath = exe.executablePath();
  if (executablePath === undefined || exe.directory === undefined)
    throw new Error(`playwright-core has no ${build} for this platform`);
  return { registry, exe, executablePath, directory: exe.directory };
}

/**
 * Where a build lives in `browsersPath`, and the file Playwright writes into its directory once
 * an install has finished (INSTALLATION_COMPLETE, written last).
 */
export async function browserPaths(
  browsersPath: string,
  build: ChromiumBuild = chromiumBuild(process.platform),
): Promise<{ executable: string; marker: string }> {
  const { executablePath, directory } = await registryBrowser(browsersPath, build);
  return { executable: executablePath, marker: join(directory, "INSTALLATION_COMPLETE") };
}

/**
 * A build's executable, downloaded into the registry first when missing (unless `install` is
 * false: a read-only place, sealed or shipped, is never installed into).
 */
export async function ensureChromium(
  browsersPath: string,
  install = true,
  build: ChromiumBuild = chromiumBuild(process.platform),
  /** Install even over a complete install: one this process did not make is never trusted. */
  fresh = false,
): Promise<string> {
  const { registry, exe, executablePath, directory } = await registryBrowser(browsersPath, build);
  // Installed means Playwright's marker: another process installing into the same directory has
  // the executable on disk long before the rest (still being written: spawn ETXTBSY).
  const marked = existsSync(join(directory, "INSTALLATION_COMPLETE"));
  if (!fresh && marked && existsSync(executablePath)) return executablePath;
  if (!install)
    throw new Error(
      `the browser in ${browsersPath} is incomplete and read only for the browser service; delete the device and create it again`,
    );
  // The registry's lock makes this wait for an install already running, which it then finds
  // done. A marked install without its executable (removed since) is installed again.
  await registry.install([exe], { gc: false, force: marked || fresh });
  if (!existsSync(executablePath)) {
    throw new Error("the Chromium download finished without an executable");
  }
  return executablePath;
}

/**
 * Installs (when needed) and launches Chromium on the plan's profile. Into the provider's unsealed
 * install directory it installs, seals it and throws {@link BrowserInstalledError} without
 * launching: a browser runs only from a place this process can no longer write.
 */
export async function launchChromium(plan: LaunchPlan): Promise<BrowserContext> {
  if (plan.unavailable !== undefined) throw new Error(plan.unavailable);
  if (plan.install?.sealed === false) {
    // unsealed: whatever is there was not installed by this process (the provider empties it at
    // every unsealed start, this is the second line), so it is installed afresh before the seal
    await ensureChromium(plan.browsersPath, true, plan.build, true);
    sealInstall(plan.browsersPath);
    throw new BrowserInstalledError();
  }
  const executablePath =
    plan.shippedDir === undefined
      ? await ensureChromium(
          plan.browsersPath,
          plan.install === undefined && plan.shipped !== true,
          plan.build,
        )
      : await shippedExecutable(plan.browsersPath, plan.shippedDir, plan.build);
  const pw = await loadPlaywright(plan.browsersPath);
  // never `ignoreDefaultArgs`: Playwright's default switches keep background tabs rendering
  // (--disable-renderer-backgrounding and friends), which per-conversation tabs rely on
  return pw.chromium.launchPersistentContext(plan.profileDir, {
    headless: true,
    executablePath,
    args: plan.args,
    viewport: { ...VIEWPORT },
    // downloads are saved into the workspace by the session (actions.ts)
    acceptDownloads: true,
    downloadsPath: plan.downloadsTmp,
    ...(plan.proxyAuth === undefined ? {} : { proxy: plan.proxyAuth }),
    ...(plan.env === undefined ? {} : { env: { ...process.env, ...plan.env } }),
  });
}

/**
 * The executable in another revision directory of a shipped cache: the same place inside it as
 * this build's revision would have (the layout depends on the build and platform, not on the
 * revision). Throws when it is missing.
 */
async function shippedExecutable(
  cache: string,
  dir: string,
  build: ChromiumBuild,
): Promise<string> {
  const { executablePath, directory } = await registryBrowser(cache, build);
  const path = join(cache, dir, relative(directory, executablePath));
  if (!existsSync(path))
    throw new Error(
      `the browser shipped in ${join(cache, dir)} has no executable; ${BROWSER_UNAVAILABLE_MESSAGE}`,
    );
  return path;
}

/** Seals the provider's install directory (an existing seal stays as it is). */
export function sealInstall(dir: string): void {
  try {
    writeFileSync(join(dir, SERVICE_INSTALL_SEAL), "", { flag: "wx", mode: 0o644 });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
  }
}

/**
 * The id of Chromium's browser process (CDP SystemInfo), asked right after the launch: a stop
 * kills a Chromium that does not close (Playwright itself waits 180 s before it kills).
 * Undefined when the browser does not say.
 */
export async function browserProcessId(ctx: BrowserContext): Promise<number | undefined> {
  const browser = ctx.browser();
  if (browser === null) return undefined;
  try {
    const cdp = await browser.newBrowserCDPSession();
    try {
      const info = await cdp.send("SystemInfo.getProcessInfo");
      return info.processInfo.find((p) => p.type === "browser")?.id;
    } finally {
      await cdp.detach().catch(() => undefined);
    }
  } catch {
    return undefined;
  }
}

/** Kills Chromium: its process group (Playwright starts it detached, as the group's leader). */
export function killChromium(pid: number): void {
  // never 0 or 1 (kill(-0) is this process's own group, kill(-1) every process of the user)
  if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
}

/** Whether a process with this id exists (signal 0 only checks; EPERM means it exists). */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}
