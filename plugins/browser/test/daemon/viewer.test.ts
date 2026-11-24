import { connect } from "node:net";
import { encodeServiceMessage } from "@capybara-hq/plugin-sdk";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { startDaemon } from "../../daemon/main.js";
import { HANDOFF_MAX_CHARS, MAX_TABS, type ViewerOut } from "../../daemon/protocol.js";
import {
  jpegSize,
  openViewer,
  removeDir,
  request,
  startFixtureServer,
  startTestDaemon,
  TEST_BROWSERS,
  type TestDaemon,
} from "./helpers.js";

const SIZE = `<!doctype html><title>Size</title><p id=s></p><script>
function u() { s.textContent = "w=" + innerWidth + " h=" + innerHeight; }
u(); addEventListener("resize", u);</script>`;
const ALERT = `<!doctype html><title>Alert</title>
<button onclick="alert('hello from fixture')">Alert</button>`;
const BUTTON = `<!doctype html><title>Button</title><button>Press</button>`;
const ANIM = `<!doctype html><title>Anim</title><div id=b style="width:300px;height:200px"></div>
<script>let n = 0; (function f() { b.style.background = "hsl(" + (n++ % 360) + ",80%,50%)";
requestAnimationFrame(f); })();</script>`;
const POPUPS = `<!doctype html><title>Popups</title>
<button onclick="for (let i = 0; i < 3; i++) window.open('about:blank#' + i)">Open</button>`;

type Frame = Extract<ViewerOut, { t: "frame" }>;
type State = Extract<ViewerOut, { t: "state" }>;
const isFrame = (m: ViewerOut): m is Frame => m.t === "frame";
const isState = (m: ViewerOut): m is State => m.t === "state";

let fx: Awaited<ReturnType<typeof startFixtureServer>>;
let d: TestDaemon;
// the /slow page answers when the test releases it
let slowHit: () => void = () => undefined;
let releaseSlow: () => void = () => undefined;

beforeAll(async () => {
  fx = await startFixtureServer({
    "/size": SIZE,
    "/alert": ALERT,
    "/button": BUTTON,
    "/anim": ANIM,
    "/popups": POPUPS,
    "/slow": (_req, res) => {
      releaseSlow = () => res.writeHead(200, { "content-type": "text/html" }).end(BUTTON);
      slowHit();
    },
  });
  d = await startTestDaemon();
});

afterAll(async () => {
  await d?.stop();
  await fx?.close();
  if (d) removeDir(d.stateDir);
});

describe("browser daemon viewer", () => {
  it("a new viewer gets the full state and a first frame at once", async () => {
    await request(d.socketPath, { op: "navigate", url: `${fx.url}/button` });
    const v = await openViewer(d.socketPath, { maxWidth: 480, maxHeight: 300 });
    const state = await v.next(isState);
    expect(state).toMatchObject({ control: "agent", loading: false, secure: false });
    expect(state.tabs.some((t) => t.active && t.url === `${fx.url}/button`)).toBe(true);
    await v.next(isFrame);
    await v.close();
  });

  it("viewer receives frames no larger than its maxWidth", async () => {
    await request(d.socketPath, { op: "navigate", url: `${fx.url}/button` });
    const v = await openViewer(d.socketPath, { maxWidth: 320, maxHeight: 200 });
    const f = await v.next(isFrame);
    expect(f.width).toBeLessThanOrEqual(320);
    expect(f.height).toBeLessThanOrEqual(200);
    const real = jpegSize(f.jpeg);
    expect(real.width).toBeLessThanOrEqual(320);
    expect(real).toEqual({ width: f.width, height: f.height });
    await v.close();
  });

  it("viewport stays 1280x800 after a viewer resize", async () => {
    await request(d.socketPath, { op: "navigate", url: `${fx.url}/size` });
    const v = await openViewer(d.socketPath, { maxWidth: 640, maxHeight: 400 });
    await v.next(isFrame);
    const after = v.after((m) => isFrame(m) && m.width <= 400);
    v.send({ t: "resize", maxWidth: 400, maxHeight: 250 });
    await after;
    const snap = await request(d.socketPath, { op: "snapshot" });
    if (!snap.ok) throw new Error(snap.message);
    expect(snap.text).toContain("w=1280 h=800");
    await v.close();
  });

  it("agent input refused while taken over from any viewer", async () => {
    await request(d.socketPath, { op: "navigate", url: `${fx.url}/button` });
    const v = await openViewer(d.socketPath, { maxWidth: 480, maxHeight: 300 });
    await v.next(isState);
    const taken = v.after((m) => isState(m) && m.control === "user");
    v.send({ t: "takeover" });
    await taken;
    const [a, b, nav] = await Promise.all([
      request(d.socketPath, { op: "click", ref: "e1" }),
      request(d.socketPath, { op: "snapshot" }),
      request(d.socketPath, { op: "navigate", url: `${fx.url}/size` }),
    ]);
    for (const r of [a, b, nav]) expect(r).toMatchObject({ ok: false, error: "taken_over" });
    // a second viewer (another conversation's panel) sees who holds it
    const v2 = await openViewer(d.socketPath, { maxWidth: 480, maxHeight: 300 });
    expect(await v2.next(isState)).toMatchObject({ control: "user" });
    const back = v.after((m) => isState(m) && m.control === "agent");
    v.send({ t: "handback" });
    await back;
    const first = await request(d.socketPath, { op: "snapshot" });
    expect(first.ok && typeof first.userControlledSince === "string").toBe(true);
    const second = await request(d.socketPath, { op: "snapshot" });
    expect(second.ok && second.userControlledSince).toBeFalsy();
    await v.close();
    await v2.close();
  });

  it("alert dialog surfaces to tool reply and viewer", async () => {
    await request(d.socketPath, { op: "navigate", url: `${fx.url}/alert` });
    const v = await openViewer(d.socketPath, { maxWidth: 480, maxHeight: 300 });
    await v.next(isState);
    const snap = await request(d.socketPath, { op: "snapshot" });
    if (!snap.ok) throw new Error(snap.message);
    const ref = snap.text?.match(/button "Alert" \[ref=((?:f\d+)?e\d+)\]/)?.[1] ?? "";
    const dialog = v.after((m) => m.t === "dialog");
    const click = await request(d.socketPath, { op: "click", ref });
    if (!click.ok) throw new Error(click.message);
    expect(click.text).toContain("hello from fixture");
    expect(await dialog).toEqual({ t: "dialog", kind: "alert", message: "hello from fixture" });
    await v.close();
  });

  it("viewer clicks reach the page and agent clicks show as lastClick", async () => {
    await request(d.socketPath, { op: "navigate", url: `${fx.url}/button` });
    const v = await openViewer(d.socketPath, { maxWidth: 480, maxHeight: 300 });
    await v.next(isState);
    const clicked = v.after((m) => isState(m) && m.lastClick !== undefined);
    const r = await request(d.socketPath, { op: "click_at", x: 30, y: 20 });
    expect(r.ok).toBe(true);
    expect(await clicked).toMatchObject({ lastClick: { x: 30, y: 20 } });
    const seq = ((await clicked) as State).lastClick?.seq ?? 0;
    expect(seq).toBeGreaterThan(0);
    // every agent click gets a new sequence number, so a viewer flashes only new clicks
    const again = v.after((m) => isState(m) && (m.lastClick?.seq ?? 0) > seq);
    expect((await request(d.socketPath, { op: "click_at", x: 30, y: 20 })).ok).toBe(true);
    expect(((await again) as State).lastClick).toEqual({ x: 30, y: 20, seq: seq + 1 });
    await v.close();
  });

  it("caps a viewer at 5 frames per second on an animated page", async () => {
    await request(d.socketPath, { op: "navigate", url: `${fx.url}/anim` });
    const v = await openViewer(d.socketPath, { maxWidth: 320, maxHeight: 200 });
    await v.next(isFrame);
    const from = v.messages.length;
    await new Promise((r) => setTimeout(r, 2000));
    const frames = v.messages.slice(from).filter(isFrame).length;
    expect(frames).toBeGreaterThan(2);
    // 5 per second over 2 s, one of slack for the timing of the window
    expect(frames).toBeLessThanOrEqual(11);
    await v.close();
  });

  it("popups count toward the tab limit; extras are closed with a note", async () => {
    await request(d.socketPath, { op: "navigate", url: `${fx.url}/button` });
    for (;;) {
      const list = await request(d.socketPath, { op: "tabs", action: "list" });
      if (!list.ok) throw new Error(list.message);
      if ((list.text ?? "").split("\n").length >= MAX_TABS - 1) break;
      await request(d.socketPath, { op: "tabs", action: "open" });
    }
    await request(d.socketPath, { op: "navigate", url: `${fx.url}/popups` });
    const snap = await request(d.socketPath, { op: "snapshot" });
    if (!snap.ok) throw new Error(snap.message);
    const ref = snap.text?.match(/button "Open" \[ref=((?:f\d+)?e\d+)\]/)?.[1] ?? "";
    const r = await request(d.socketPath, { op: "click", ref });
    if (!r.ok) throw new Error(r.message);
    await vi.waitFor(async () => {
      const list = await request(d.socketPath, { op: "tabs", action: "list" });
      if (!list.ok) throw new Error(list.message);
      expect((list.text ?? "").split("\n")).toHaveLength(MAX_TABS);
    });
    const later = await request(d.socketPath, { op: "snapshot" });
    const notes = `${r.ok ? (r.text ?? "") : ""}\n${later.ok ? (later.text ?? "") : ""}`;
    expect(notes).toMatch(/popup.*closed/i);
    // back to one tab for the tests after this one
    for (;;) {
      const list = await request(d.socketPath, { op: "tabs", action: "list" });
      if (!list.ok) throw new Error(list.message);
      const ids = (list.text ?? "").split("\n").map((l) => l.split(/[: ]/)[0] ?? "");
      if (ids.length <= 1) break;
      await request(d.socketPath, { op: "tabs", action: "close", tabId: ids[0] });
    }
  });

  it("a request queued behind a slow one is refused when a takeover begins meanwhile", async () => {
    await request(d.socketPath, { op: "navigate", url: `${fx.url}/button` });
    const v = await openViewer(d.socketPath, { maxWidth: 320, maxHeight: 200 });
    await v.next(isState);
    const hit = new Promise<void>((r) => {
      slowHit = r;
    });
    const slow = request(d.socketPath, { op: "navigate", url: `${fx.url}/slow` });
    await hit; // the navigation runs and holds the queue
    const queued = request(d.socketPath, { op: "press", key: "Tab" });
    await vi.waitFor(() => expect(d.daemon.state.requestsInFlight).toBe(2));
    const taken = v.after((m) => isState(m) && m.control === "user");
    v.send({ t: "takeover" });
    await taken;
    releaseSlow();
    expect((await slow).ok).toBe(true); // a running action is left to finish
    expect(await queued).toMatchObject({ ok: false, error: "taken_over" });
    const back = v.after((m) => isState(m) && m.control === "agent");
    v.send({ t: "handback" });
    await back;
    await v.close();
  });
});

describe("browser daemon handoff notice", () => {
  it("viewers see the pending handoff; the latest wins; only its callId clears it", async () => {
    const v = await openViewer(d.socketPath, { maxWidth: 320, maxHeight: 200 });
    await v.next(isState);
    const first = v.after((m) => isState(m) && m.handoff?.callId === "c1");
    expect(
      await request(d.socketPath, { op: "handoff_notice", callId: "c1", message: "Log in" }),
    ).toMatchObject({ ok: true });
    expect(await first).toMatchObject({ handoff: { callId: "c1", message: "Log in" } });
    // allowed while the person holds control; a long message is cut to 4 KB
    const taken = v.after((m) => isState(m) && m.control === "user");
    v.send({ t: "takeover" });
    await taken;
    const second = v.after((m) => isState(m) && m.handoff?.callId === "c2");
    const notice = await request(d.socketPath, {
      op: "handoff_notice",
      callId: "c2",
      message: "x".repeat(10_000),
    });
    expect(notice.ok).toBe(true);
    const s2 = (await second) as State;
    expect(s2.handoff?.message.length).toBeLessThanOrEqual(HANDOFF_MAX_CHARS);
    // a new viewer (a remounted panel) gets it in its first state
    const v2 = await openViewer(d.socketPath, { maxWidth: 320, maxHeight: 200 });
    expect((await v2.next(isState)).handoff?.callId).toBe("c2");
    // a stale clear changes nothing; the matching one clears
    expect(await request(d.socketPath, { op: "handoff_clear", callId: "c1" })).toMatchObject({
      ok: true,
    });
    const cleared = v.after((m) => isState(m) && m.handoff === undefined);
    expect(await request(d.socketPath, { op: "handoff_clear", callId: "c2" })).toMatchObject({
      ok: true,
    });
    await cleared;
    expect(d.daemon.state.handoff).toBeUndefined();
    const back = v.after((m) => isState(m) && m.control === "agent");
    v.send({ t: "handback" });
    await back;
    await v.close();
    await v2.close();
  });
});

describe("browser daemon handoff answered during a takeover", () => {
  it("handoff_clear with handback ends the takeover before the snapshot", async () => {
    const v = await openViewer(d.socketPath, { maxWidth: 320, maxHeight: 200 });
    await v.next(isState);
    const taken = v.after((m) => isState(m) && m.control === "user");
    v.send({ t: "takeover" });
    await taken;
    await request(d.socketPath, { op: "handoff_notice", callId: "hb", message: "Sign in" });
    const back = v.after((m) => isState(m) && m.control === "agent" && m.handoff === undefined);
    expect(
      await request(d.socketPath, { op: "handoff_clear", callId: "hb", handback: true }),
    ).toMatchObject({ ok: true });
    await back;
    const snap = await request(d.socketPath, { op: "snapshot" });
    expect(snap.ok && typeof snap.userControlledSince === "string").toBe(true);
    await v.close();
  });

  it("a clear without handback leaves the takeover", async () => {
    const v = await openViewer(d.socketPath, { maxWidth: 320, maxHeight: 200 });
    await v.next(isState);
    const taken = v.after((m) => isState(m) && m.control === "user");
    v.send({ t: "takeover" });
    await taken;
    await request(d.socketPath, { op: "handoff_notice", callId: "nb", message: "Sign in" });
    await request(d.socketPath, { op: "handoff_clear", callId: "nb" });
    expect(d.daemon.state.control).toBe("user");
    const back = v.after((m) => isState(m) && m.control === "agent");
    v.send({ t: "handback" });
    await back;
    await v.close();
  });
});

describe("browser daemon handoff after an aborted run", () => {
  it("the next agent tool request drops a handoff that was never cleared", async () => {
    const v = await openViewer(d.socketPath, { maxWidth: 320, maxHeight: 200 });
    await v.next(isState);
    const shown = v.after((m) => isState(m) && m.handoff?.callId === "aborted");
    await request(d.socketPath, { op: "handoff_notice", callId: "aborted", message: "Solve it" });
    await shown;
    // another handoff op leaves it
    await request(d.socketPath, { op: "handoff_clear", callId: "other" });
    expect(d.daemon.state.handoff?.callId).toBe("aborted");
    const dropped = v.after((m) => isState(m) && m.handoff === undefined);
    const snap = await request(d.socketPath, { op: "snapshot" });
    expect(snap.ok).toBe(true);
    await dropped;
    expect(d.daemon.state.handoff).toBeUndefined();
    await v.close();
  });
});

describe("browser daemon viewer before Chromium is ready", () => {
  it("a stream closed before ready leaves no viewer counted", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const stateDir = mkdtempSync(join(tmpdir(), "cbd-"));
    const socketPath = join(stateDir, "sock");
    const daemon = await startDaemon({
      socketPath,
      stateDir,
      env: {},
      browsersPath: TEST_BROWSERS,
    });
    let ready = false;
    daemon.ready.then(() => {
      ready = true;
    });
    try {
      await new Promise<void>((resolve) => {
        const sock = connect(socketPath, () => {
          sock.write(encodeServiceMessage(new TextEncoder().encode('{"kind":"stream"}')));
          sock.end();
        });
        sock.on("close", () => resolve());
      });
      expect(ready).toBe(false);
      await vi.waitFor(() => expect(daemon.state.viewerCount).toBe(0));
      await daemon.ready;
      expect(daemon.state.viewerCount).toBe(0);
    } finally {
      await daemon.close();
      removeDir(stateDir);
    }
  });
});
