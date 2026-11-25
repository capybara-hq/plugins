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
  it("the page's declared icon reaches the viewer state as a data URL", async () => {
    const viewer = await openViewer(d.socketPath, { maxWidth: 480, maxHeight: 300 });
    try {
      const nav = await request(d.socketPath, { op: "navigate", url: `${fx.url}/declared` });
      expect(nav.ok).toBe(true);
      const icon = iconOf(await viewer.next((m) => iconOf(m) !== undefined));
      expect(icon).toBe(`data:image/png;base64,${PNG.toString("base64")}`);
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
