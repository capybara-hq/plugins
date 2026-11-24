/// <reference path="./playwright-registry.d.ts" />
// Chromium for the daemon (spec §5): installed on first start into `<state>/browsers` through
// playwright-core's registry, launched with the profile `<state>/profile` (launchPersistentContext,
// the only way Playwright takes a user data directory) over a CDP pipe, never a debugging port.

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { BrowserContext } from "playwright-core";
import { VIEWPORT } from "./protocol.js";

export interface LaunchPlan {
  browsersPath: string;
  profileDir: string;
  /** Extra Chromium flags (Playwright adds --headless and --remote-debugging-pipe itself). */
  args: string[];
  /** The proxy Chromium uses, when the device's environment names one. */
  proxy: string | undefined;
}

function envValue(env: Record<string, string | undefined>, name: string): string | undefined {
  const v = env[name] ?? env[name.toLowerCase()];
  return v === undefined || v === "" ? undefined : v;
}

/** The launch for a state directory and environment (pure). */
export function chromiumLaunchPlan(opts: {
  stateDir: string;
  env: Record<string, string | undefined>;
  platform: NodeJS.Platform;
  browsersPath?: string;
}): LaunchPlan {
  const args = ["--headless", "--use-mock-keychain"];
  // macOS: chrome-headless-shell in one process (the local sandbox does not run the full browser's
  // helper processes); spike: stable for navigation, input, screencast and tabs.
  if (opts.platform === "darwin") args.push("--single-process");
  const proxy = envValue(opts.env, "HTTPS_PROXY") ?? envValue(opts.env, "HTTP_PROXY");
  if (proxy !== undefined) {
    args.push(`--proxy-server=${proxy}`);
    const noProxy = envValue(opts.env, "NO_PROXY");
    if (noProxy !== undefined) {
      const list = noProxy
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s !== "");
      if (list.length > 0) args.push(`--proxy-bypass-list=${list.join(";")}`);
    }
  }
  return {
    browsersPath: opts.browsersPath ?? join(opts.stateDir, "browsers"),
    profileDir: join(opts.stateDir, "profile"),
    args,
    proxy,
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

/** The headless shell's executable, downloaded into the registry first when missing. */
export async function ensureChromium(browsersPath: string): Promise<string> {
  await loadPlaywright(browsersPath);
  const mod = (await import("playwright-core/lib/coreBundle")) as {
    registry?: typeof import("playwright-core/lib/coreBundle").registry;
    default?: { registry: typeof import("playwright-core/lib/coreBundle").registry };
  };
  const registry = (mod.registry ?? mod.default?.registry)?.registry;
  if (registry === undefined) throw new Error("playwright-core has no browser registry");
  const exe = registry.findExecutable("chromium-headless-shell");
  if (exe === undefined) throw new Error("playwright-core does not know chromium-headless-shell");
  const path = exe.executablePath();
  if (path !== undefined && existsSync(path)) return path;
  await registry.install([exe], { gc: false });
  const installed = exe.executablePath();
  if (installed === undefined || !existsSync(installed)) {
    throw new Error("the Chromium download finished without an executable");
  }
  return installed;
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
    acceptDownloads: false,
  });
}
