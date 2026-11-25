// Tab favicons for the panel's tab strip. The icon is fetched by the browser itself
// (CDP `Network.loadNetworkResource` in the tab's frame), so it goes through the device's network
// rules like any page request (the proxy, the allowlist); a refused or failing fetch leaves the
// panel's globe glyph. The bytes are bounded and sent as a `data:image/...` URL in the viewer
// state, which the panel draws in an <img> (the embed CSP allows `img-src data:`).
import type { CDPSession, Page } from "playwright-core";
import { FAVICON_MAX_BYTES } from "./protocol.js";

/** The most bytes read from the icon response before giving up. */
const READ_MAX_BYTES = 64 * 1024;
/** The edge of the PNG a large icon is drawn into (the strip shows 14 CSS px; 2x and a margin). */
export const RASTER_EDGE = 32;

/** The image types the panel may show, by their leading bytes (SVG by its text). */
export function sniffIcon(b: Uint8Array): string | null {
  const at = (i: number, ...xs: number[]) => xs.every((x, j) => b[i + j] === x);
  if (at(0, 0x89, 0x50, 0x4e, 0x47)) return "image/png";
  if (at(0, 0x00, 0x00, 0x01, 0x00)) return "image/x-icon";
  if (at(0, 0x47, 0x49, 0x46, 0x38)) return "image/gif";
  if (at(0, 0xff, 0xd8, 0xff)) return "image/jpeg";
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return "image/webp";
  const head = new TextDecoder().decode(b.subarray(0, 512)).trimStart().toLowerCase();
  if (head.startsWith("<svg") || (head.startsWith("<?xml") && head.includes("<svg")))
    return "image/svg+xml";
  return null;
}

/** A `data:` URL for icon bytes, or null when they are not a known image or too large. */
export function iconDataUrl(b: Uint8Array): string | null {
  if (b.byteLength === 0 || b.byteLength > FAVICON_MAX_BYTES) return null;
  const mime = sniffIcon(b);
  if (mime === null) return null;
  return `data:${mime};base64,${Buffer.from(b).toString("base64")}`;
}

/**
 * The page's icon address: the first `<link rel~=icon>` with an http(s) address, else
 * `/favicon.ico` of the page's origin; null for pages that are not http(s).
 */
export async function iconUrlOf(page: Page): Promise<string | null> {
  let base: URL;
  try {
    base = new URL(page.url());
  } catch {
    return null;
  }
  if (base.protocol !== "http:" && base.protocol !== "https:") return null;
  // a string expression: the daemon is compiled without the DOM library
  const declared = await page
    .evaluate(
      `(() => { const l = Array.from(document.querySelectorAll("link[rel][href]")).find((x) => /(^|\\s)icon(\\s|$)/i.test(x.rel)); return l ? l.href : null; })()`,
    )
    .catch(() => null);
  if (typeof declared === "string") {
    try {
      const u = new URL(declared, base);
      if (u.protocol === "http:" || u.protocol === "https:") return u.href;
    } catch {
      // a malformed address falls back to /favicon.ico
    }
  }
  return new URL("/favicon.ico", base).href;
}

/**
 * The icon as a `data:` URL for the panel: small known images as they are; a larger raster icon
 * (a 64 px 32-bit ICO is about 17 KiB, e.g. www.baidu.com's) is drawn into a RASTER_EDGE PNG by
 * the browser, in an isolated world of the tab's frame, so the page cannot touch it. The result is
 * checked like any icon: a PNG within FAVICON_MAX_BYTES, else null. An oversized SVG stays null.
 */
export async function iconForPanel(cdp: CDPSession, bytes: Uint8Array): Promise<string | null> {
  const direct = iconDataUrl(bytes);
  if (direct !== null) return direct;
  const mime = sniffIcon(bytes);
  if (mime === null || mime === "image/svg+xml") return null;
  const png = await rasterize(cdp, bytes, mime).catch(() => null);
  return png === null || sniffIcon(png) !== "image/png" ? null : iconDataUrl(png);
}

async function rasterize(
  cdp: CDPSession,
  bytes: Uint8Array,
  mime: string,
): Promise<Uint8Array | null> {
  const tree = (await cdp.send("Page.getFrameTree")) as { frameTree: { frame: { id: string } } };
  const world = (await cdp.send("Page.createIsolatedWorld", {
    frameId: tree.frameTree.frame.id,
    worldName: "capybara-favicon",
  })) as { executionContextId: number };
  const b64 = Buffer.from(bytes).toString("base64");
  const n = RASTER_EDGE;
  const expression = `(async () => {
    const raw = atob(${JSON.stringify(b64)});
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
    const bmp = await createImageBitmap(new Blob([bytes], { type: ${JSON.stringify(mime)} }));
    const c = new OffscreenCanvas(${n}, ${n});
    const g = c.getContext("2d");
    const k = Math.min(${n} / bmp.width, ${n} / bmp.height);
    const w = bmp.width * k, h = bmp.height * k;
    g.imageSmoothingQuality = "high";
    g.drawImage(bmp, (${n} - w) / 2, (${n} - h) / 2, w, h);
    const out = new Uint8Array(await (await c.convertToBlob({ type: "image/png" })).arrayBuffer());
    let s = "";
    for (let i = 0; i < out.length; i++) s += String.fromCharCode(out[i]);
    return btoa(s);
  })()`;
  const res = (await cdp.send("Runtime.evaluate", {
    expression,
    contextId: world.executionContextId,
    awaitPromise: true,
    returnByValue: true,
  })) as { result?: { value?: unknown }; exceptionDetails?: unknown };
  const v = res.result?.value;
  if (res.exceptionDetails !== undefined || typeof v !== "string") return null;
  return new Uint8Array(Buffer.from(v, "base64"));
}

/** Fetches the icon through the tab's frame (the browser's network); null on any failure. */
export async function fetchIcon(cdp: CDPSession, url: string): Promise<Uint8Array | null> {
  const tree = (await cdp.send("Page.getFrameTree")) as { frameTree: { frame: { id: string } } };
  const res = (await cdp.send("Network.loadNetworkResource", {
    frameId: tree.frameTree.frame.id,
    url,
    options: { disableCache: false, includeCredentials: false },
  })) as {
    resource: { success: boolean; httpStatusCode?: number; stream?: string };
  };
  const r = res.resource;
  if (!r.success || r.httpStatusCode !== 200 || r.stream === undefined) return null;
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = (await cdp.send("IO.read", { handle: r.stream, size: 16 * 1024 })) as {
        data: string;
        base64Encoded?: boolean;
        eof: boolean;
      };
      const buf = Buffer.from(part.data, part.base64Encoded ? "base64" : "utf8");
      size += buf.byteLength;
      if (size > READ_MAX_BYTES) return null;
      chunks.push(buf);
      if (part.eof) break;
    }
  } finally {
    await cdp.send("IO.close", { handle: r.stream }).catch(() => undefined);
  }
  return new Uint8Array(Buffer.concat(chunks));
}
