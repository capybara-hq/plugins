import { mkdtempSync, writeFileSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserContext, Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchChromium } from "../../daemon/chromium.js";
import {
  openViewer,
  removeDir,
  request,
  startFixtureServer,
  startTestDaemon,
  type TestDaemon,
} from "./helpers.js";

// /secure redirects to /login (302), like a site whose session expired. One request can be held,
// so that a second navigation meets the first one still in flight.
let fx: Awaited<ReturnType<typeof startFixtureServer>>;
let d: TestDaemon;
let hold: ((res: ServerResponse) => void) | undefined;
const held: ServerResponse[] = [];
/** Called with every failed page.goto of the daemon's browser (the order of events in a test). */
let onGotoFailed: (() => void) | undefined;

beforeAll(async () => {
  fx = await startFixtureServer({
    "/secure": (_req, res) => {
      const h = hold;
      if (h !== undefined) {
        hold = undefined;
        held.push(res);
        h(res);
        return;
      }
      res.writeHead(302, { location: "/login" }).end();
    },
    "/login": "<!doctype html><title>Login</title><h1>Login page</h1>",
    "/plain": (_req, res) => {
      const h = hold;
      if (h !== undefined) {
        hold = undefined;
        held.push(res);
        h(res);
        return;
      }
      res
        .writeHead(200, { "content-type": "text/html" })
        .end("<!doctype html><title>Plain</title>");
    },
    "/other": "<!doctype html><title>Other</title><h1>Other page</h1>",
  });
  d = await startTestDaemon({ launch: launchWatched });
});

/** Chromium whose pages report every failed page.goto (to order a test's steps). */
async function launchWatched(plan: Parameters<typeof launchChromium>[0]): Promise<BrowserContext> {
  const ctx = await launchChromium(plan);
  const wrap = (page: Page) => {
    const goto = page.goto.bind(page);
    page.goto = (async (...args: Parameters<Page["goto"]>) => {
      try {
        return await goto(...args);
      } catch (e) {
        onGotoFailed?.();
        throw e;
      }
    }) as Page["goto"];
  };
  for (const page of ctx.pages()) wrap(page);
  ctx.on("page", wrap);
  return ctx;
}

afterAll(async () => {
  for (const res of held) res.destroy();
  await d?.stop();
  await fx?.close();
  if (d) removeDir(d.stateDir);
});

/** Holds the next /secure request; resolves with its response once it arrives. */
function holdNext(): Promise<ServerResponse> {
  return new Promise((resolve) => {
    hold = resolve;
  });
}

function nextGotoFailure(): Promise<void> {
  return new Promise((resolve) => {
    onGotoFailed = () => {
      onGotoFailed = undefined;
      resolve();
    };
  });
}

describe("navigate through redirects", () => {
  it("a redirect reports the page it ended on", async () => {
    const r = await request(d.socketPath, { op: "navigate", url: `${fx.url}/secure` });
    expect(r).toMatchObject({ ok: true, page: { url: `${fx.url}/login`, title: "Login" } });
  });

  it("a navigation dropped for one in flight to the same address succeeds on its final page", async () => {
    await request(d.socketPath, { op: "navigate", url: "about:blank" });
    const v = await openViewer(d.socketPath, { maxWidth: 480, maxHeight: 300 });
    await v.next((m) => m.t === "state");
    // a navigation to /secure is in flight (as a tab restored at start); Chromium drops the
    // tool's navigation to the same address with net::ERR_ABORTED
    const arrived = holdNext();
    v.send({ t: "nav", url: `${fx.url}/secure` });
    const first = await arrived;
    const dropped = nextGotoFailure();
    const nav = request(d.socketPath, { op: "navigate", url: `${fx.url}/secure` });
    await dropped;
    // the navigation in flight redirects and loads
    first.writeHead(302, { location: "/login" }).end();
    expect(await nav).toMatchObject({
      ok: true,
      page: { url: `${fx.url}/login`, title: "Login" },
    });
    await v.close();
  });

  it("a navigation dropped for one in flight to the same address that loads without a redirect succeeds", async () => {
    await request(d.socketPath, { op: "navigate", url: "about:blank" });
    const v = await openViewer(d.socketPath, { maxWidth: 480, maxHeight: 300 });
    await v.next((m) => m.t === "state");
    const arrived = holdNext();
    v.send({ t: "nav", url: `${fx.url}/plain` });
    const first = await arrived;
    const dropped = nextGotoFailure();
    const nav = request(d.socketPath, { op: "navigate", url: `${fx.url}/plain` });
    await dropped;
    first
      .writeHead(200, { "content-type": "text/html" })
      .end("<!doctype html><title>Plain</title>");
    expect(await nav).toMatchObject({ ok: true, page: { url: `${fx.url}/plain`, title: "Plain" } });
    await v.close();
  });

  it("a navigation dropped for one in flight that then fails reports that failure", async () => {
    await request(d.socketPath, { op: "navigate", url: "about:blank" });
    const v = await openViewer(d.socketPath, { maxWidth: 480, maxHeight: 300 });
    await v.next((m) => m.t === "state");
    const arrived = holdNext();
    v.send({ t: "nav", url: `${fx.url}/secure` });
    const first = await arrived;
    const dropped = nextGotoFailure();
    const nav = request(d.socketPath, { op: "navigate", url: `${fx.url}/secure` });
    await dropped;
    // the navigation in flight redirects to a port nobody listens on
    first.writeHead(302, { location: "http://127.0.0.1:1/" }).end();
    const r = await nav;
    expect(r).toMatchObject({ ok: false, error: "failed" });
    if (!r.ok) {
      expect(r.message).toMatch(/^net::ERR_\w+ at /);
      expect(r.message).not.toContain("ERR_ABORTED");
    }
    await v.close();
  });

  it("a restored tab's navigation in flight takes over the first navigate to its address", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "cbd-"));
    writeFileSync(
      join(stateDir, "session.json"),
      JSON.stringify({ savedAt: Date.now(), tabs: [`${fx.url}/secure`], active: 0 }),
    );
    const arrived = holdNext();
    const restored = await startTestDaemon({ stateDir, launch: launchWatched });
    try {
      const first = await arrived;
      const dropped = nextGotoFailure();
      const nav = request(restored.socketPath, { op: "navigate", url: `${fx.url}/secure` });
      await dropped;
      first.writeHead(302, { location: "/login" }).end();
      expect(await nav).toMatchObject({
        ok: true,
        page: { url: `${fx.url}/login`, title: "Login" },
      });
    } finally {
      await restored.stop();
      removeDir(stateDir);
    }
  });

  it("a navigation aborted by one to another address is still an error", async () => {
    await request(d.socketPath, { op: "navigate", url: "about:blank" });
    const v = await openViewer(d.socketPath, { maxWidth: 480, maxHeight: 300 });
    await v.next((m) => m.t === "state");
    const arrived = holdNext();
    const nav = request(d.socketPath, { op: "navigate", url: `${fx.url}/secure` });
    await arrived;
    v.send({ t: "nav", url: `${fx.url}/other` });
    const r = await nav;
    expect(r).toMatchObject({ ok: false, error: "failed" });
    if (!r.ok) expect(r.message).toContain("ERR_ABORTED");
    await v.close();
  });
});
