import { existsSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { BrowserContext } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { browserProcessId, killChromium, launchChromium } from "../../daemon/chromium.js";
import { removeDir, request, startFixtureServer, startTestDaemon } from "./helpers.js";

let fx: Awaited<ReturnType<typeof startFixtureServer>>;
const dirs: string[] = [];

beforeAll(async () => {
  fx = await startFixtureServer({
    "/set": (_req, res) => {
      res.writeHead(200, {
        "content-type": "text/html",
        "set-cookie": "kept=v1; Max-Age=3600; Path=/",
      });
      res.end("<!doctype html><title>Set</title><p>set</p>");
    },
    "/clear": (_req, res) => {
      res.writeHead(200, {
        "content-type": "text/html",
        "set-cookie": "kept=; Max-Age=0; Path=/",
      });
      res.end("<!doctype html><title>Clear</title><p>cleared</p>");
    },
    "/get": (req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`<!doctype html><title>Get</title><p>cookie: ${req.headers.cookie ?? "none"}</p>`);
    },
  });
});

afterAll(async () => {
  await fx?.close();
  for (const dir of dirs) removeDir(dir);
});

describe("browser daemon profile", () => {
  // grace 1 ms: the stop gives up (and kills Chromium) before Chromium has written its Cookies
  // file, as a loaded service stop does at the supervisor's 2 s SIGKILL
  it.each([60_000, 1])(
    "profile persists across daemon restarts (close grace %i ms)",
    async (grace) => {
      const first = await startTestDaemon({ browserCloseGraceMs: grace });
      dirs.push(first.stateDir);
      await request(first.socketPath, { op: "navigate", url: `${fx.url}/set` });
      await first.stop();
      const second = await startTestDaemon({ stateDir: first.stateDir });
      try {
        await request(second.socketPath, { op: "navigate", url: `${fx.url}/get` });
        const snap = await request(second.socketPath, { op: "snapshot" });
        if (!snap.ok) throw new Error(snap.message);
        expect(snap.text).toContain("kept=v1");
      } finally {
        await second.stop();
      }
    },
  );

  it("a cookie deleted while the browser ran is not brought back by an old cookies file", async () => {
    // the first stop gives up before Chromium writes its Cookies file: only cookies.json has it
    const first = await startTestDaemon({ browserCloseGraceMs: 1 });
    dirs.push(first.stateDir);
    await request(first.socketPath, { op: "navigate", url: `${fx.url}/set` });
    await first.stop();
    expect(existsSync(join(first.stateDir, "cookies.json"))).toBe(true);
    // Chromium sometimes wins the race with the 1 ms grace and writes its Cookies file before the
    // kill. Remove that file from the (stopped) profile so the premise holds on every run: only
    // cookies.json has the cookie.
    const profileDefault = join(first.stateDir, "profile", "Default");
    for (const dir of [profileDefault, join(profileDefault, "Network")]) {
      if (!existsSync(dir)) continue;
      for (const name of readdirSync(dir)) {
        if (name.startsWith("Cookies")) unlinkSync(join(dir, name));
      }
    }

    // the second start merges the file (and removes it), then the page deletes the cookie
    let ctx: BrowserContext | undefined;
    const second = await startTestDaemon({
      stateDir: first.stateDir,
      launch: async (plan) => {
        ctx = await launchChromium(plan);
        return ctx;
      },
    });
    expect(existsSync(join(first.stateDir, "cookies.json"))).toBe(false);
    await request(second.socketPath, { op: "navigate", url: `${fx.url}/get` });
    const merged = await request(second.socketPath, { op: "snapshot" });
    if (!merged.ok) throw new Error(merged.message);
    expect(merged.text).toContain("kept=v1");
    await request(second.socketPath, { op: "navigate", url: `${fx.url}/clear` });
    // a crash: Chromium dies without a stop
    if (ctx === undefined) throw new Error("not launched");
    const pid = await browserProcessId(ctx);
    if (pid === undefined) throw new Error("no browser process id");
    killChromium(pid);
    await second.stop();

    const third = await startTestDaemon({ stateDir: first.stateDir });
    try {
      await request(third.socketPath, { op: "navigate", url: `${fx.url}/get` });
      const snap = await request(third.socketPath, { op: "snapshot" });
      if (!snap.ok) throw new Error(snap.message);
      expect(snap.text).toContain("cookie: none");
    } finally {
      await third.stop();
    }
  });
});
