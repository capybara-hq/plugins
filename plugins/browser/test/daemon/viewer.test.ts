import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ViewerOut } from "../../daemon/protocol.js";
import {
  jpegSize,
  openViewer,
  removeDir,
  request,
  startFixtureServer,
  startTestDaemon,
  type TestDaemon,
} from "./helpers.js";

const SIZE = `<!doctype html><title>Size</title><p id=s></p><script>
function u() { s.textContent = "w=" + innerWidth + " h=" + innerHeight; }
u(); addEventListener("resize", u);</script>`;
const ALERT = `<!doctype html><title>Alert</title>
<button onclick="alert('hello from fixture')">Alert</button>`;
const BUTTON = `<!doctype html><title>Button</title><button>Press</button>`;

type Frame = Extract<ViewerOut, { t: "frame" }>;
type State = Extract<ViewerOut, { t: "state" }>;
const isFrame = (m: ViewerOut): m is Frame => m.t === "frame";
const isState = (m: ViewerOut): m is State => m.t === "state";

let fx: Awaited<ReturnType<typeof startFixtureServer>>;
let d: TestDaemon;

beforeAll(async () => {
  fx = await startFixtureServer({ "/size": SIZE, "/alert": ALERT, "/button": BUTTON });
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
    await v.close();
  });
});
