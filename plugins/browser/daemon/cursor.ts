// The page's cursor at a viewport point (browser use spec §8, takeover): a headless browser draws
// no cursor, so the daemon resolves what Chromium would show and the panel sets it on the frame.
// No page code is involved: CDP hit-tests the point (DOM.getNodeForLocation, through shadow roots
// and in-process frames), and a small function runs on the hit node in an isolated world (the
// page's DOM, but not its JavaScript: no prototype override of the page reaches it). It reads the
// computed `cursor`; `auto` follows the browser's rule (an I-beam over editable fields and text,
// else the arrow). A frame in another process (an out-of-process iframe) is entered through its
// own CDP session, a few levels and a bounded number of frames at most.

import type { BrowserContext, CDPSession, Frame, Page } from "playwright-core";
import { toViewerCursor, type ViewerCursor } from "./protocol.js";

/** The child frames looked at when the hit lands on an out-of-process frame. */
export const CURSOR_MAX_FRAMES = 20;
/** Out-of-process frames entered, nested. */
const MAX_DEPTH = 3;
const WORLD = "capybara-cursor";

/**
 * Runs on the hit node in the isolated world: `this` is the node, (x, y) the point in its frame's
 * viewport. Its own builtins are the isolated world's, not the page's.
 */
export const CURSOR_FUNCTION = `function (x, y) {
  const el = this.nodeType === 1 ? this : this.parentElement;
  if (!el) return { cursor: "default" };
  if (el.tagName === "IFRAME" || el.tagName === "FRAME") return { frame: true };
  const doc = el.ownerDocument;
  const view = doc.defaultView;
  const style = view.getComputedStyle(el);
  // "url(a.cur) 4 4, pointer": an image cursor's keyword fallback is the last item
  const parts = String(style.cursor).split(",");
  const cursor = parts[parts.length - 1].trim();
  if (cursor !== "auto") return { cursor };
  const NOT_TEXT = ["button", "submit", "reset", "checkbox", "radio", "range", "color", "file", "image", "hidden"];
  const tag = el.tagName;
  const editable = el.isContentEditable || tag === "TEXTAREA" ||
    (tag === "INPUT" && !NOT_TEXT.includes(String(el.type).toLowerCase()));
  if (editable && !el.disabled) return { cursor: "text" };
  if (style.userSelect === "none") return { cursor: "default" };
  const range = doc.caretRangeFromPoint ? doc.caretRangeFromPoint(x, y) : null;
  const node = range ? range.startContainer : null;
  if (!node || node.nodeType !== 3) return { cursor: "default" };
  const probe = doc.createRange();
  for (const [a, b] of [[range.startOffset, range.startOffset + 1], [range.startOffset - 1, range.startOffset]]) {
    if (a < 0 || b > node.length) continue;
    probe.setStart(node, a);
    probe.setEnd(node, b);
    for (const r of probe.getClientRects())
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return { cursor: "text" };
  }
  return { cursor: "default" };
}`;

type Answer = { cursor?: string; frame?: boolean };

/** Resolves cursors on one page through CDP; worlds are created per frame and kept. */
export class CursorResolver {
  /** Isolated world execution contexts, per CDP session and frame id. */
  private readonly worlds = new WeakMap<CDPSession, Map<string, number>>();
  private readonly sessions = new Map<Frame, CDPSession>();

  constructor(
    private readonly context: BrowserContext,
    private readonly page: Page,
    private readonly cdp: CDPSession,
  ) {}

  /** The cursor Chromium would show at viewport point (x, y). */
  async at(x: number, y: number): Promise<ViewerCursor> {
    let cdp = this.cdp;
    let frame: Frame = this.page.mainFrame();
    let px = x;
    let py = y;
    for (let depth = 0; depth <= MAX_DEPTH; depth++) {
      const hit = (await cdp.send("DOM.getNodeForLocation", {
        x: Math.round(px),
        y: Math.round(py),
        includeUserAgentShadowDOM: false,
        ignorePointerEventsNone: true,
      })) as { backendNodeId: number; frameId?: string };
      const frameId = hit.frameId ?? (await this.mainFrameId(cdp));
      // the point in the hit node's own frame: an in-process frame's owner box is the offset
      const offset = await this.frameOffset(cdp, frameId);
      const answer = await this.run(cdp, frameId, hit.backendNodeId, px - offset.x, py - offset.y);
      if (answer.cursor !== undefined) return toViewerCursor(answer.cursor);
      if (!answer.frame || depth === MAX_DEPTH) return "default";
      // an out-of-process frame: enter it through its own session
      const box = (await cdp.send("DOM.getBoxModel", { backendNodeId: hit.backendNodeId })) as {
        model: { content: number[] };
      };
      const [left = 0, top = 0] = box.model.content;
      const child = await this.childAt(frame, left, top);
      if (child === undefined) return "default";
      frame = child.frame;
      cdp = child.cdp;
      px = px - left;
      py = py - top;
    }
    return "default";
  }

  private async run(
    cdp: CDPSession,
    frameId: string,
    backendNodeId: number,
    x: number,
    y: number,
  ): Promise<Answer> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const contextId = await this.world(cdp, frameId, attempt > 0);
      try {
        const { object } = (await cdp.send("DOM.resolveNode", {
          backendNodeId,
          executionContextId: contextId,
        })) as { object: { objectId?: string } };
        if (object.objectId === undefined) return { cursor: "default" };
        const r = (await cdp.send("Runtime.callFunctionOn", {
          objectId: object.objectId,
          functionDeclaration: CURSOR_FUNCTION,
          arguments: [{ value: x }, { value: y }],
          returnByValue: true,
        })) as { result: { value?: Answer } };
        await cdp.send("Runtime.releaseObject", { objectId: object.objectId }).catch(() => {});
        return r.result.value ?? { cursor: "default" };
      } catch (e) {
        // the world went with a navigation: make a new one once
        if (attempt > 0) throw e;
      }
    }
    return { cursor: "default" };
  }

  private async world(cdp: CDPSession, frameId: string, fresh: boolean): Promise<number> {
    let byFrame = this.worlds.get(cdp);
    if (byFrame === undefined) {
      byFrame = new Map();
      this.worlds.set(cdp, byFrame);
    }
    const known = byFrame.get(frameId);
    if (known !== undefined && !fresh) return known;
    const { executionContextId } = (await cdp.send("Page.createIsolatedWorld", {
      frameId,
      worldName: WORLD,
    })) as { executionContextId: number };
    byFrame.set(frameId, executionContextId);
    return executionContextId;
  }

  private async mainFrameId(cdp: CDPSession): Promise<string> {
    const { frameTree } = (await cdp.send("Page.getFrameTree")) as {
      frameTree: { frame: { id: string } };
    };
    return frameTree.frame.id;
  }

  /** The offset of an in-process frame's viewport in the session's root (0 for its main frame). */
  private async frameOffset(cdp: CDPSession, frameId: string): Promise<{ x: number; y: number }> {
    if (frameId === (await this.mainFrameId(cdp))) return { x: 0, y: 0 };
    const owner = (await cdp.send("DOM.getFrameOwner", { frameId })) as { backendNodeId: number };
    const box = (await cdp.send("DOM.getBoxModel", { backendNodeId: owner.backendNodeId })) as {
      model: { content: number[] };
    };
    return { x: box.model.content[0] ?? 0, y: box.model.content[1] ?? 0 };
  }

  /** The child frame of `parent` whose element's content box starts at (left, top). */
  private async childAt(
    parent: Frame,
    left: number,
    top: number,
  ): Promise<{ frame: Frame; cdp: CDPSession } | undefined> {
    for (const child of parent.childFrames().slice(0, CURSOR_MAX_FRAMES)) {
      const handle = await child.frameElement().catch(() => null);
      const box = await handle?.boundingBox().catch(() => null);
      await handle?.dispose();
      if (box === null || box === undefined) continue;
      if (Math.abs(box.x - left) > 3 || Math.abs(box.y - top) > 3) continue;
      let cdp = this.sessions.get(child);
      if (cdp === undefined) {
        cdp = await this.context.newCDPSession(child);
        this.sessions.set(child, cdp);
      }
      return { frame: child, cdp };
    }
    return undefined;
  }
}
