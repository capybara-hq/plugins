import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SNAPSHOT_MAX_CHARS } from "../../daemon/protocol.js";
import {
  removeDir,
  request,
  startFixtureServer,
  startTestDaemon,
  type TestDaemon,
} from "./helpers.js";

const FORM = `<!doctype html><title>Form</title>
<form action="/done" method="get"><input name="q" aria-label="Query" value="x">
<button type="submit">Send</button></form>`;

const HUGE = `<!doctype html><title>Huge</title><ul>${Array.from(
  { length: 50_000 },
  (_, i) => `<li><a href="#${i}">item ${i}</a></li>`,
).join("")}</ul>`;

// Random pixels: a JPEG of this is far above 200 KB at full size and good quality.
const NOISE = `<!doctype html><title>Noise</title><style>body{margin:0}</style>
<canvas id=c width=1280 height=800></canvas><script>
const x = c.getContext("2d"); const d = x.createImageData(1280, 800);
for (let i = 0; i < d.data.length; i++) d.data[i] = (i % 4 === 3) ? 255 : Math.random() * 255;
x.putImageData(d, 0, 0);</script>`;

let fx: Awaited<ReturnType<typeof startFixtureServer>>;
let d: TestDaemon;

beforeAll(async () => {
  fx = await startFixtureServer({
    "/form": FORM,
    "/done": "<!doctype html><title>Done</title><h1>Submitted</h1>",
    "/huge": HUGE,
    "/noise": NOISE,
  });
  d = await startTestDaemon();
});

afterAll(async () => {
  await d?.stop();
  await fx?.close();
  if (d) removeDir(d.stateDir);
});

const refOf = (text: string, re: RegExp): string => {
  const m = text.match(re);
  if (!m?.[1]) throw new Error(`no ref for ${re} in:\n${text.slice(0, 2000)}`);
  return m[1];
};

describe("browser daemon tools", () => {
  it("navigate then snapshot lists the fixture's button as a ref", async () => {
    const nav = await request(d.socketPath, { op: "navigate", url: `${fx.url}/form` });
    expect(nav).toMatchObject({ ok: true, page: { url: `${fx.url}/form`, title: "Form" } });
    const snap = await request(d.socketPath, { op: "snapshot" });
    expect(snap.ok).toBe(true);
    if (!snap.ok) return;
    expect(snap.text).toMatch(/button "Send" \[ref=(?:f\d+)?e\d+\]/);
    expect(snap.blockedHosts).toEqual([]);
  });

  it("click by ref submits the fixture form", async () => {
    await request(d.socketPath, { op: "navigate", url: `${fx.url}/form` });
    const snap = await request(d.socketPath, { op: "snapshot" });
    if (!snap.ok) throw new Error(snap.message);
    const ref = refOf(snap.text ?? "", /button "Send" \[ref=((?:f\d+)?e\d+)\]/);
    const click = await request(d.socketPath, { op: "click", ref });
    expect(click.ok).toBe(true);
    const waited = await request(d.socketPath, { op: "wait", text: "Submitted", timeoutMs: 4000 });
    expect(waited).toMatchObject({ ok: true, page: { title: "Done" } });
    if (waited.ok) expect(waited.page.url).toBe(`${fx.url}/done?q=x`);
  });

  it("an unknown ref is refused at once", async () => {
    await request(d.socketPath, { op: "navigate", url: `${fx.url}/form` });
    await request(d.socketPath, { op: "snapshot" });
    const r = await request(d.socketPath, { op: "click", ref: "e9999" });
    expect(r).toMatchObject({ ok: false, error: "no_such_ref" });
  });

  it("snapshot caps at 40000 chars with a marker", async () => {
    await request(d.socketPath, { op: "navigate", url: `${fx.url}/huge` });
    const snap = await request(d.socketPath, { op: "snapshot" });
    if (!snap.ok) throw new Error(snap.message);
    const text = snap.text ?? "";
    expect(text.length).toBeLessThanOrEqual(SNAPSHOT_MAX_CHARS);
    expect(text).toMatch(/\[truncated: \d+ more nodes\]$/);
  });

  it("screenshot fits the frame capacity", async () => {
    await request(d.socketPath, { op: "navigate", url: `${fx.url}/noise` });
    const shot = await request(d.socketPath, { op: "screenshot", maxBytes: 200_000 });
    if (!shot.ok) throw new Error(shot.message);
    const bytes = Buffer.from(shot.image ?? "", "base64");
    expect(bytes.length).toBeGreaterThan(1000);
    expect(bytes.length).toBeLessThanOrEqual(200_000);
    expect(bytes[0]).toBe(0xff);
    expect(bytes[1]).toBe(0xd8);
  });

  it("tabs open, list, switch and close", async () => {
    const opened = await request(d.socketPath, {
      op: "tabs",
      action: "open",
      url: `${fx.url}/done`,
    });
    if (!opened.ok) throw new Error(opened.message);
    const second = opened.page.tabId;
    const list = await request(d.socketPath, { op: "tabs", action: "list" });
    if (!list.ok) throw new Error(list.message);
    expect(list.text).toContain(second);
    const closed = await request(d.socketPath, { op: "tabs", action: "close", tabId: second });
    expect(closed.ok).toBe(true);
    if (closed.ok) expect(closed.page.tabId).not.toBe(second);
  });
});
