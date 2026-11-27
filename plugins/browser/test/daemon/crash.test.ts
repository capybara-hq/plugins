// Chromium crashing under the daemon (capybara-hq/plugins acceptance 2026-11-28: an upstream
// SIGSEGV while a window closed): the daemon stays up, its socket stays, and the next request
// launches Chromium again with the tabs the crash closed reopened for their owners.
import { existsSync } from "node:fs";
import type { BrowserContext } from "playwright-core";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { browserProcessId, killChromium, launchChromium } from "../../daemon/chromium.js";
import {
  BROWSER_CRASHED_MESSAGE,
  BROWSER_RESTARTED_NOTE,
  type ToolReply,
} from "../../daemon/protocol.js";
import {
  conv,
  openViewer,
  removeDir,
  request,
  startFixtureServer,
  startTestDaemon,
  type TestDaemon,
} from "./helpers.js";

let site: Awaited<ReturnType<typeof startFixtureServer>>;
const daemons: TestDaemon[] = [];
const page = (title: string) => (_req: unknown, res: import("node:http").ServerResponse) =>
  res.writeHead(200, { "content-type": "text/html" }).end(`<!doctype html><title>${title}</title>`);
/** Requests to /slow hang until released (a request in flight when Chromium dies). */
const releaseSlow: (() => void)[] = [];

beforeAll(async () => {
  site = await startFixtureServer({
    "/a": page("A"),
    "/b": page("B"),
    "/c": page("C"),
    "/slow": (_req, res) => {
      releaseSlow.push(() => res.writeHead(200, { "content-type": "text/html" }).end("slow"));
    },
  });
});

afterAll(async () => {
  await site?.close();
});

afterEach(async () => {
  for (const r of releaseSlow.splice(0)) r();
  for (const d of daemons.splice(0)) {
    await d.stop();
    removeDir(d.stateDir);
  }
});

const ok = (r: ToolReply) => {
  if (!r.ok) throw new Error(`${r.error}: ${r.message}`);
  return r;
};

/** A daemon whose Chromium launches are recorded, so a test can crash the running one. */
async function crashable(): Promise<{
  d: TestDaemon;
  crash: () => Promise<void>;
  gone: () => number;
  launches: () => number;
}> {
  const contexts: BrowserContext[] = [];
  let gone = 0;
  const d = await startTestDaemon({
    onBrowserGone: () => gone++,
    launch: async (plan) => {
      const ctx = await launchChromium(plan);
      contexts.push(ctx);
      return ctx;
    },
  });
  daemons.push(d);
  return {
    d,
    // SIGKILL as a crash does it: Chromium is gone without the daemon closing it
    crash: async () => {
      const ctx = contexts.at(-1);
      const pid = ctx === undefined ? undefined : await browserProcessId(ctx);
      if (ctx === undefined || pid === undefined) throw new Error("no running Chromium");
      const closed = new Promise<void>((r) => ctx.once("close", () => r()));
      killChromium(pid);
      await closed;
    },
    gone: () => gone,
    launches: () => contexts.length,
  };
}

describe("browser daemon: Chromium crashes", () => {
  it("the next request relaunches Chromium and reopens each conversation's tabs; the socket stays", async () => {
    const { d, crash, gone, launches } = await crashable();
    const one = conv("c1");
    const two = conv("c2");
    ok(await request(d.socketPath, { op: "navigate", url: `${site.url}/a` }, one));
    ok(await request(d.socketPath, { op: "tabs", action: "open", url: `${site.url}/b` }, one));
    ok(await request(d.socketPath, { op: "navigate", url: `${site.url}/c` }, two));
    await crash();
    expect(gone()).toBe(1);
    // the daemon still listens: no ENOENT, no connection closed without an answer
    expect(existsSync(d.socketPath)).toBe(true);
    const next = ok(await request(d.socketPath, { op: "snapshot" }, one));
    expect(launches()).toBe(2);
    expect(next.text).toContain(BROWSER_RESTARTED_NOTE);
    // c1's active tab (the one it opened last) is active again
    expect(next.page?.url).toBe(`${site.url}/b`);
    const tabs = ok(await request(d.socketPath, { op: "tabs", action: "list" }, one));
    expect(tabs.tabs).toMatchObject({ open: 2 });
    const other = ok(await request(d.socketPath, { op: "snapshot" }, two));
    expect(other.page?.url).toBe(`${site.url}/c`);
    expect(other.text).toContain(BROWSER_RESTARTED_NOTE);
    // said once
    const again = ok(await request(d.socketPath, { op: "snapshot" }, one));
    expect(again.text ?? "").not.toContain(BROWSER_RESTARTED_NOTE);
    // and it keeps working after a second crash
    await crash();
    ok(await request(d.socketPath, { op: "navigate", url: `${site.url}/a` }, one));
    expect(launches()).toBe(3);
  });

  it("a request running when Chromium crashes answers that it crashed; the next one works", async () => {
    const { d, crash } = await crashable();
    ok(await request(d.socketPath, { op: "navigate", url: `${site.url}/a` }));
    const running = request(d.socketPath, { op: "navigate", url: `${site.url}/slow` });
    await expect.poll(() => releaseSlow.length).toBe(1);
    await crash();
    const reply = await running;
    expect(reply).toMatchObject({ ok: false, message: BROWSER_CRASHED_MESSAGE });
    const next = ok(await request(d.socketPath, { op: "snapshot" }));
    expect(next.page?.url).toBe(`${site.url}/a`);
  });

  it("a viewer's stream ends with the crash and a new one sees the relaunched browser", async () => {
    const { d, crash } = await crashable();
    ok(await request(d.socketPath, { op: "navigate", url: `${site.url}/a` }));
    const v = await openViewer(d.socketPath, { maxWidth: 640, maxHeight: 400 });
    await v.next((m) => m.t === "state");
    await crash();
    await v.closed;
    const w = await openViewer(d.socketPath, { maxWidth: 640, maxHeight: 400 });
    await w.next((m) => m.t === "state" && m.tabs.some((t) => t.url === `${site.url}/a`));
    await w.close();
  });
});
