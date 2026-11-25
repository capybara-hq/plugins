// The page's cursor at a viewport point (browser use spec §8, takeover): a headless browser draws
// no cursor, so the daemon resolves what Chromium would show and the panel sets it on the frame.
// The computed `cursor` of the element under the point, through open shadow roots and frames;
// `auto` follows the browser's rule (an I-beam over editable fields and text, else the arrow).

import type { Frame, Page } from "playwright-core";
import { toViewerCursor, type ViewerCursor } from "./protocol.js";

/** What the in-page probe finds: a cursor, or a frame it cannot enter (cross-origin). */
type Probe =
  | { cursor: string }
  | { frame: { left: number; top: number }; inner: { x: number; y: number } };

/**
 * The in-page probe, as source: evaluated as a string so no bundler helper (esbuild's `__name`)
 * can leak into the page. `(x, y) => Probe` for the document it runs in.
 */
export const CURSOR_PROBE = `(([x, y]) => {
  const keyword = (value) => {
    // "url(a.cur) 4 4, pointer": an image cursor's keyword fallback is the last item
    const parts = String(value).split(",").map((p) => p.trim());
    return parts[parts.length - 1] || "auto";
  };
  const textUnder = (doc, px, py) => {
    const range = doc.caretRangeFromPoint ? doc.caretRangeFromPoint(px, py) : null;
    const node = range ? range.startContainer : null;
    if (!node || node.nodeType !== 3) return false;
    const probe = doc.createRange();
    for (const [a, b] of [[range.startOffset, range.startOffset + 1], [range.startOffset - 1, range.startOffset]]) {
      if (a < 0 || b > node.length) continue;
      probe.setStart(node, a);
      probe.setEnd(node, b);
      for (const r of Array.from(probe.getClientRects()))
        if (px >= r.left && px <= r.right && py >= r.top && py <= r.bottom) return true;
    }
    return false;
  };
  const NOT_TEXT = ["button", "submit", "reset", "checkbox", "radio", "range", "color", "file", "image", "hidden"];
  let doc = document;
  let px = x;
  let py = y;
  for (let depth = 0; depth < 8; depth++) {
    let el = doc.elementFromPoint(px, py);
    while (el && el.shadowRoot) {
      const inner = el.shadowRoot.elementFromPoint(px, py);
      if (!inner || inner === el) break;
      el = inner;
    }
    if (!el) return { cursor: "default" };
    if (el.tagName === "IFRAME" || el.tagName === "FRAME") {
      const r = el.getBoundingClientRect();
      const ix = px - r.left - el.clientLeft;
      const iy = py - r.top - el.clientTop;
      let inner = null;
      try { inner = el.contentDocument; } catch { inner = null; }
      if (!inner) return { frame: { left: r.left, top: r.top }, inner: { x: ix, y: iy } };
      doc = inner;
      px = ix;
      py = iy;
      continue;
    }
    const style = (doc.defaultView || window).getComputedStyle(el);
    const cursor = keyword(style.cursor);
    if (cursor !== "auto") return { cursor };
    const tag = el.tagName;
    const editable = el.isContentEditable || tag === "TEXTAREA" ||
      (tag === "INPUT" && !NOT_TEXT.includes(String(el.type).toLowerCase()));
    if (editable && !el.disabled) return { cursor: "text" };
    if (style.userSelect !== "none" && textUnder(doc, px, py)) return { cursor: "text" };
    return { cursor: "default" };
  }
  return { cursor: "default" };
})`;

/** The cursor Chromium would show at viewport point (x, y) of `page`. */
export async function cursorAt(page: Page, x: number, y: number): Promise<ViewerCursor> {
  let frame: Frame = page.mainFrame();
  let point: [number, number] = [x, y];
  for (let depth = 0; depth < 4; depth++) {
    const found = (await frame.evaluate(`${CURSOR_PROBE}(${JSON.stringify(point)})`)) as Probe;
    if ("cursor" in found) return toViewerCursor(found.cursor);
    // a frame the page cannot enter: find it among the child frames by its position
    let next: Frame | undefined;
    for (const child of frame.childFrames()) {
      const handle = await child.frameElement().catch(() => null);
      const box = await handle?.evaluate((el) => {
        const r = el.getBoundingClientRect();
        return { left: r.left, top: r.top };
      });
      await handle?.dispose();
      if (
        box !== undefined &&
        Math.abs(box.left - found.frame.left) < 1 &&
        Math.abs(box.top - found.frame.top) < 1
      ) {
        next = child;
        break;
      }
    }
    if (next === undefined) return "default";
    frame = next;
    point = [found.inner.x, found.inner.y];
  }
  return "default";
}
