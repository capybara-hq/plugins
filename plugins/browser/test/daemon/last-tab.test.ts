import type { BrowserContext, Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { browserProcessId, killChromium, launchChromium } from "../../daemon/chromium.js";
import type { ViewerOut } from "../../daemon/protocol.js";
import {
  openViewer,
  removeDir,
  request,
  startFixtureServer,
  startTestDaemon,
  type TestDaemon,
  type ViewerMsg,
} from "./helpers.js";

type State = Extract<ViewerOut, { t: "state" }>;
const isState = (m: ViewerMsg): m is State => m.t === "state";

let d: TestDaemon;

beforeAll(async () => {
  d = await startTestDaemon();
});

afterAll(async () => {
  await d?.stop();
  if (d) removeDir(d.stateDir);
});

/** The ids of the conversation's own tabs, from the tab list. */
async function tabIds(): Promise<string[]> {
  const r = await request(d.socketPath, { op: "tabs", action: "list" });
  if (!r.ok) throw new Error(r.message);
  // its own tabs come first, before any heading of other conversations' tabs
  const own: string[] = [];
  for (const l of (r.text ?? "").split("\n")) {
    const id = /^(t\d+)/.exec(l)?.[1];
    if (id === undefined) break;
    own.push(id);
  }
  return own;
}

/** Opens tabs until there are exactly two; their ids. */
async function twoTabs(): Promise<[string, string]> {
  let ids = await tabIds();
  while (ids.length < 2) {
    await request(d.socketPath, { op: "tabs", action: "open" });
    ids = await tabIds();
  }
  for (const id of ids.slice(0, -2)) {
    await request(d.socketPath, { op: "tabs", action: "close", tabId: id });
  }
  ids = await tabIds();
  const [a, b] = ids;
  if (ids.length !== 2 || a === undefined || b === undefined)
    throw new Error(`expected two tabs, got ${ids.join(", ")}`);
  return [a, b];
}

describe("closing the last tabs", () => {
  it("two quick closes by the agent leave none; the next acting calls open exactly one", async () => {
    const [a, b] = await twoTabs();
    const replies = await Promise.all([
      request(d.socketPath, { op: "tabs", action: "close", tabId: a }),
      request(d.socketPath, { op: "tabs", action: "close", tabId: b }),
      request(d.socketPath, { op: "tabs", action: "list" }),
    ]);
    for (const r of replies) expect(r).toMatchObject({ ok: true });
    expect(await tabIds()).toHaveLength(0);
    // a wait opens no tab; a snapshot and a screenshot at once share the one new tab
    expect(await request(d.socketPath, { op: "wait", timeoutMs: 0 })).toMatchObject({
      ok: true,
      tabs: { open: 0, max: 6 },
    });
    const [w, s] = await Promise.all([
      request(d.socketPath, { op: "screenshot", maxBytes: 200_000 }),
      request(d.socketPath, { op: "snapshot" }),
    ]);
    expect(w).toMatchObject({ ok: true, tabs: { open: 1, max: 6 } });
    expect(s.ok && w.ok && s.page?.tabId).toBe(w.ok ? w.page?.tabId : "");
    expect(await tabIds()).toHaveLength(1);
  });

  it("two quick closes by the person leave none; the viewer opens no tab", async () => {
    const [a, b] = await twoTabs();
    const v = await openViewer(d.socketPath, { maxWidth: 480, maxHeight: 300 });
    await v.next(isState);
    const taken = v.after((m) => isState(m) && m.control === "user");
    v.send({ t: "takeover" });
    await taken;
    const none = v.after((m) => isState(m) && m.tabs.length === 0 && m.shown === undefined);
    v.send({ t: "tab", action: "close", tabId: a });
    v.send({ t: "tab", action: "close", tabId: b });
    await none;
    const back = v.after((m) => isState(m) && m.control === "agent");
    v.send({ t: "handback" });
    await back;
    expect(await tabIds()).toHaveLength(0);
    await v.close();
  });
});

describe("closing the browser's last page", () => {
  it("never leaves Chromium without a page: the viewer stays connected and shows the empty tree", async () => {
    // A desktop Chromium ends when its last window closes (outside macOS), which the daemon then
    // treats as a crash: every viewer's stream is cut and the panel reconnects (the Windows report:
    // the skeleton, then the empty tree). The test models that rule on every platform: Chromium is
    // killed as soon as it has no page left.
    let emptied = false;
    let gone = 0;
    const site = await startFixtureServer({
      "/a": (_req, res) =>
        res.writeHead(200, { "content-type": "text/html" }).end("<title>A</title>"),
    });
    const w = await startTestDaemon({
      onBrowserGone: () => gone++,
      launch: async (plan) => {
        const ctx: BrowserContext = await launchChromium(plan);
        const pid = await browserProcessId(ctx);
        const watch = (p: Page) =>
          p.on("close", () => {
            if (ctx.pages().length > 0 || emptied) return;
            emptied = true;
            if (pid !== undefined) killChromium(pid);
          });
        for (const p of ctx.pages()) watch(p);
        ctx.on("page", watch);
        return ctx;
      },
    });
    try {
      // the conversation's tab is the browser's only page (it claims the start's blank tab)
      const nav = await request(w.socketPath, { op: "navigate", url: `${site.url}/a` });
      expect(nav).toMatchObject({ ok: true, tabs: { open: 1 } });
      const v = await openViewer(w.socketPath, { maxWidth: 480, maxHeight: 300 });
      const first = await v.next((m): m is State => isState(m) && m.tabs.length === 1);
      const taken = v.after((m) => isState(m) && m.control === "user");
      v.send({ t: "takeover" });
      await taken;
      const none = v.after((m) => isState(m) && m.tabs.length === 0 && m.shown === undefined);
      v.send({ t: "tab", action: "close", tabId: first.tabs[0]?.id ?? "" });
      await none;
      // the stream still answers: a hand back comes back as a state on the same connection
      const back = v.after((m) => isState(m) && m.control === "agent");
      v.send({ t: "handback" });
      await back;
      expect(emptied).toBe(false);
      expect(gone).toBe(0);
      // the next acting call uses the kept blank page: still one browser, one tab
      expect(await request(w.socketPath, { op: "snapshot" })).toMatchObject({
        ok: true,
        tabs: { open: 1 },
      });
      expect(gone).toBe(0);
      await v.close();
    } finally {
      await w.stop();
      removeDir(w.stateDir);
      await site.close();
    }
  });
});
