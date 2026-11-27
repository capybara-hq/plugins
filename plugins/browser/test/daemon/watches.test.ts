import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { NO_TAB_TO_WAIT_ON, tabInUse } from "../../daemon/actions.js";
import {
  CONVERSATION_IDLE_MS,
  MAX_WATCHES,
  type ToolReply,
  type ViewerOut,
  WATCH_HEARTBEAT_MS,
  type WatchState,
} from "../../daemon/protocol.js";
import { WATCH_PARK } from "../../daemon/watches.js";
import {
  conv,
  openViewer,
  removeDir,
  request,
  ShiftClock,
  startFixtureServer,
  startTestDaemon,
  type TestDaemon,
} from "./helpers.js";

/**
 * Long waits in the daemon (browser long waits spec §6.2): `watch_start` arms a watch on the
 * conversation's active tab, it latches the first outcome, `watch_poll` is its heartbeat and
 * `watch_end` ends it; a pending watch is its conversation's park (tab ownership spec §6).
 */

// conditions that hold later are bounded far above a loaded machine
const WAIT = { timeout: 20_000 };

const LATER = `<!doctype html><title>Later</title>
<button onclick="setTimeout(() => { out.textContent = 'Payment received' }, 50)">Pay</button>
<p id=out></p><a href="/paid">paid</a>
<button onclick="confirm('Leave this page?')">Ask</button>
<button onclick="alert('Just so you know')">Tell</button>
<a href="/file.txt" download="report.txt">Get</a>`;

let fx: Awaited<ReturnType<typeof startFixtureServer>>;
const daemons: TestDaemon[] = [];
let workspace: string;

beforeAll(async () => {
  workspace = mkdtempSync(join(tmpdir(), "cbd-watch-ws-"));
  fx = await startFixtureServer({
    "/later": LATER,
    "/paid": "<!doctype html><title>Paid</title><p>paid</p>",
    "/file.txt": (_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" }).end("hello download");
    },
  });
});

afterAll(async () => {
  await fx?.close();
  removeDir(workspace);
});

afterEach(async () => {
  for (const d of daemons.splice(0)) {
    await d.stop();
    removeDir(d.stateDir);
  }
});

async function daemon(clock?: ShiftClock): Promise<TestDaemon> {
  const d = await startTestDaemon({
    env: { CAPYBARA_SERVICE_WORKSPACE: workspace },
    downloadWaitMs: 300,
    ...(clock === undefined ? {} : { clock }),
  });
  daemons.push(d);
  return d;
}

const A = conv("a");
const B = conv("b");

const ok = (r: ToolReply) => {
  if (!r.ok) throw new Error(`${r.error}: ${r.message}`);
  return r;
};
const watchOf = (r: ToolReply): WatchState => ok(r).watch as WatchState;

const start = (d: TestDaemon, id: string, condition: object, remainingMs = 600_000, of = A) =>
  request(d.socketPath, { op: "watch_start", watchId: id, condition, remainingMs } as never, of);
const poll = (d: TestDaemon, id: string, of = A) =>
  request(d.socketPath, { op: "watch_poll", watchId: id }, of);
const end = (d: TestDaemon, id: string, of = A) =>
  request(d.socketPath, { op: "watch_end", watchId: id }, of);
const click = async (d: TestDaemon, name: string, of = A) => {
  const snap = ok(await request(d.socketPath, { op: "snapshot" }, of)).text ?? "";
  const ref = new RegExp(`${name}"? \\[ref=(e\\d+)\\]`).exec(snap)?.[1];
  if (ref === undefined) throw new Error(`no ref for ${name} in ${snap}`);
  return request(d.socketPath, { op: "click", ref }, of);
};
const latched = (d: TestDaemon, id: string, of = A) =>
  vi.waitFor(async () => {
    const w = watchOf(await poll(d, id, of));
    expect(w.state).not.toBe("pending");
    return w;
  }, WAIT);

describe("daemon watches", () => {
  it("latch a text that appears after the start; poll answers it, end forgets", async () => {
    const d = await daemon();
    await request(d.socketPath, { op: "navigate", url: `${fx.url}/later` }, A);
    expect(watchOf(await start(d, "w1", { text: "Payment received" })).state).toBe("pending");
    expect(watchOf(await poll(d, "w1")).state).toBe("pending");
    await click(d, "Pay");
    const w = await latched(d, "w1");
    expect(w.state).toBe("met");
    expect(typeof w.at).toBe("string");
    // idempotent per id: a second start answers the latched state
    expect(watchOf(await start(d, "w1", { text: "x" })).state).toBe("met");
    expect(watchOf(await end(d, "w1")).state).toBe("met");
    expect(watchOf(await poll(d, "w1")).state).toBe("unknown");
    expect(watchOf(await end(d, "w1")).state).toBe("unknown");
  });

  it("urlContains and navigation are met by a navigation", async () => {
    const d = await daemon();
    await request(d.socketPath, { op: "navigate", url: `${fx.url}/later` }, A);
    await start(d, "u", { urlContains: "/paid" });
    await start(d, "n", { navigation: true });
    await click(d, "paid");
    expect((await latched(d, "u")).state).toBe("met");
    expect((await latched(d, "n")).state).toBe("met");
  });

  it("a download is met once saved into the workspace, with its path", async () => {
    const d = await daemon();
    await request(d.socketPath, { op: "navigate", url: `${fx.url}/later` }, A);
    await start(d, "dl", { download: true });
    await click(d, "Get");
    const w = await latched(d, "dl");
    expect(w).toMatchObject({
      state: "met",
      detail: join(realpathSync(workspace), "downloads", "report.txt"),
    });
  });

  it("a confirm dialog ends the watch; an alert does not", async () => {
    const d = await daemon();
    await request(d.socketPath, { op: "navigate", url: `${fx.url}/later` }, A);
    await start(d, "dlg", { text: "never shown" });
    await click(d, "Tell");
    expect(watchOf(await poll(d, "dlg")).state).toBe("pending");
    await click(d, "Ask");
    expect(await latched(d, "dlg")).toMatchObject({
      state: "ended",
      reason: "dialog",
      detail: "Leave this page?",
    });
  });

  it("closing the watched tab ends it; the deadline (remainingMs) ends it", async () => {
    const d = await daemon();
    await request(d.socketPath, { op: "navigate", url: `${fx.url}/later` }, A);
    await start(d, "late", { text: "never shown" }, 300);
    expect(await latched(d, "late")).toMatchObject({ state: "ended", reason: "deadline" });
    await start(d, "tab", { text: "never shown" });
    const tabId = ok(await request(d.socketPath, { op: "snapshot" }, A)).page?.tabId as string;
    await request(d.socketPath, { op: "tabs", action: "close", tabId }, A);
    expect(await latched(d, "tab")).toMatchObject({ state: "ended", reason: "tab_closed" });
  });

  it("a conversation without a tab cannot be watched; another conversation's watch is unknown", async () => {
    const d = await daemon();
    const none = await start(d, "x", { text: "a" });
    expect(none).toMatchObject({ ok: false, message: NO_TAB_TO_WAIT_ON });
    await request(d.socketPath, { op: "navigate", url: `${fx.url}/later` }, A);
    await start(d, "mine", { text: "never shown" });
    expect(watchOf(await poll(d, "mine", B)).state).toBe("unknown");
    expect(watchOf(await poll(d, "mine", A)).state).toBe("pending");
  });

  it("a pending watch is the conversation's park: adopt of its tab is refused", async () => {
    const d = await daemon();
    await request(d.socketPath, { op: "navigate", url: `${fx.url}/later` }, A);
    const tabId = ok(await request(d.socketPath, { op: "snapshot" }, A)).page?.tabId as string;
    await start(d, "park", { text: "never shown" });
    expect(d.daemon.state.parksOf("a").map((p) => p.kind)).toEqual([WATCH_PARK]);
    const adopt = await request(d.socketPath, { op: "tabs", action: "adopt", tabId }, B);
    expect(adopt).toMatchObject({ ok: false, message: tabInUse(tabId) });
    await end(d, "park");
    expect(d.daemon.state.parksOf("a")).toEqual([]);
  });

  it("a polled watch keeps the tabs past the idle close; a watch without polls is dropped", async () => {
    const clock = new ShiftClock();
    const d = await daemon(clock);
    await request(d.socketPath, { op: "navigate", url: `${fx.url}/later` }, A);
    await start(d, "hb", { text: "never shown" }, 24 * 3_600_000);
    // polled within the heartbeat, longer than the idle close in all
    clock.advance(WATCH_HEARTBEAT_MS - 60_000);
    expect(watchOf(await poll(d, "hb")).state).toBe("pending");
    clock.advance(WATCH_HEARTBEAT_MS - 60_000);
    expect(watchOf(await poll(d, "hb")).state).toBe("pending");
    expect(2 * (WATCH_HEARTBEAT_MS - 60_000)).toBeGreaterThan(CONVERSATION_IDLE_MS);
    expect(ok(await request(d.socketPath, { op: "tabs", action: "list" }, A)).text).toContain(
      "Later",
    );
    // no poll for a heartbeat: dropped, and the park with it
    clock.advance(WATCH_HEARTBEAT_MS + 1_000);
    await vi.waitFor(() => expect(d.daemon.state.parksOf("a")).toEqual([]), WAIT);
    expect(watchOf(await poll(d, "hb")).state).toBe("unknown");
  });

  it("past MAX_WATCHES a start drops the oldest latched watch", async () => {
    const d = await daemon();
    await request(d.socketPath, { op: "navigate", url: `${fx.url}/later` }, A);
    await start(d, "first", { text: "never shown" });
    await start(d, "done", { urlContains: "/later" });
    expect((await latched(d, "done")).state).toBe("met");
    for (let i = 2; i < MAX_WATCHES; i++) await start(d, `w${i}`, { text: "never shown" });
    await start(d, "last", { text: "never shown" });
    expect(watchOf(await poll(d, "done")).state).toBe("unknown");
    expect(watchOf(await poll(d, "first")).state).toBe("pending");
  });

  it("watch ops run while taken over, keep a pending handoff, and only watch_end carries the hand back note", async () => {
    const d = await daemon();
    await request(d.socketPath, { op: "navigate", url: `${fx.url}/later` }, A);
    await request(d.socketPath, { op: "handoff_notice", callId: "h1", message: "Sign in" }, A);
    const v = await openViewer(d.socketPath, { maxWidth: 320, maxHeight: 200 }, A);
    await v.next((m) => m.t === "state");
    const taken = v.after((m) => m.t === "state" && m.control === "user");
    v.send({ t: "takeover" });
    await taken;
    expect(watchOf(await start(d, "tk", { text: "never shown" })).state).toBe("pending");
    expect(d.daemon.state.handoffOf("a")?.callId).toBe("h1");
    const back = v.after((m) => m.t === "state" && m.control === "agent");
    v.send({ t: "handback" });
    await back;
    const polled = ok(await poll(d, "tk"));
    expect(polled.userControlledSince).toBeUndefined();
    const ended = ok(await end(d, "tk"));
    expect(typeof ended.userControlledSince).toBe("string");
    await v.close();
  });

  it("viewers of the watching tree see what it waits for; other trees do not", async () => {
    const d = await daemon();
    await request(d.socketPath, { op: "navigate", url: `${fx.url}/later` }, A);
    await request(d.socketPath, { op: "navigate", url: `${fx.url}/paid` }, B);
    const va = await openViewer(d.socketPath, { maxWidth: 320, maxHeight: 200 }, A);
    const vb = await openViewer(d.socketPath, { maxWidth: 320, maxHeight: 200 }, B);
    await va.next((m) => m.t === "state");
    await vb.next((m) => m.t === "state");
    await start(d, "seen", { text: "Payment received" });
    const s = (await va.next((m) => m.t === "state" && m.waiting !== undefined)) as Extract<
      ViewerOut,
      { t: "state" }
    >;
    expect(s.waiting?.label).toBe('text "Payment received"');
    expect(Number.isNaN(Date.parse(s.waiting?.until ?? ""))).toBe(false);
    expect(
      vb.messages.some(
        (m) => m.t === "state" && (m as { waiting?: unknown }).waiting !== undefined,
      ),
    ).toBe(false);
    await va.close();
    await vb.close();
  });

  it("a short wait takes urlContains and download", async () => {
    const d = await daemon();
    await request(d.socketPath, { op: "navigate", url: `${fx.url}/later` }, A);
    const [url] = await Promise.all([
      request(d.socketPath, { op: "wait", urlContains: "/paid", timeoutMs: 20_000 }, A),
      click(d, "paid"),
    ]);
    expect(url.ok).toBe(true);
    await request(d.socketPath, { op: "navigate", url: `${fx.url}/later` }, B);
    const [dl] = await Promise.all([
      request(d.socketPath, { op: "wait", download: true, timeoutMs: 20_000 }, B),
      click(d, "Get", B),
    ]);
    expect(ok(dl).text).toContain("Waited for the download:");
    const late = await request(
      d.socketPath,
      { op: "wait", urlContains: "/never", timeoutMs: 200 },
      A,
    );
    expect(late).toMatchObject({ ok: false, error: "timeout" });
  });
});
