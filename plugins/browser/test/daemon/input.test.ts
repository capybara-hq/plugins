import type { ServerResponse } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
/** The page reports into its URL's fragment (a same-document navigation updates the state). */
const fragment = (m: State) => decodeURIComponent(new URL(activeUrl(m)).hash.slice(1));
const activeUrl = (m: State) => m.tabs.find((t) => t.active)?.url ?? "";
const reported = (prefix: string) => (m: ViewerMsg) => isState(m) && fragment(m).startsWith(prefix);

const INNER = `<!doctype html><body style="margin:0"><a href="#in" style="display:block;height:200px">inner</a>`;
const page = (crossOrigin: string) => `<!doctype html><title>t0</title>
<style>body{margin:0;font:16px sans-serif} .abs{position:absolute}</style>
<button id=b class=abs style="left:0;top:0;width:200px;height:100px">Press</button>
<a id=l class=abs href="#x" style="left:300px;top:0;display:block;width:200px;height:50px">link</a>
<input id=i class=abs style="left:0;top:200px;width:300px;height:30px">
<div class=abs style="left:0;top:300px;width:200px;height:60px;cursor:grab"></div>
<div id=host class=abs style="left:300px;top:300px;width:200px;height:60px"></div>
<p class=abs style="left:600px;top:0;width:400px;margin:0">Plain text paragraph here</p>
<div class=abs style="left:600px;top:400px;width:300px;height:100px"></div>
<a class=abs href="#under" style="left:1000px;top:0;display:block;width:200px;height:50px">under</a>
<div class=abs style="left:1000px;top:0;width:200px;height:50px;pointer-events:none;cursor:wait"></div>
<iframe class=abs src="${crossOrigin}/inner" style="left:0;top:500px;width:400px;height:200px;border:0"></iframe>
<script>
let moves = 0, clicks = 0;
addEventListener("mousemove", () => moves++);
const report = (s) => history.replaceState(null, "", "#" + encodeURIComponent(s));
b.addEventListener("click", (e) => {
  clicks++;
  report("c" + clicks + " m" + moves + " s" + (e.shiftKey ? 1 : 0));
});
i.addEventListener("input", () => report("v:" + i.value));
host.attachShadow({ mode: "open" }).innerHTML =
  '<a href="#s" style="display:block;height:60px">shadow</a>';
</script>`;

let inner: Awaited<ReturnType<typeof startFixtureServer>>;
let fx: Awaited<ReturnType<typeof startFixtureServer>>;
let d: TestDaemon;
let holdNext: ((res: ServerResponse) => void) | undefined;
/** Resolves with the next /held response once its request arrived. */
const held = () =>
  new Promise<ServerResponse>((r) => {
    holdNext = r;
  });

beforeAll(async () => {
  // another port is another origin: the frame is cross-origin to the page
  inner = await startFixtureServer({ "/inner": INNER });
  fx = await startFixtureServer({
    "/input": page(inner.url),
    "/other": "<title>other</title>",
    // answered when the test releases it: a navigation provably in flight
    "/held": (_req, res) => {
      const h = holdNext;
      holdNext = undefined;
      h?.(res);
    },
    // a page that breaks every builtin the main world offers a probe
    "/hostile": `<!doctype html><a href="#h" style="display:block;width:300px;height:80px">link</a>
<script>
Object.defineProperty(Object.prototype, "then", { value() {}, configurable: true });
window.getComputedStyle = () => ({ cursor: "wait" });
document.elementFromPoint = () => null;
Array.from = () => [];
</script>`,
  });
  d = await startTestDaemon();
});

afterAll(async () => {
  await d?.stop();
  await fx?.close();
  await inner?.close();
  if (d) removeDir(d.stateDir);
});

async function viewerOn(path: string) {
  await request(d.socketPath, { op: "navigate", url: `${fx.url}${path}` });
  const v = await openViewer(d.socketPath, { maxWidth: 640, maxHeight: 400 });
  await v.next(isState);
  return v;
}

async function takeOver(v: Awaited<ReturnType<typeof viewerOn>>) {
  const taken = v.after((m) => isState(m) && m.control === "user");
  v.send({ t: "takeover" });
  await taken;
}

const click = (v: Awaited<ReturnType<typeof viewerOn>>, x: number, y: number) => {
  v.send({ t: "mouse", kind: "down", x, y, button: "left" });
  v.send({ t: "mouse", kind: "up", x, y, button: "left" });
};

describe("browser daemon viewer input", () => {
  it("drops every input of a viewer in the watch state", async () => {
    const v = await viewerOn("/input");
    // the agent holds control: none of this may reach the page
    click(v, 100, 50);
    v.send({ t: "mouse", kind: "wheel", x: 100, y: 50, dx: 0, dy: 300 });
    click(v, 150, 215);
    v.send({ t: "key", kind: "char", key: "x", text: "x" });
    v.send({ t: "key", kind: "down", key: "z" });
    v.send({ t: "nav", url: `${fx.url}/other` });
    v.send({ t: "tab", action: "open" });
    // in order on one stream: after the takeover the same inputs act once
    await takeOver(v);
    click(v, 100, 50);
    const clicked = (await v.after(reported("c"))) as State;
    expect(fragment(clicked)).toMatch(/^c1 /);
    click(v, 150, 215);
    v.send({ t: "key", kind: "char", key: "y", text: "y" });
    const typed = (await v.after(reported("v:"))) as State;
    expect(fragment(typed)).toBe("v:y");
    expect(typed.tabs).toHaveLength(1);
    expect(activeUrl(typed).startsWith(`${fx.url}/input`)).toBe(true);
    v.send({ t: "handback" });
    await v.close();
  });

  it("drops input still queued when control returns to the agent", async () => {
    const v = await viewerOn("/input");
    await takeOver(v);
    // the person's navigation is in flight (its answer held), the click queued behind it
    const arrived = held();
    v.send({ t: "nav", url: `${fx.url}/held` });
    const res = await arrived;
    click(v, 100, 50);
    const back = v.after((m) => isState(m) && m.control === "agent");
    v.send({ t: "handback" });
    await back;
    // the navigation finishes (input already running goes on); the click's turn comes after it
    res.writeHead(200, { "content-type": "text/html" }).end(page(inner.url));
    const loaded = await request(d.socketPath, { op: "wait", text: "Press", timeoutMs: 5000 });
    expect(loaded.ok).toBe(true);
    const snap = await request(d.socketPath, { op: "snapshot" });
    if (!snap.ok) throw new Error(snap.message);
    expect(snap.page.url).toBe(`${fx.url}/held`);
    await v.close();
  });

  it("drops another viewer's queued input when one hands back, and after handoff_clear", async () => {
    for (const how of ["viewer", "handoff"] as const) {
      const v1 = await viewerOn("/input");
      const v2 = await openViewer(d.socketPath, { maxWidth: 640, maxHeight: 400 });
      await v2.next(isState);
      await takeOver(v1);
      await v2.next((m) => isState(m) && m.control === "user");
      // the second panel's navigation is in flight, its click queued behind it
      const arrived = held();
      v2.send({ t: "nav", url: `${fx.url}/held` });
      const res = await arrived;
      click(v2, 100, 50);
      const back = v2.after((m) => isState(m) && m.control === "agent");
      if (how === "viewer") v1.send({ t: "handback" });
      else {
        await request(d.socketPath, { op: "handoff_notice", callId: "h1", message: "sign in" });
        await request(d.socketPath, { op: "handoff_clear", callId: "h1", handback: true });
      }
      await back;
      res.writeHead(200, { "content-type": "text/html" }).end(page(inner.url));
      expect((await request(d.socketPath, { op: "wait", text: "Press", timeoutMs: 5000 })).ok).toBe(
        true,
      );
      const snap = await request(d.socketPath, { op: "snapshot" });
      if (!snap.ok) throw new Error(snap.message);
      expect(snap.page.url, how).toBe(`${fx.url}/held`);
      await v1.close();
      await v2.close();
    }
  });

  it("releases keys the person still holds when control returns to the agent or the viewer ends", async () => {
    for (const end of ["handback", "close"] as const) {
      const v = await viewerOn("/input");
      await takeOver(v);
      // Shift down, never up: the hand back (or closing the panel) must let go of it
      v.send({ t: "key", kind: "down", key: "Shift" });
      v.send({ t: "mouse", kind: "move", x: 5, y: 5 });
      await v.after((m) => m.t === "cursor");
      if (end === "handback") {
        const back = v.after((m) => isState(m) && m.control === "agent");
        v.send({ t: "handback" });
        await back;
      } else {
        await v.close();
        // the grace period would hand back after a minute; the agent's tools need it now
        const w = await openViewer(d.socketPath, { maxWidth: 640, maxHeight: 400 });
        await w.next(isState);
        const back = w.after((m) => isState(m) && m.control === "agent");
        w.send({ t: "handback" });
        await back;
        await w.close();
      }
      // the agent's click is a plain click, not a Shift-click (a new window)
      const r = await request(d.socketPath, { op: "click_at", x: 100, y: 50 });
      expect(r.ok).toBe(true);
      expect(r.ok && decodeURIComponent(new URL(r.page.url).hash)).toMatch(/ s0$/);
      if (end === "handback") await v.close();
    }
  });

  it("resolves the cursor without the page's code: a page breaking its builtins changes nothing", async () => {
    const v = await viewerOn("/hostile");
    await takeOver(v);
    const got = v.after((m) => m.t === "cursor");
    v.send({ t: "mouse", kind: "move", x: 100, y: 40 });
    expect(await got).toEqual({ t: "cursor", cursor: "pointer" });
    v.send({ t: "handback" });
    await v.close();
  });

  it("coalesces mouse moves: a burst of moves does not hold back the click after it", async () => {
    const v = await viewerOn("/input");
    await takeOver(v);
    for (let i = 0; i < 100; i++)
      v.send({ t: "mouse", kind: "move", x: 10 + (i % 150), y: 20 + (i % 50) });
    click(v, 100, 50);
    const st = (await v.after(reported("c"))) as State;
    const moves = Number(/m(\d+)/.exec(fragment(st))?.[1]);
    // the page saw a handful of moves, not 100 (each costs Chromium a frame, about 16 ms)
    expect(moves).toBeLessThan(10);
    v.send({ t: "handback" });
    await v.close();
  });

  it("answers the page's cursor under the pointer after a move, only when it changed", async () => {
    const v = await viewerOn("/input");
    await takeOver(v);
    const expectCursor = async (x: number, y: number, cursor: string) => {
      const got = v.after((m) => m.t === "cursor");
      v.send({ t: "mouse", kind: "move", x, y });
      expect(await got).toEqual({ t: "cursor", cursor });
    };
    await expectCursor(400, 25, "pointer"); // a link
    await expectCursor(150, 215, "text"); // a text field
    await expectCursor(100, 330, "grab"); // cursor: grab
    await expectCursor(400, 330, "pointer"); // a link in an open shadow root
    await expectCursor(620, 10, "text"); // text
    // a pointer-events: none overlay over a link: Chromium shows the link's cursor
    await expectCursor(1050, 25, "pointer");
    await expectCursor(700, 450, "default"); // nothing
    await expectCursor(100, 600, "pointer"); // a link in a cross-origin frame
    v.send({ t: "handback" });
    await v.close();
  });

  it("pings a new viewer at once (the pacing's path round trip)", async () => {
    const v = await viewerOn("/input");
    expect(await v.next((m) => m.t === "ping")).toMatchObject({ t: "ping", id: 1 });
    await v.close();
  });
});
