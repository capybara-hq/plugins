import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { MAX_SCREENSHOT_BYTES, MAX_TITLE_CHARS } from "../../daemon/actions.js";
import type { ViewerOut } from "../../daemon/protocol.js";
import {
  openViewer,
  removeDir,
  request,
  startFixtureServer,
  startTestDaemon,
  type TestDaemon,
} from "./helpers.js";

const UPLOAD = `<!doctype html><title>Upload</title>
<input type=file aria-label="File" onchange="out.textContent = 'chosen ' + this.files[0].name">
<p id=out></p>`;
const DOWNLOAD = `<!doctype html><title>Download</title><a href="/file.txt" download="report.txt">Get</a>`;
const HUGE_TITLE = `<!doctype html><title>${"T".repeat(3_000_000)}</title><p>long title</p>`;
// Random pixels 1280x6000: a full-page JPEG far above the screenshot clamp at good quality.
const TALL_NOISE = `<!doctype html><title>Tall</title><style>body{margin:0}</style>
<canvas id=c width=1280 height=6000></canvas><script>
const x = c.getContext("2d"); const d = x.createImageData(1280, 6000);
for (let i = 0; i < d.data.length; i++) d.data[i] = (i % 4 === 3) ? 255 : Math.random() * 255;
x.putImageData(d, 0, 0);</script>`;

let fx: Awaited<ReturnType<typeof startFixtureServer>>;
let d: TestDaemon;
let workspace: string;
let outside: string;

beforeAll(async () => {
  workspace = mkdtempSync(join(tmpdir(), "cbd-ws-"));
  outside = mkdtempSync(join(tmpdir(), "cbd-out-"));
  fx = await startFixtureServer({
    "/upload": UPLOAD,
    "/download": DOWNLOAD,
    "/file.txt": (_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" }).end("hello download");
    },
    "/huge-title": HUGE_TITLE,
    "/tall": TALL_NOISE,
  });
  d = await startTestDaemon({ env: { CAPYBARA_SERVICE_WORKSPACE: workspace } });
});

afterAll(async () => {
  await d?.stop();
  await fx?.close();
  if (d) removeDir(d.stateDir);
  removeDir(workspace);
  removeDir(outside);
});

async function refOf(label: RegExp): Promise<string> {
  const snap = await request(d.socketPath, { op: "snapshot" });
  if (!snap.ok) throw new Error(snap.message);
  const ref = snap.text?.match(label)?.[1];
  if (ref === undefined) throw new Error(`no ref for ${label} in ${snap.text}`);
  return ref;
}

describe("browser daemon workspace and limits", () => {
  it("uploads a workspace file", async () => {
    writeFileSync(join(workspace, "in.txt"), "x");
    await request(d.socketPath, { op: "navigate", url: `${fx.url}/upload` });
    const ref = await refOf(/button "File" \[ref=((?:f\d+)?e\d+)\]/);
    const r = await request(d.socketPath, { op: "upload", ref, path: join(workspace, "in.txt") });
    expect(r.ok).toBe(true);
    const waited = await request(d.socketPath, {
      op: "wait",
      text: "chosen in.txt",
      timeoutMs: 4000,
    });
    expect(waited.ok).toBe(true);
  });

  it("refuses uploads outside the workspace, links included", async () => {
    writeFileSync(join(outside, "secret.txt"), "s");
    symlinkSync(join(outside, "secret.txt"), join(workspace, "link.txt"));
    await request(d.socketPath, { op: "navigate", url: `${fx.url}/upload` });
    const ref = await refOf(/button "File" \[ref=((?:f\d+)?e\d+)\]/);
    for (const path of [join(outside, "secret.txt"), join(workspace, "link.txt")]) {
      const r = await request(d.socketPath, { op: "upload", ref, path });
      expect(r).toMatchObject({ ok: false, error: "failed" });
      if (!r.ok) {
        expect(r.message).toBe(
          `Upload paths must be inside the workspace (${realpathSync(workspace)}); copy the file there first.`,
        );
      }
    }
  });

  it("saves downloads into the workspace downloads directory", async () => {
    const dir = join(workspace, "downloads");
    const notes: string[] = [];
    for (const name of ["report.txt", "report (1).txt"]) {
      await request(d.socketPath, { op: "navigate", url: `${fx.url}/download` });
      const ref = await refOf(/link "Get" \[ref=((?:f\d+)?e\d+)\]/);
      const click = await request(d.socketPath, { op: "click", ref });
      if (!click.ok) throw new Error(click.message);
      notes.push(click.text ?? "");
      // the download may finish after the click's reply: then the next reply names it
      await vi.waitFor(() => expect(existsSync(join(dir, name))).toBe(true));
      const next = await request(d.socketPath, { op: "tabs", action: "list" });
      notes.push(next.ok ? (next.text ?? "") : "");
    }
    const all = notes.join("\n");
    expect(all).toContain(`to ${join(dir, "report.txt")}.`);
    expect(all).toContain(`to ${join(dir, "report (1).txt")}.`);
    expect(readFileSync(join(dir, "report.txt"), "utf8")).toBe("hello download");
  });

  it("a huge title is cut in replies, tab lists and viewer state", async () => {
    const v = await openViewer(d.socketPath, { maxWidth: 320, maxHeight: 200 });
    const nav = await request(d.socketPath, { op: "navigate", url: `${fx.url}/huge-title` });
    if (!nav.ok) throw new Error(nav.message);
    expect(nav.page.title.length).toBeLessThanOrEqual(MAX_TITLE_CHARS);
    const list = await request(d.socketPath, { op: "tabs", action: "list" });
    if (!list.ok) throw new Error(list.message);
    expect(list.text?.length ?? 0).toBeLessThan(20_000);
    const state = (await v.next(
      (m) => m.t === "state" && m.tabs.some((t) => t.title.startsWith("TTT")),
    )) as Extract<ViewerOut, { t: "state" }>;
    for (const t of state.tabs) expect(t.title.length).toBeLessThanOrEqual(MAX_TITLE_CHARS);
    await v.close();
  });

  it("a full-page screenshot is clamped below the message limit", async () => {
    await request(d.socketPath, { op: "navigate", url: `${fx.url}/tall` });
    const shot = await request(d.socketPath, {
      op: "screenshot",
      fullPage: true,
      maxBytes: 100_000_000,
    });
    if (!shot.ok) throw new Error(shot.message);
    const bytes = Buffer.from(shot.image ?? "", "base64").length;
    expect(bytes).toBeGreaterThan(0);
    expect(bytes).toBeLessThanOrEqual(MAX_SCREENSHOT_BYTES);
  });
});
