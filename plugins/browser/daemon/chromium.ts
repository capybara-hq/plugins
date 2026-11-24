/// <reference path="./playwright-registry.d.ts" />
// Chromium for the daemon (spec §5): installed on first start into `<state>/browsers` through
// playwright-core's registry, launched with the profile `<state>/profile` (launchPersistentContext,
// the only way Playwright takes a user data directory) over a CDP pipe, never a debugging port.

import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { BrowserContext } from "playwright-core";
import { VIEWPORT } from "./protocol.js";

export interface LaunchPlan {
  browsersPath: string;
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
 * The revision of chromium-headless-shell this build's playwright-core installs (its
 * browsers.json): next to the bundle (`vendor/playwright-core/`), else the installed package.
 */
export function headlessShellRevision(): string | undefined {
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
        browsers?: { name?: unknown; revision?: unknown }[];
      };
      const rev = json.browsers?.find((b) => b.name === "chromium-headless-shell")?.revision;
      if (typeof rev === "string" && rev !== "") return rev;
    } catch {
      // try the next one
    }
  }
  return undefined;
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
  return ["cdn.playwright.dev", "playwright.download.prss.microsoft.com"];
}

/**
 * Where the browsers live: a PLAYWRIGHT_BROWSERS_PATH from the device's environment (a read-only
 * cache in the image) when it already holds this revision's headless shell, so nothing is
 * downloaded; otherwise the state directory, where the daemon installs it on first start.
 */
function browsersPathFor(
  stateDir: string,
  env: Record<string, string | undefined>,
  revision: string | undefined,
): string {
  const cache = envValue(env, "PLAYWRIGHT_BROWSERS_PATH");
  if (
    cache !== undefined &&
    revision !== undefined &&
    existsSync(join(cache, `chromium_headless_shell-${revision}`))
  )
    return cache;
  return join(stateDir, "browsers");
}

/** The launch for a state directory and environment (pure apart from the browsers cache check). */
export function chromiumLaunchPlan(
  opts: {
    stateDir: string;
    env: Record<string, string | undefined>;
    platform: NodeJS.Platform;
    browsersPath?: string;
  },
  revision: string | undefined = headlessShellRevision(),
): LaunchPlan {
  const args = ["--headless", "--use-mock-keychain"];
  // macOS: chrome-headless-shell in one process (the local sandbox does not run the full browser's
  // helper processes); spike: stable for navigation, input, screencast and tabs.
  if (opts.platform === "darwin") args.push("--single-process");
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
    browsersPath: opts.browsersPath ?? browsersPathFor(opts.stateDir, opts.env, revision),
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

/** playwright-core's registry and its headless shell, for browsers in `browsersPath`. */
async function headlessShell(
  browsersPath: string,
): Promise<{ registry: Registry; exe: Executable; executablePath: string; directory: string }> {
  await loadPlaywright(browsersPath);
  const mod = (await import("playwright-core/lib/coreBundle")) as {
    registry?: typeof import("playwright-core/lib/coreBundle").registry;
    default?: { registry: typeof import("playwright-core/lib/coreBundle").registry };
  };
  const registry = (mod.registry ?? mod.default?.registry)?.registry;
  if (registry === undefined) throw new Error("playwright-core has no browser registry");
  const exe = registry.findExecutable("chromium-headless-shell");
  if (exe === undefined) throw new Error("playwright-core does not know chromium-headless-shell");
  const executablePath = exe.executablePath();
  if (executablePath === undefined || exe.directory === undefined)
    throw new Error("playwright-core has no chromium-headless-shell for this platform");
  return { registry, exe, executablePath, directory: exe.directory };
}

/**
 * Where the headless shell lives in `browsersPath`, and the file Playwright writes into its
 * directory once an install has finished (INSTALLATION_COMPLETE, written last).
 */
export async function headlessShellPaths(
  browsersPath: string,
): Promise<{ executable: string; marker: string }> {
  const { executablePath, directory } = await headlessShell(browsersPath);
  return { executable: executablePath, marker: join(directory, "INSTALLATION_COMPLETE") };
}

/** The headless shell's executable, downloaded into the registry first when missing. */
export async function ensureChromium(browsersPath: string): Promise<string> {
  const { registry, exe, executablePath, directory } = await headlessShell(browsersPath);
  // Installed means Playwright's marker: another process installing into the same directory has
  // the executable on disk long before the rest (still being written: spawn ETXTBSY).
  const marked = existsSync(join(directory, "INSTALLATION_COMPLETE"));
  if (marked && existsSync(executablePath)) return executablePath;
  // The registry's lock makes this wait for an install already running, which it then finds
  // done. A marked install without its executable (removed since) is installed again.
  await registry.install([exe], { gc: false, force: marked });
  if (!existsSync(executablePath)) {
    throw new Error("the Chromium download finished without an executable");
  }
  return executablePath;
}

/** Installs (when needed) and launches Chromium on the plan's profile. */
export async function launchChromium(plan: LaunchPlan): Promise<BrowserContext> {
  const executablePath = await ensureChromium(plan.browsersPath);
  const pw = await loadPlaywright(plan.browsersPath);
  return pw.chromium.launchPersistentContext(plan.profileDir, {
    headless: true,
    executablePath,
    args: plan.args,
    viewport: { ...VIEWPORT },
    // downloads are saved into the workspace by the session (actions.ts)
    acceptDownloads: true,
    downloadsPath: plan.downloadsTmp,
    ...(plan.proxyAuth === undefined ? {} : { proxy: plan.proxyAuth }),
  });
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
