import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { MAX_SCREENSHOT_BYTES, MAX_TITLE_CHARS, safeFileName } from "../../daemon/actions.js";
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

// A wait on a condition (a download finishing, a note arriving) is bounded only far above any
// loaded machine: vi.waitFor gives up after 1 s by default, which a 2-CPU runner can exceed.
const WAIT = { timeout: 20_000 };

let fx: Awaited<ReturnType<typeof startFixtureServer>>;
let d: TestDaemon;
let workspace: string;
let outside: string;
let releaseSlow: () => void = () => undefined;
const link = (href: string, name: string) =>
  `<!doctype html><title>Download</title><a href="${href}" download="${name}">Get</a>`;

beforeAll(async () => {
  workspace = mkdtempSync(join(tmpdir(), "cbd-ws-"));
  outside = mkdtempSync(join(tmpdir(), "cbd-out-"));
  fx = await startFixtureServer({
    "/upload": UPLOAD,
    "/download": DOWNLOAD,
    "/download-planted": link("/file.txt", "planted.txt"),
    "/file.txt": (_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" }).end("hello download");
    },
    "/huge-title": HUGE_TITLE,
    "/dl-endless": link("/endless", "big.bin"),
    "/endless": (_req, res) => {
      res.writeHead(200, {
        "content-type": "application/octet-stream",
        "content-disposition": 'attachment; filename="big.bin"',
      });
      const chunk = Buffer.alloc(64 * 1024);
      const pump = () => {
        while (!res.destroyed && res.write(chunk)) {}
        if (!res.destroyed) res.once("drain", pump);
      };
      pump();
    },
    "/dl-slow": link("/slow", "slow.bin"),
    "/slow": (_req, res) => {
      res.writeHead(200, {
        "content-type": "application/octet-stream",
        "content-disposition": 'attachment; filename="slow.bin"',
      });
      // Chromium decides on a download after its first few KB
      res.write(Buffer.alloc(4096, 97));
      releaseSlow = () => res.end("b");
    },
    "/dl-dangle": link("/file.txt", "dangle.txt"),
    "/dl-big": link("/big", "big2.bin"),
    "/big": (_req, res) => {
      res.writeHead(200, { "content-type": "application/octet-stream" });
      res.end(Buffer.alloc(2 * 1024 * 1024));
    },
    "/tall": TALL_NOISE,
  });
  d = await startTestDaemon({
    env: { CAPYBARA_SERVICE_WORKSPACE: workspace, BROWSER_DOWNLOAD_MAX_BYTES: String(1024 * 1024) },
    downloadWaitMs: 300,
  });
});

afterAll(async () => {
  await d?.stop();
  await fx?.close();
  if (d) removeDir(d.stateDir);
  removeDir(workspace);
  removeDir(outside);
});

/** Collects reply texts until one contains `needle` (late notes ride later replies). */
async function noteContaining(needle: string): Promise<string> {
  let all = "";
  await vi.waitFor(async () => {
    const r = await request(d.socketPath, { op: "tabs", action: "list" });
    all += r.ok ? (r.text ?? "") : "";
    expect(all).toContain(needle);
  }, WAIT);
  return all;
}

async function clickDownload(page: string): Promise<string> {
  await request(d.socketPath, { op: "navigate", url: `${fx.url}${page}` });
  const ref = await refOf(/link "Get" \[ref=((?:f\d+)?e\d+)\]/);
  const click = await request(d.socketPath, { op: "click", ref });
  if (!click.ok) throw new Error(click.message);
  return click.text ?? "";
}

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
    // a directory link inside the workspace leading out of it
    symlinkSync(outside, join(workspace, "dirlink"));
    for (const path of [join(outside, "secret.txt"), join(workspace, "dirlink", "secret.txt")]) {
      const r = await request(d.socketPath, { op: "upload", ref, path });
      expect(r).toMatchObject({ ok: false, error: "failed" });
      if (!r.ok) {
        expect(r.message).toBe(
          `Upload paths must be inside the workspace (${realpathSync(workspace)}); copy the file there first.`,
        );
      }
    }
    // a link is never followed: the bytes are read here, never a path Chromium opens later
    const link = await request(d.socketPath, {
      op: "upload",
      ref,
      path: join(workspace, "link.txt"),
    });
    expect(link).toMatchObject({ ok: false, error: "failed" });
    if (!link.ok) expect(link.message).toMatch(/is a symbolic link/);
  });

  it("never saves a download through a link planted in the downloads directory", async () => {
    const dir = join(realpathSync(workspace), "downloads");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(outside, "profile-state"), "private");
    symlinkSync(join(outside, "profile-state"), join(dir, "planted.txt"));
    await request(d.socketPath, { op: "navigate", url: `${fx.url}/download-planted` });
    const ref = await refOf(/link "Get" \[ref=((?:f\d+)?e\d+)\]/);
    const click = await request(d.socketPath, { op: "click", ref });
    if (!click.ok) throw new Error(click.message);
    await vi.waitFor(() => expect(existsSync(join(dir, "planted (1).txt"))).toBe(true), WAIT);
    expect(readFileSync(join(outside, "profile-state"), "utf8")).toBe("private");
  });

  it("saves downloads into the workspace downloads directory", async () => {
    const dir = join(realpathSync(workspace), "downloads");
    const notes: string[] = [];
    for (const name of ["report.txt", "report (1).txt"]) {
      await request(d.socketPath, { op: "navigate", url: `${fx.url}/download` });
      const ref = await refOf(/link "Get" \[ref=((?:f\d+)?e\d+)\]/);
      const click = await request(d.socketPath, { op: "click", ref });
      if (!click.ok) throw new Error(click.message);
      notes.push(click.text ?? "");
      // the download may finish after the click's reply: then the next reply names it
      await vi.waitFor(() => expect(existsSync(join(dir, name))).toBe(true), WAIT);
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

  it("an endless download is reported in progress, then cancelled at the size cap", async () => {
    // the cancellation note rides the click's reply or a later one
    const cancelled =
      'The download of "big.bin" was cancelled: downloads in progress passed 1048576 bytes.';
    const text = await clickDownload("/dl-endless");
    if (!text.includes(cancelled)) await noteContaining(cancelled);
    expect(existsSync(join(workspace, "downloads", "big.bin"))).toBe(false);
  });

  it("a slow download replies in progress and is named by a later reply", async () => {
    // navigating to the file starts the download inside the request, so the reply waits for it
    const nav = await request(d.socketPath, { op: "navigate", url: `${fx.url}/slow` });
    if (!nav.ok) throw new Error(nav.message);
    expect(nav.text).toContain('Download still in progress: "slow.bin"');
    releaseSlow();
    await vi.waitFor(
      () => expect(existsSync(join(workspace, "downloads", "slow.bin"))).toBe(true),
      WAIT,
    );
    // a failing request does not swallow the late note
    const failed = await request(d.socketPath, { op: "click", ref: "e99999" });
    expect(failed.ok).toBe(false);
    await noteContaining(
      `Downloaded "slow.bin" to ${join(realpathSync(workspace), "downloads", "slow.bin")}.`,
    );
  });

  it("a dangling link at the target name is not overwritten", async () => {
    symlinkSync(join(outside, "missing"), join(workspace, "downloads", "dangle.txt"));
    const text = await clickDownload("/dl-dangle");
    const dir = join(realpathSync(workspace), "downloads");
    const all = text.includes("dangle (1).txt") ? text : await noteContaining("dangle (1).txt");
    expect(all).toContain(`to ${join(dir, "dangle (1).txt")}.`);
    expect(existsSync(join(outside, "missing"))).toBe(false);
  });

  it("refuses a downloads directory that is a link", async () => {
    renameSync(join(workspace, "downloads"), join(workspace, "downloads-old"));
    symlinkSync(outside, join(workspace, "downloads"));
    const text = await clickDownload("/download");
    const all = text.includes("not a plain directory")
      ? text
      : await noteContaining("not a plain directory");
    expect(all).toContain("is not a plain directory in the workspace");
    expect(readdirSync(outside)).not.toContain("report.txt");
  });
});

describe("download leftovers", () => {
  const tmpEmpty = () =>
    vi.waitFor(() => {
      let left: string[] = [];
      try {
        left = readdirSync(join(d.stateDir, "downloads-tmp"));
      } catch {
        left = [];
      }
      expect(left).toEqual([]);
    }, WAIT);

  it("leaves no artifact in downloads-tmp after a save", async () => {
    renameSync(join(workspace, "downloads"), join(workspace, "downloads-link"));
    const text = await clickDownload("/download");
    if (!text.includes("Downloaded")) await noteContaining("Downloaded");
    await tmpEmpty();
  });

  it("leaves no artifact in downloads-tmp after a download over the cap", async () => {
    const text = await clickDownload("/dl-big");
    if (!/big2\.bin.*(not saved|cancelled)/.test(text)) {
      let all = "";
      await vi.waitFor(async () => {
        const r = await request(d.socketPath, { op: "tabs", action: "list" });
        all += r.ok ? (r.text ?? "") : "";
        expect(all).toMatch(/big2\.bin.*(not saved|cancelled)/);
      }, WAIT);
    }
    expect(existsSync(join(workspace, "downloads", "big2.bin"))).toBe(false);
    await tmpEmpty();
  });
});

describe("download names", () => {
  it("caps names at 200 UTF-8 bytes, keeping the extension and whole characters", () => {
    const name = safeFileName(`${"文".repeat(150)}.pdf`);
    expect(Buffer.byteLength(name)).toBeLessThanOrEqual(200);
    expect(name.endsWith(".pdf")).toBe(true);
    const emoji = safeFileName(`${"😀".repeat(80)}.txt`);
    expect(Buffer.byteLength(emoji)).toBeLessThanOrEqual(200);
    expect(emoji.endsWith(".txt")).toBe(true);
    expect([...emoji.slice(0, -4)].every((c) => c === "😀")).toBe(true);
    expect(safeFileName("../../etc/passwd")).toBe("passwd");
    expect(safeFileName("...")).toBe("download");
  });
});
