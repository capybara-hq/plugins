import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { iconDataUrl, sniffIcon } from "../../daemon/favicon.js";
import { FAVICON_MAX_BYTES, isIconDataUrl } from "../../daemon/protocol.js";
import {
  openViewer,
  removeDir,
  request,
  startFixtureServer,
  startTestDaemon,
  type TestDaemon,
  type ViewerMsg,
} from "./helpers.js";

// a 1x1 transparent PNG
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64",
);
const ICO = Buffer.concat([Buffer.from([0, 0, 1, 0, 1, 0]), Buffer.alloc(32)]);

/**
 * www.baidu.com's favicon shape: one 64x64 32-bit BMP entry, 16958 bytes, over the 8 KiB cap
 * (the page declares it as `<link rel="shortcut icon" href="https://www.baidu.com/favicon.ico">`).
 */
function bigIco(): Buffer {
  const n = 64;
  const bmp = Buffer.alloc(40 + n * n * 4 + n * (n / 8));
  bmp.writeUInt32LE(40, 0);
  bmp.writeInt32LE(n, 4);
  bmp.writeInt32LE(n * 2, 8);
  bmp.writeUInt16LE(1, 12);
  bmp.writeUInt16LE(32, 14);
  for (let i = 0; i < n * n; i++) bmp.writeUInt32LE(0xff2932e1, 40 + i * 4); // opaque blue-ish
  const head = Buffer.alloc(22);
  head.writeUInt16LE(0, 0);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(1, 4);
  head.writeUInt8(n, 6);
  head.writeUInt8(n, 7);
  head.writeUInt16LE(1, 10);
  head.writeUInt16LE(32, 12);
  head.writeUInt32LE(bmp.length, 14);
  head.writeUInt32LE(22, 18);
  return Buffer.concat([head, bmp]);
}
const BIG_ICO = bigIco();

describe("icon bytes", () => {
  it("are sniffed by their leading bytes, never by the server's type", () => {
    expect(sniffIcon(PNG)).toBe("image/png");
    expect(sniffIcon(ICO)).toBe("image/x-icon");
    expect(sniffIcon(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBe(
      "image/svg+xml",
    );
    expect(sniffIcon(new TextEncoder().encode("<!doctype html><title>404</title>"))).toBeNull();
  });

  it("become a bounded data URL the panel accepts; too large or unknown ones do not", () => {
    const url = iconDataUrl(PNG);
    expect(url?.startsWith("data:image/png;base64,")).toBe(true);
    expect(isIconDataUrl(url)).toBe(true);
    expect(iconDataUrl(new Uint8Array(FAVICON_MAX_BYTES + 1).fill(0x89))).toBeNull();
    expect(iconDataUrl(new TextEncoder().encode("not an image"))).toBeNull();
    expect(isIconDataUrl("data:text/html;base64,PGgxPg==")).toBe(false);
    expect(isIconDataUrl("https://example.com/favicon.ico")).toBe(false);
  });
});

let fx: Awaited<ReturnType<typeof startFixtureServer>>;
let d: TestDaemon;

beforeAll(async () => {
  fx = await startFixtureServer({
    "/declared": '<!doctype html><title>Declared</title><link rel="icon" href="/icons/site.png">',
    "/icons/site.png": (_req, res) => {
      res.writeHead(200, { "content-type": "image/png" }).end(PNG);
    },
    "/fallback": "<!doctype html><title>Fallback</title><p>no link</p>",
    "/baidu": (req, res) => {
      // the page declares its icon by an absolute address, as www.baidu.com does
      const origin = `http://${req.headers.host}`;
      res
        .writeHead(200, { "content-type": "text/html" })
        .end(
          `<!doctype html><title>百度一下，你就知道</title><link rel="shortcut icon" href="${origin}/big.ico" type="image/x-icon" /><link rel="icon" sizes="any" mask href="${origin}/big.ico">`,
        );
    },
    "/big.ico": (_req, res) => {
      res.writeHead(200, { "content-type": "image/x-icon" }).end(BIG_ICO);
    },
    "/favicon.ico": (_req, res) => {
      res.writeHead(200, { "content-type": "image/x-icon" }).end(ICO);
    },
  });
  d = await startTestDaemon();
});

afterAll(async () => {
  await d?.stop();
  await fx?.close();
  if (d) removeDir(d.stateDir);
});

const iconOf = (m: ViewerMsg) =>
  m.t === "state" ? m.tabs.find((t) => t.active)?.favicon : undefined;

describe("tab favicons", () => {
  it("an icon over the cap (a 64 px 32-bit ICO, as www.baidu.com's) is drawn into a small PNG", async () => {
    expect(BIG_ICO.length).toBe(16958);
    expect(BIG_ICO.length).toBeGreaterThan(FAVICON_MAX_BYTES);
    const viewer = await openViewer(d.socketPath, { maxWidth: 480, maxHeight: 300 });
    try {
      const nav = await request(d.socketPath, { op: "navigate", url: `${fx.url}/baidu` });
      expect(nav.ok).toBe(true);
      const icon = iconOf(await viewer.next((m) => iconOf(m) !== undefined));
      expect(icon?.startsWith("data:image/png;base64,")).toBe(true);
      expect(isIconDataUrl(icon)).toBe(true);
      const png = Buffer.from((icon ?? "").split(",")[1] ?? "", "base64");
      // a 32x32 PNG (IHDR width and height)
      expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([32, 32]);
    } finally {
      await viewer.close();
    }
  });

  it("the page's declared icon reaches the viewer state as a data URL", async () => {
    const viewer = await openViewer(d.socketPath, { maxWidth: 480, maxHeight: 300 });
    try {
      const nav = await request(d.socketPath, { op: "navigate", url: `${fx.url}/declared` });
      expect(nav.ok).toBe(true);
      const want = `data:image/png;base64,${PNG.toString("base64")}`;
      const icon = iconOf(await viewer.next((m) => iconOf(m) === want));
      expect(icon).toBe(want);
    } finally {
      await viewer.close();
    }
  });

  it("a page without a declared icon falls back to /favicon.ico", async () => {
    const viewer = await openViewer(d.socketPath, { maxWidth: 480, maxHeight: 300 });
    try {
      const nav = await request(d.socketPath, { op: "navigate", url: `${fx.url}/fallback` });
      expect(nav.ok).toBe(true);
      const icon = iconOf(
        await viewer.next((m) => iconOf(m)?.startsWith("data:image/x-icon") === true),
      );
      expect(icon).toBe(`data:image/x-icon;base64,${ICO.toString("base64")}`);
    } finally {
      await viewer.close();
    }
  });
});
