import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { launchChromium } from "../../daemon/chromium.js";
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
    expect(second.ok).toBe(true);
    expect(calls).toBe(3);
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
      blockedHosts: [
        "cdn.playwright.dev",
        "playwright.download.prss.microsoft.com",
        "storage.googleapis.com",
      ],
    });
    expect(r.ok ? "" : r.message.startsWith(DOWNLOAD_BLOCKED_PREFIX)).toBe(true);
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
