import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserContext } from "playwright-core";
import { afterEach, describe, expect, it } from "vitest";
import { browserProcessId, launchChromium } from "../../daemon/chromium.js";
import { type Daemon, startDaemon } from "../../daemon/main.js";
import { DOWNLOAD_BLOCKED_PREFIX } from "../../daemon/protocol.js";
import {
  openViewer,
  removeDir,
  request,
  startFixtureServer,
  startTestDaemon,
  TEST_BROWSERS,
} from "./helpers.js";

/** A proxy that refuses every CONNECT (403), like an egress allowlist without Playwright's CDN. */
async function refuseAll(): Promise<{ url: string; server: Server; asked: string[] }> {
  const asked: string[] = [];
  const server = createServer((_req, res) => res.writeHead(403).end());
  server.on("connect", (req, sock) => {
    asked.push(String(req.url));
    sock.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  if (addr === null || typeof addr === "string") throw new Error("no address");
  return { url: `http://127.0.0.1:${addr.port}`, server, asked };
}

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});

async function daemonWith(opts: Partial<Parameters<typeof startDaemon>[0]>): Promise<{
  daemon: Daemon;
  socketPath: string;
  stateDir: string;
}> {
  const stateDir = mkdtempSync(join(tmpdir(), "cbd-"));
  const socketPath = join(stateDir, "sock");
  const daemon = await startDaemon({
    socketPath,
    stateDir,
    env: {},
    browsersPath: TEST_BROWSERS,
    ...opts,
  });
  cleanup.push(async () => {
    await daemon.close();
    removeDir(stateDir);
  });
  return { daemon, socketPath, stateDir };
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("browser daemon: Chromium that cannot start", () => {
  it("answers with the cause, keeps running and launches again on the next request", async () => {
    let calls = 0;
    const { daemon, socketPath } = await daemonWith({
      launch: async (plan) => {
        calls++;
        if (calls <= 2) throw new Error("no chromium here");
        return launchChromium(plan);
      },
    });
    // the first launch (at start) fails; the daemon stays up
    await expect(daemon.ready).rejects.toThrow("no chromium here");
    const first = await request(socketPath, { op: "snapshot" });
    expect(first).toMatchObject({ ok: false, error: "failed" });
    expect(first.ok ? "" : first.message).toContain("no chromium here");
    const second = await request(socketPath, { op: "snapshot" });
    expect(second).toMatchObject({ ok: true });
    expect(calls).toBe(3);
  });

  it("closes a Chromium whose session cannot be set up, fails with the cause and launches again", async () => {
    let calls = 0;
    let gone = 0;
    const pids: number[] = [];
    const { daemon, socketPath } = await daemonWith({
      // closing the failed launch's browser is not a Chromium that went away
      onBrowserGone: () => gone++,
      launch: async (plan) => {
        calls++;
        const real = await launchChromium(plan);
        const pid = await browserProcessId(real);
        if (pid !== undefined) pids.push(pid);
        if (calls > 1) return real;
        // Chromium runs, but setting up the session on it fails
        return new Proxy(real, {
          get: (target, key) => {
            if (key === "setDefaultTimeout")
              return () => {
                throw new Error("session setup failed");
              };
            const v = Reflect.get(target, key, target);
            return typeof v === "function" ? v.bind(target) : v;
          },
        });
      },
    });
    cleanup.push(() => {
      for (const pid of pids) if (alive(pid)) process.kill(pid, "SIGKILL");
    });
    await expect(daemon.ready).rejects.toThrow("session setup failed");
    // that Chromium is closed, not left running beside the next one
    expect(pids).toHaveLength(1);
    expect(alive(pids[0] as number)).toBe(false);
    const next = await request(socketPath, { op: "snapshot" });
    expect(next).toMatchObject({ ok: true });
    expect(calls).toBe(2);
    expect(gone).toBe(0);
  });

  it("reports Playwright's download hosts the device's proxy refuses", async () => {
    const proxy = await refuseAll();
    cleanup.push(() => {
      proxy.server.closeAllConnections();
      proxy.server.close();
    });
    const { daemon, socketPath } = await daemonWith({
      env: { HTTPS_PROXY: proxy.url },
      launch: async () => {
        throw new Error("download failed: connect ECONNREFUSED");
      },
    });
    await daemon.ready.catch(() => undefined);
    const r = await request(socketPath, { op: "snapshot" });
    expect(r).toMatchObject({
      ok: false,
      error: "blocked",
      blockedHosts: ["cdn.playwright.dev", "playwright.download.prss.microsoft.com"],
    });
    expect(r.ok ? "" : r.message.startsWith(DOWNLOAD_BLOCKED_PREFIX)).toBe(true);
  });
});

describe("browser daemon: stop", () => {
  it("kills a Chromium that does not close instead of waiting for it", async () => {
    let ctx: BrowserContext | undefined;
    const { daemon } = await daemonWith({
      browserCloseGraceMs: 300,
      launch: async (plan) => {
        ctx = await launchChromium(plan);
        return ctx;
      },
    });
    await daemon.ready;
    if (ctx === undefined) throw new Error("not launched");
    const pid = await browserProcessId(ctx);
    if (pid === undefined) throw new Error("no browser process id");
    cleanup.push(() => {
      if (alive(pid)) process.kill(pid, "SIGKILL");
    });
    // a browser that no longer answers (Playwright would wait 180 s before killing it)
    process.kill(pid, "SIGSTOP");
    await daemon.close();
    expect(alive(pid)).toBe(false);
  });

  it("returns after the grace without killing when the browser's process id is unknown", async () => {
    let ctx: BrowserContext | undefined;
    const { daemon } = await daemonWith({
      browserCloseGraceMs: 300,
      launch: async (plan) => {
        const real = await launchChromium(plan);
        ctx = real;
        // a browser that does not name its process
        return new Proxy(real, {
          get: (target, key) => {
            if (key === "browser") return () => null;
            const v = Reflect.get(target, key, target);
            return typeof v === "function" ? v.bind(target) : v;
          },
        });
      },
    });
    await daemon.ready;
    if (ctx === undefined) throw new Error("not launched");
    const pid = await browserProcessId(ctx);
    if (pid === undefined) throw new Error("no browser process id");
    cleanup.push(() => {
      if (alive(pid)) process.kill(pid, "SIGKILL");
    });
    process.kill(pid, "SIGSTOP");
    await daemon.close();
    // nothing to kill: the stop returned anyway, Chromium is left to the process exit
    expect(alive(pid)).toBe(true);
  });

  it("abandons a launch still running at the stop; it only closes once it finishes", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "cbd-"));
    cleanup.push(() => removeDir(stateDir));
    // tabs a restart would reopen (the first in the blank tab, the second in a new one)
    const session = JSON.stringify({
      savedAt: Date.now(),
      tabs: ["http://127.0.0.1:9/a", "http://127.0.0.1:9/b"],
      active: 0,
    });
    writeFileSync(join(stateDir, "session.json"), session);
    let opened = 0;
    // resolves with the daemon's close of that browser, which ends once Chromium has exited
    let closedByDaemon!: (done: Promise<void>) => void;
    const closing = new Promise<Promise<void>>((r) => {
      closedByDaemon = r;
    });
    let finish: (() => void) | undefined;
    const launched = new Promise<BrowserContext>((resolve) => {
      finish = () =>
        resolve(
          launchChromium(plan).then((real) => {
            real.on("page", () => opened++);
            return new Proxy(real, {
              get: (target, key) => {
                if (key === "close")
                  return () => {
                    const done = target.close();
                    closedByDaemon(done);
                    return done;
                  };
                const v = Reflect.get(target, key, target);
                return typeof v === "function" ? v.bind(target) : v;
              },
            });
          }),
        );
    });
    let plan!: Parameters<typeof launchChromium>[0];
    const { daemon } = await daemonWith({
      stateDir,
      socketPath: join(stateDir, "sock"),
      browserCloseGraceMs: 300,
      launch: (p) => {
        plan = p;
        return launched;
      },
    });
    // the launch (an install, say) is still running: the stop does not wait for it
    await daemon.close();
    finish?.();
    await await closing;
    // no tab restored, and the session file not written back
    expect(opened).toBe(0);
    expect(readFileSync(join(stateDir, "session.json"), "utf8")).toBe(session);
  });
});

describe("browser daemon: restart", () => {
  it("restores the tabs and the pending handoff of a daemon that stopped moments ago", async () => {
    const fx = await startFixtureServer({
      "/a": "<!doctype html><title>A</title>",
      "/b": "<!doctype html><title>B</title>",
    });
    cleanup.push(() => fx.close());
    const stateDir = mkdtempSync(join(tmpdir(), "cbd-"));
    cleanup.push(() => removeDir(stateDir));
    const one = await startTestDaemon({ stateDir });
    await request(one.socketPath, { op: "navigate", url: `${fx.url}/a` });
    await request(one.socketPath, { op: "tabs", action: "open", url: `${fx.url}/b` });
    await request(one.socketPath, { op: "handoff_notice", callId: "h1", message: "Sign in" });
    await one.stop();

    const two = await startTestDaemon({ stateDir });
    cleanup.push(() => two.stop());
    expect(two.daemon.state.handoff).toEqual({ callId: "h1", message: "Sign in" });
    const v = await openViewer(two.socketPath, { maxWidth: 320, maxHeight: 200 });
    cleanup.push(() => v.close());
    const st = await v.next(
      (m) =>
        m.t === "state" && m.tabs.length === 2 && m.tabs.every((t) => t.url.startsWith("http")),
    );
    if (st.t !== "state") throw new Error("no state");
    expect(st.tabs.map((t) => t.url)).toEqual([`${fx.url}/a`, `${fx.url}/b`]);
    expect(st.tabs.find((t) => t.active)?.url).toBe(`${fx.url}/b`);
  });

  it("restores nothing after an idle stop or from an old session file", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "cbd-"));
    cleanup.push(() => removeDir(stateDir));
    writeFileSync(
      join(stateDir, "session.json"),
      JSON.stringify({
        savedAt: Date.now() - 24 * 60 * 60_000,
        tabs: ["http://127.0.0.1:9/old"],
        active: 0,
        handoff: { callId: "old", message: "x" },
      }),
    );
    const d = await startTestDaemon({ stateDir });
    cleanup.push(() => d.stop());
    expect(d.daemon.state.handoff).toBeUndefined();
    const v = await openViewer(d.socketPath, { maxWidth: 320, maxHeight: 200 });
    cleanup.push(() => v.close());
    const st = await v.next((m) => m.t === "state");
    if (st.t !== "state") throw new Error("no state");
    expect(st.tabs.some((t) => t.url.includes("/old"))).toBe(false);
  });
});
