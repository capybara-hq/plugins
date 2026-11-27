// The phone viewport and touch input of a takeover (dialogs spec §7): only the person in control
// switches, hand back restores the desktop profile before any agent request, and touch input is
// dispatched as touch (phone) or translated (desktop).
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { ToolReply, ViewerOut } from "../../daemon/protocol.js";
import { TouchTranslator } from "../../daemon/viewport.js";
import {
  conv,
  openViewer,
  removeDir,
  request,
  startFixtureServer,
  startTestDaemon,
  type TestDaemon,
  type TestFrame,
  type TestViewer,
  type ViewerMsg,
} from "./helpers.js";

const PAGE = `<!doctype html><meta name="viewport" content="width=device-width"><title>VP</title>
<style>body{margin:0;height:3000px} #far{position:fixed;left:1180px;top:700px;width:80px;height:60px}</style>
<p id="size"></p><p id="log"></p><button id="far" onclick="note('far')">far</button>
<script>
  const log = [];
  const note = (s) => { log.push(s); document.getElementById("log").textContent = log.join(" "); };
  const size = () => note("size:" + innerWidth + "x" + innerHeight +
      ":coarse=" + matchMedia("(pointer: coarse)").matches + ":mobile=" + navigator.userAgent.includes("Mobile"));
  addEventListener("resize", size); size();
  addEventListener("touchstart", (e) => note("touchstart@" + Math.round(e.touches[0].clientY)));
  addEventListener("click", (e) => note("click@" + Math.round(e.clientX) + "," + Math.round(e.clientY)));
  addEventListener("mousedown", (e) => note("down@" + Math.round(e.clientY) + ":" + innerWidth +
    ":coarse=" + matchMedia("(pointer: coarse)").matches + ":mobile=" + navigator.userAgent.includes("Mobile")));
  addEventListener("scroll", () => note("scrolled"), { once: true });
</script>`;

let fx: Awaited<ReturnType<typeof startFixtureServer>>;
const daemons: TestDaemon[] = [];

beforeAll(async () => {
  fx = await startFixtureServer({
    "/vp": PAGE,
    "/vp2": PAGE.replace("<title>VP</title>", "<title>VP2</title>"),
  });
});

afterAll(async () => {
  await fx?.close();
});

afterEach(async () => {
  for (const d of daemons.splice(0)) {
    await d.stop();
    removeDir(d.stateDir);
  }
});

async function daemon(): Promise<TestDaemon> {
  const d = await startTestDaemon();
  daemons.push(d);
  return d;
}

const ok = (r: ToolReply) => {
  if (!r.ok) throw new Error(`${r.error}: ${r.message}`);
  return r;
};

type State = Extract<ViewerOut, { t: "state" }>;
const stateWith = (pred: (s: State) => boolean) => (m: ViewerMsg) => m.t === "state" && pred(m);
const text = async (d: TestDaemon, of = conv("c1")) =>
  ok(await request(d.socketPath, { op: "snapshot" }, of)).text ?? "";

async function takeover(v: TestViewer): Promise<void> {
  v.send({ t: "takeover" });
  await v.after(stateWith((s) => s.control === "user"));
}

async function handback(v: TestViewer): Promise<void> {
  v.send({ t: "handback" });
  await v.after(stateWith((s) => s.control === "agent"));
}

describe("viewport profiles", () => {
  it("only the person in control switches; phone is 390x844 mobile with touch on every tab, new ones too; hand back restores desktop before the next request", async () => {
    const d = await daemon();
    ok(await request(d.socketPath, { op: "navigate", url: `${fx.url}/vp` }));
    ok(await request(d.socketPath, { op: "navigate", url: `${fx.url}/vp` }, conv("c2")));
    const v = await openViewer(d.socketPath, { maxWidth: 640, maxHeight: 900 });
    await v.next(stateWith((s) => s.viewport.width === 1280));
    // the live view is up (its first frame) before the person takes over
    await v.next((m) => m.t === "frame");
    // without control: refused
    v.send({ t: "viewport", profile: "phone" });
    await takeover(v);
    expect(
      v.messages.filter((m) => m.t === "state").every((m) => (m as State).viewport.width === 1280),
    ).toBe(true);
    v.send({ t: "viewport", profile: "phone" });
    await v.after(stateWith((s) => s.viewport.width === 390 && s.viewport.mobile));
    // input reaches y 843 in phone (the desktop clamp would stop at 799)
    v.send({ t: "mouse", kind: "down", x: 10, y: 843 });
    v.send({ t: "mouse", kind: "up", x: 10, y: 843 });
    ok(await request(d.socketPath, { op: "wait", text: "down@843", timeoutMs: 10_000 }));
    // (the page reads its metrics, pointer and user agent at the press)
    // the screencast follows: the page changed, its frames are portrait
    const frame = (await v.next((m) => m.t === "frame" && m.height > m.width)) as TestFrame;
    expect(frame.height).toBeGreaterThan(frame.width);
    // a tab opened now gets the profile too
    v.send({ t: "tab", action: "open" });
    v.send({ t: "nav", url: `${fx.url}/vp2` });
    await v.after(
      stateWith((s) => !s.loading && s.tabs.some((t) => t.active && t.title === "VP2")),
    );
    ok(await request(d.socketPath, { op: "wait", text: "size:390x844", timeoutMs: 10_000 }));
    // the agent's next request waits for the restore (a queued click at desktop coordinates hits)
    v.send({ t: "handback" });
    const click = ok(await request(d.socketPath, { op: "click_at", x: 1200, y: 720 }));
    expect(click.ok).toBe(true);
    // the new tab had the phone size (its first document may keep the desktop user agent until a
    // reload), and the agent's click at desktop coordinates hit
    const page = await text(d);
    expect(page).toContain("size:390x844:");
    expect(page).toContain("far");
    const shot = ok(await request(d.socketPath, { op: "screenshot", maxBytes: 2_000_000 }));
    expect(shot.text).toContain("Screenshot 1280x800");
    ok(await request(d.socketPath, { op: "tabs", action: "switch", tabId: "t1" }));
    expect(await text(d)).toContain("down@843:390:coarse=true:mobile=true");
    // the other conversation's tab is back on desktop too
    const other = ok(
      await request(d.socketPath, { op: "screenshot", maxBytes: 2_000_000 }, conv("c2")),
    );
    expect(other.text).toContain("Screenshot 1280x800");
    await v.close();
  });
});

describe("touch input", () => {
  it("a tap in phone dispatches touch events; in desktop it clicks and a pan scrolls", async () => {
    const d = await daemon();
    ok(await request(d.socketPath, { op: "navigate", url: `${fx.url}/vp` }));
    const v = await openViewer(d.socketPath, { maxWidth: 640, maxHeight: 900 });
    await takeover(v);
    // desktop: tap is a click
    v.send({ t: "touch", kind: "start", points: [{ id: 1, x: 100, y: 300 }] });
    v.send({ t: "touch", kind: "end", points: [] });
    // desktop: a one-finger pan scrolls
    v.send({ t: "touch", kind: "start", points: [{ id: 2, x: 100, y: 500 }] });
    v.send({ t: "touch", kind: "move", points: [{ id: 2, x: 100, y: 300 }] });
    v.send({ t: "touch", kind: "end", points: [] });
    v.send({ t: "viewport", profile: "phone" });
    await v.after(stateWith((s) => s.viewport.width === 390));
    v.send({ t: "touch", kind: "start", points: [{ id: 3, x: 50, y: 60 }] });
    v.send({ t: "touch", kind: "end", points: [] });
    // the agent may wait during a takeover: until the page saw the touch (hand back drops input
    // still queued)
    ok(await request(d.socketPath, { op: "wait", text: "touchstart@", timeoutMs: 30_000 }));
    await handback(v);
    const page = await text(d);
    expect(page).toContain("click@100,300");
    expect(page).toContain("scrolled");
    expect(page).toMatch(/touchstart@\d+/);
    await v.close();
  });
});

describe("TouchTranslator", () => {
  it("ignores two-finger gestures and long presses", () => {
    let now = 0;
    const t = new TouchTranslator(() => now);
    t.feed("start", [{ id: 1, x: 1, y: 1 }]);
    t.feed("start", [
      { id: 1, x: 1, y: 1 },
      { id: 2, x: 5, y: 5 },
    ]);
    expect(t.feed("end", [])).toEqual([]);
    t.feed("start", [{ id: 3, x: 1, y: 1 }]);
    now = 600;
    expect(t.feed("end", [])).toEqual([]);
    t.feed("start", [{ id: 4, x: 7, y: 8 }]);
    expect(t.feed("end", [])).toEqual([{ kind: "click", x: 7, y: 8 }]);
  });
});
