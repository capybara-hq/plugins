// The daemon's cookie file (`<state>/cookies.json`): the persistent cookies, written when a stop
// begins, so a person's logins survive a Chromium that is killed before it has written its own
// Cookies file. The device service gets SERVICE_STOP_GRACE_MS (2 s, core packages/device) between
// SIGTERM and SIGKILL, and a loaded machine can spend all of it closing Chromium; the kill then
// lands mid-commit and the profile has no cookie. Chromium's profile stays the source of truth:
// at the next start only cookies the profile lacks are added back, never a changed one.

import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BrowserContext } from "playwright-core";

type SavedCookie = Awaited<ReturnType<BrowserContext["cookies"]>>[number];

const key = (c: Pick<SavedCookie, "name" | "domain" | "path">) =>
  `${c.domain}\n${c.path}\n${c.name}`;

/** Writes the persistent cookies (those with an expiry) of `ctx`; never throws. */
export async function saveCookies(ctx: BrowserContext, stateDir: string): Promise<void> {
  try {
    const cookies = (await ctx.cookies()).filter((c) => c.expires > 0);
    const file = join(stateDir, "cookies.json");
    writeFileSync(`${file}.tmp`, JSON.stringify(cookies), { mode: 0o600 });
    renameSync(`${file}.tmp`, file);
  } catch {
    // the browser is gone or the disk is full: Chromium's own profile is all there is
  }
}

/** Adds the saved cookies the profile does not have; never throws. */
export async function restoreCookies(ctx: BrowserContext, stateDir: string): Promise<void> {
  try {
    const saved = JSON.parse(readFileSync(join(stateDir, "cookies.json"), "utf8")) as unknown;
    if (!Array.isArray(saved)) return;
    const have = new Set((await ctx.cookies()).map(key));
    const now = Date.now() / 1000;
    const missing = (saved as SavedCookie[]).filter(
      (c) =>
        typeof c?.name === "string" &&
        typeof c.domain === "string" &&
        typeof c.path === "string" &&
        typeof c.value === "string" &&
        typeof c.expires === "number" &&
        c.expires > now &&
        !have.has(key(c)),
    );
    if (missing.length > 0) await ctx.addCookies(missing);
  } catch {
    // no file, or one that does not parse: nothing to add back
  }
}
