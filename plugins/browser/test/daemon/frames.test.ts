import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  openViewer,
  removeDir,
  request,
  startFixtureServer,
  startTestDaemon,
  type TestDaemon,
  type TestFrame,
} from "./helpers.js";

// Fresh random pixels every 100 ms: every screencast frame is large and different.
const NOISE = `<!doctype html><title>Noise</title><style>body{margin:0}</style>
<canvas id=c width=1280 height=800></canvas><script>
const x = c.getContext("2d"); const d = x.createImageData(1280, 800);
function draw() {
  for (let i = 0; i < d.data.length; i++) d.data[i] = (i % 4 === 3) ? 255 : Math.random() * 255;
  x.putImageData(d, 0, 0);
}
draw(); setInterval(draw, 100);</script>`;

const CAP = 64 * 1024;
let fx: Awaited<ReturnType<typeof startFixtureServer>>;
let d: TestDaemon;

beforeAll(async () => {
  fx = await startFixtureServer({ "/noise": NOISE });
  d = await startTestDaemon({ env: { BROWSER_FRAME_MAX_BYTES: String(CAP) } });
});

afterAll(async () => {
  await d?.stop();
  await fx?.close();
  if (d) removeDir(d.stateDir);
});

describe("browser daemon frame cap", () => {
  it("every viewer frame message fits the configured cap", async () => {
    await request(d.socketPath, { op: "navigate", url: `${fx.url}/noise` });
    const v = await openViewer(d.socketPath, { maxWidth: 1280, maxHeight: 800 });
    await v.next((m) => m.t === "frame" && m.seq >= 4);
    const frames = v.messages.filter((m): m is TestFrame => m.t === "frame");
    for (const f of frames) expect(f.bytes).toBeLessThanOrEqual(CAP);
    await v.close();
  });

  it("frames wait for the viewer's acks", async () => {
    await request(d.socketPath, { op: "navigate", url: `${fx.url}/noise` });
    const v = await openViewer(d.socketPath, { maxWidth: 320, maxHeight: 200 });
    v.autoAck = false;
    await v.next((m) => m.t === "frame" && m.seq >= 2);
    // with two frames unacknowledged nothing more comes until an ack
    const more = v.after((m) => m.t === "frame");
    const count = () => v.messages.filter((m) => m.t === "frame").length;
    const before = count();
    v.send({ t: "frame-ack", seq: 2 });
    await more;
    expect(count()).toBeGreaterThan(before);
    expect(before).toBeLessThanOrEqual(2);
    await v.close();
  });
});
