// One viewer stream (spec §8): the shown tab's screencast at the viewer's size, paced by its
// acks (viewer-pacing.ts: frames kept small and few enough that input never waits long behind
// them) and capped in rate and message size; its input, address bar and tab actions, applied only
// while the person holds control (the watch state is read-only); the page's cursor under the
// pointer; takeover and hand back; and every state change, blocked host and dialog of its tree. A
// new viewer gets the full state at once (the panel remounts on expand and collapse, so the
// daemon is the source of truth).
//
// A viewer belongs to one conversation (the kernel's viewer context) and sees that conversation's
// tree (tab ownership spec §5): the tabs the tree's conversations own, grouped, plus the other
// trees' tabs in `otherTabs`. Its shown tab is a viewer-local choice: by default its own
// conversation's active tab, else the active tab of the tree's conversation that acted last; a
// new handoff of the tree shows the handoff's conversation's active tab; the person may choose any
// tab of the tree (`show`, also in the watch state). A viewer pins its own conversation and the
// owner of the tab it shows (they do not idle while it is open).

import type { CDPSession, Page } from "playwright-core";
import { type BrowserSession, clip, isStartBlank, jpegSize, type SessionEvent } from "./actions.js";
import { CursorResolver } from "./cursor.js";
import {
  clipCodePoints,
  encodeFrame,
  FRAME_HEADER_BYTES,
  VIEWER_MAX_FPS,
  VIEWER_TEXT_MAX_CHARS,
  VIEWER_UNACKED_FRAMES,
  VIEWPORT,
  VIEWPORT_PROFILES,
  type ViewerCursor,
  type ViewerIn,
  type ViewerOut,
  type ViewerTab,
} from "./protocol.js";
import type { Clock, DaemonState } from "./state.js";
import { FramePacer, FrameQuality } from "./viewer-pacing.js";

/**
 * Where a viewer's messages go: JSON messages and binary frames. Both return false while the
 * transport is backed up (the message is still queued, never dropped).
 */
export interface ViewerTransport {
  send(m: ViewerOut): boolean;
  sendFrame(frame: Uint8Array): boolean;
  whenDrained(): Promise<void>;
}

/** How often the daemon pings a viewer (the path's own round trip, for the pacing). */
export const VIEWER_PING_MS = 1000;
/** The longest the first frame's capture may take (a page a dialog holds never answers it). */
const FIRST_FRAME_MS = 1000;
/** A screencast restart (new quality or scale) waits at least this long after the last one. */
const RESTART_MIN_MS = 500;
/** Chromium is let encode the next frame at most this often while frames wait for the viewer. */
const ENCODE_MAX_INTERVAL_MS = 500;
/**
 * A cursor answer later than this is dropped (the next pointer position asks again); the next
 * lookup waits for a late one to settle, so lookups never overlap.
 */
export const CURSOR_TIMEOUT_MS = 200;

type ScreencastFrame = {
  data: string;
  sessionId: number;
};

const clampDim = (n: unknown, max: number) =>
  typeof n === "number" && Number.isFinite(n) ? Math.max(16, Math.min(max, Math.floor(n))) : max;

export class ViewerSession {
  private readonly browser: BrowserSession;
  private readonly state: DaemonState;
  /** The viewer's conversation and the root of its tree (from the kernel's viewer context). */
  private readonly conv: string;
  private readonly root: string;
  /** The tab the person (or a new handoff) chose to show; cleared when it leaves the tree. */
  private choice: string | undefined;
  /** The tab shown now (computed with every state). */
  private shown: string | undefined;
  /** The other conversation the viewer pins because it shows one of its tabs. */
  private pinnedOwner: string | undefined;
  /** Group keys of the tree's other conversations, in order of first appearance. */
  private readonly groups = new Map<string, string>();
  /** The tree's handoffs seen so far (a new one moves the shown tab to its conversation). */
  private seenHandoffs = new Set<string>();
  private readonly out: ViewerTransport;
  private readonly clock: Clock;
  private readonly frameMaxBytes: number;
  private readonly unsubscribe: (() => void)[] = [];
  private maxWidth: number = VIEWPORT.width;
  private maxHeight: number = VIEWPORT.height;
  private readonly pacer = new FramePacer({
    maxFps: VIEWER_MAX_FPS,
    maxUnacked: VIEWER_UNACKED_FRAMES,
  });
  /** Quality and scale: lowered while frames are slow on the link or over the message cap. */
  private readonly frameQuality = new FrameQuality();
  private lastRestartAt = Number.NEGATIVE_INFINITY;
  private started = false;
  private closed = false;
  private page: Page | undefined;
  private cdp: CDPSession | undefined;
  /** Serializes attach / detach / restart. */
  private chain: Promise<unknown> = Promise.resolve();
  private inputChain: Promise<void> = Promise.resolve();
  /** Bumped on close and hand back: input queued before it is dropped, not replayed. */
  private inputGen = 0;
  /**
   * The newest pointer position not yet applied, while a move for it waits on the input chain:
   * later moves replace it (the newest wins) instead of queueing behind it.
   */
  private moveSlot: { x: number; y: number } | undefined;
  /** The cursor last sent (reset when control returns to the agent). */
  private cursor: ViewerCursor | undefined;
  /** Resolves cursors on the attached page (off the input chain, see {@link wantCursor}). */
  private cursorResolver: CursorResolver | undefined;
  /** The newest pointer position whose cursor is wanted; one resolution runs at a time. */
  private cursorPoint: { x: number; y: number } | undefined;
  /** The resolver a resolution loop runs for (one loop per resolver, one lookup at a time). */
  private cursorLoop: CursorResolver | undefined;
  /**
   * Keys and buttons this viewer pressed and has not released: released for the agent when
   * control returns to it or the viewer ends, whatever reached the page of the person's input.
   */
  private readonly heldKeys = new Map<string, Page>();
  private readonly heldButtons = new Map<"left" | "right", Page>();
  private seq = 0;
  /**
   * The newest screencast frame waiting for room (viewer acks, transport, rate cap). A newer one
   * replaces it: a frame is never queued behind a stale one.
   */
  private pending: { cdp: CDPSession; jpeg: Buffer; width: number; height: number } | undefined;
  /** Chromium frames received but not acked to Chromium yet (it encodes the next after an ack). */
  private encodeAck: { cdp: CDPSession; sessionId: number } | undefined;
  private encodeTimer: unknown;
  private lastEncodeAckAt = Number.NEGATIVE_INFINITY;
  private pumpTimer: unknown;
  private pingTimer: unknown;
  private pingSeq = 0;
  private readonly pingsSent = new Map<number, number>();
  private draining = false;
  private stateQueued = false;
  private lastControl: "agent" | "user" = "agent";
  /** The viewport the screencast was started for (a profile switch restarts it). */
  private streamedViewport = "";

  constructor(opts: {
    browser: BrowserSession;
    state: DaemonState;
    conversationId: string;
    rootConversationId: string;
    transport: ViewerTransport;
    clock: Clock;
    frameMaxBytes: number;
  }) {
    this.browser = opts.browser;
    this.state = opts.state;
    this.conv = opts.conversationId;
    this.root = opts.rootConversationId;
    // the viewer's own conversation does not idle while the viewer is open
    this.state.pin(this.conv, this.root);
    this.out = opts.transport;
    this.clock = opts.clock;
    this.frameMaxBytes = opts.frameMaxBytes;
  }

  /**
   * Handles one viewer message; the first must be `hello`. It returns at once: screencast work runs
   * on its own chain and input (mouse, keys, address bar, tabs) on another, in order, so a slow
   * navigation or screenshot never holds back a takeover, hand back or frame ack.
   */
  handle(m: ViewerIn): void {
    if (this.closed) return;
    if (!this.started) {
      if (m.t !== "hello") return;
      this.started = true;
      this.setSize(m.maxWidth, m.maxHeight);
      this.lastControl = this.state.control;
      this.unsubscribe.push(
        this.browser.on((e) => this.onSession(e)),
        this.state.onChange(() => this.onControl()),
      );
      // a pending handoff of the tree is shown at once (the newest)
      const pending = this.state.handoffs(this.root);
      this.seenHandoffs = new Set(pending.map(handoffKey));
      const newest = pending.at(-1);
      if (newest !== undefined) this.choice = this.browser.activeTabOf(newest.conversationId);
      this.sendState();
      this.ping();
      return;
    }
    switch (m.t) {
      case "hello":
      case "resize":
        this.setSize(m.maxWidth, m.maxHeight);
        void this.serial(async () => {
          await this.detach();
          await this.attach();
        });
        return;
      case "frame-ack":
        if (typeof m.seq === "number") this.onAck(Math.min(m.seq, this.seq));
        this.pump();
        return;
      case "pong": {
        const sentAt = typeof m.id === "number" ? this.pingsSent.get(m.id) : undefined;
        if (sentAt !== undefined) {
          this.pingsSent.delete(m.id);
          this.pacer.pinged(this.clock.now() - sentAt);
        }
        return;
      }
      case "takeover":
        this.state.takeover(this.browser.owningConversations());
        return;
      case "handback":
        this.inputGen++;
        this.state.handback();
        return;
      case "mouse":
        if (m.kind === "move") this.move(m);
        else this.input(() => this.mouse(m));
        return;
      case "key":
        this.input(() => this.key(m));
        return;
      case "nav":
        this.input(async () => {
          let page = this.shownPage();
          if (page === undefined) {
            // the tree has no tab yet: the address bar opens one for the viewer's conversation
            if (typeof m.url !== "string") return;
            page = await this.openOwnTab();
            if (page === undefined) return;
          }
          this.concern(this.browser.tabIdOf(page));
          await this.browser.viewerNav(page, {
            ...(typeof m.url === "string" ? { url: m.url } : {}),
            ...(m.action === undefined ? {} : { action: m.action }),
          });
        });
        return;
      case "show":
        // a viewer-local choice, allowed in the watch state (no page input)
        if (typeof m.tabId === "string" && this.inTree(m.tabId)) {
          this.choice = m.tabId;
          this.queueState();
        }
        return;
      case "dialog":
        // straight, not on the input chain: the person's own click that opened the dialog may
        // still wait there for this answer
        if (this.state.control !== "user") return;
        void this.browser.answerFromViewer(this.root, m).catch(() => undefined);
        return;
      case "permission":
        if (this.state.control !== "user" || m.allow !== true) return;
        void this.browser.grantPermission(this.root, m.origin, m.permission);
        return;
      case "viewport":
        // in order with the person's input: touches sent before the switch keep their profile
        this.input(() => this.browser.setProfile(m.profile));
        return;
      case "touch":
        this.input(async () => {
          const page = this.shownPage();
          if (page === undefined) return;
          this.concern(this.browser.tabIdOf(page));
          const vp = this.browser.viewport;
          const points: { id: number; x: number; y: number }[] = [];
          for (const q of Array.isArray(m.points) ? m.points.slice(0, 10) : []) {
            const at = point(q, vp);
            const id = Number(q?.id);
            if (at !== null && Number.isFinite(id)) points.push({ id, ...at });
          }
          const kind = m.kind;
          if (kind !== "start" && kind !== "move" && kind !== "end" && kind !== "cancel") return;
          await this.browser.touch(page, kind, points);
        });
        return;
      case "tab":
        if (m.action === "adopt") {
          // an ownership change, not page input: allowed in the watch state
          this.adopt(m.tabId);
          return;
        }
        this.input(async () => {
          try {
            if (m.action === "open") await this.openOwnTab();
            else if (m.action === "switch" && m.tabId !== undefined) this.switchTo(m.tabId);
            else if (m.action === "close" && m.tabId !== undefined && this.inTree(m.tabId)) {
              this.concern(m.tabId);
              await this.browser.closeTab(this.browser.tabById(m.tabId));
            }
          } catch {
            // a stale tab id or a cap: the next state message shows the real tabs
          }
        });
        return;
    }
  }

  /** Whether a tab belongs to the viewer's tree. */
  private inTree(tabId: string): boolean {
    return (
      this.browser.ownerOf(tabId)?.root === this.root && this.browser.pageById(tabId) !== undefined
    );
  }

  /** The shown tab's page, if the tree has one. */
  private shownPage(): Page | undefined {
    return this.browser.pageById(this.shown);
  }

  /** The person used a tab during the takeover: its owner gets the hand back note. */
  private concern(tabId: string | undefined): void {
    if (tabId === undefined) return;
    this.state.concern(this.browser.ownerOf(tabId)?.owner);
  }

  /**
   * A tab the person opens: owned by the viewer's conversation, made its active tab and shown
   * (the caps apply; a refusal opens nothing).
   */
  private async openOwnTab(): Promise<Page | undefined> {
    try {
      // the conversation's first tab may be the unowned blank one, as for the tool's open
      const page =
        this.browser.countOf(this.conv) === 0
          ? await this.browser.pageFor(this.conv, this.root)
          : await this.browser.openTab(this.conv, this.root);
      this.state.concern(this.conv);
      this.choice = undefined;
      this.queueState();
      return page;
    } catch {
      return undefined;
    }
  }

  /**
   * Shows a tab of the tree and brings it to the front (a viewer in control decides what is
   * front). A tab of the viewer's own conversation also becomes its active tab (the person chose
   * it); another conversation's tab changes only the shown tab, never that agent's active tab.
   */
  private switchTo(tabId: string): void {
    if (!this.inTree(tabId)) return;
    if (this.browser.ownerOf(tabId)?.owner === this.conv) {
      this.browser.setActive(this.conv, tabId);
      this.choice = undefined;
    } else this.choice = tabId;
    void this.browser.bringToFront(tabId);
    this.queueState();
  }

  /**
   * Moves another tree's tab (or an unowned one) to the viewer's conversation, as the tool's adopt;
   * a tab of the viewer's own tree is ignored (inside the tree the person drives tabs without
   * moving them). A tab whose owner is in use answers the `tab_in_use` notice.
   */
  private adopt(tabId: string | undefined): void {
    if (typeof tabId !== "string" || this.browser.pageById(tabId) === undefined) return;
    if (this.browser.ownerOf(tabId)?.root === this.root) return;
    let result: "ok" | "in_use" | "cap";
    try {
      result = this.browser.adopt(this.conv, this.root, tabId);
    } catch {
      return;
    }
    if (result === "in_use") this.send({ t: "notice", code: "tab_in_use" });
    else if (result === "cap") this.send({ t: "notice", code: "tab_cap" });
    else if (result === "ok") {
      this.choice = undefined;
      this.queueState();
    }
  }

  /**
   * Runs viewer input in arrival order, apart from the screencast chain, and only while the person
   * holds control: input from a viewer in the watch state (the agent drives) is dropped, both when
   * it arrives and when its turn comes.
   */
  private input(fn: () => Promise<void>): void {
    if (this.state.control !== "user") return;
    // a later move starts a new slot: it must not jump ahead of this input
    this.moveSlot = undefined;
    const gen = this.inputGen;
    const guarded = () =>
      gen === this.inputGen && !this.closed && this.state.control === "user"
        ? fn()
        : Promise.resolve();
    const run = this.inputChain.then(guarded, guarded);
    this.inputChain = run.catch(() => undefined);
  }

  /** A pointer move: coalesced while one waits (the newest position wins), then the cursor. */
  private move(m: Extract<ViewerIn, { t: "mouse" }>): void {
    if (this.state.control !== "user") return;
    const p = point(m, this.browser.viewport);
    if (p === null) return;
    if (this.moveSlot !== undefined) {
      this.moveSlot.x = p.x;
      this.moveSlot.y = p.y;
      return;
    }
    const slot = { ...p };
    this.input(async () => {
      if (this.moveSlot === slot) this.moveSlot = undefined;
      const page = this.shownPage();
      if (page === undefined) return;
      try {
        await page.mouse.move(slot.x, slot.y);
      } catch {
        return;
      }
      this.wantCursor(slot.x, slot.y);
    });
    // input() cleared the slot for ordinary input; a move keeps it open for the next moves
    this.moveSlot = slot;
  }

  /**
   * Asks for the page's cursor at (x, y): resolved off the input chain (a click never waits for
   * it), the newest position wins while one resolution runs, and an answer later than
   * CURSOR_TIMEOUT_MS is dropped.
   */
  private wantCursor(x: number, y: number): void {
    this.cursorPoint = { x, y };
    const resolver = this.cursorResolver;
    // one loop per resolver: a lookup stuck on a frozen page holds only that page's loop
    if (resolver === undefined || this.cursorLoop === resolver) return;
    this.cursorLoop = resolver;
    void (async () => {
      try {
        while (!this.closed && this.cursorResolver === resolver) {
          const p = this.cursorPoint;
          this.cursorPoint = undefined;
          if (p === undefined) return;
          // one lookup at a time: the next one starts only once this one settled, so a slow
          // page never piles lookups up; an answer later than CURSOR_TIMEOUT_MS is stale
          const started = this.clock.now();
          const cursor = await resolver.at(p.x, p.y).catch(() => undefined);
          if (cursor === undefined || this.clock.now() - started > CURSOR_TIMEOUT_MS) continue;
          // a newer position asks again; an answer for this one would only flicker
          if (this.cursorPoint !== undefined) continue;
          if (cursor === this.cursor || this.closed || this.state.control !== "user") continue;
          this.cursor = cursor;
          this.send({ t: "cursor", cursor });
        }
      } finally {
        if (this.cursorLoop === resolver) this.cursorLoop = undefined;
      }
    })();
  }

  /**
   * Releases the keys and buttons this viewer still holds (straight, not on the input chain and
   * not through the control gate): the agent must not inherit a held Shift or a drag.
   */
  private async releaseHeld(): Promise<void> {
    if (this.heldKeys.size === 0 && this.heldButtons.size === 0) return;
    const keys = [...this.heldKeys];
    const buttons = [...this.heldButtons];
    this.heldKeys.clear();
    this.heldButtons.clear();
    // each on the tab where it was pressed (the person may have switched tabs meanwhile)
    for (const [key, page] of keys) await page.keyboard.up(key).catch(() => undefined);
    for (const [button, page] of buttons) {
      // off the page first (outside the viewport: no element there): the release must not
      // complete the person's click for the agent
      await page.mouse.move(-1, -1).catch(() => undefined);
      await page.mouse.up({ button }).catch(() => undefined);
    }
  }

  /** Whether input this viewer applied should stay applied (still in control, not closed). */
  private get driving(): boolean {
    return !this.closed && this.state.control === "user";
  }

  /** Ends the viewer: stops its screencast and its subscriptions, and lets go of its pins. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.inputGen++;
    this.state.unpin(this.conv);
    if (this.pinnedOwner !== undefined) this.state.unpin(this.pinnedOwner);
    this.pinnedOwner = undefined;
    await this.releaseHeld();
    for (const u of this.unsubscribe.splice(0)) u();
    for (const t of [this.pumpTimer, this.pingTimer, this.encodeTimer])
      if (t !== undefined) this.clock.cancel(t);
    await this.serial(() => this.detach());
  }

  private setSize(w: unknown, h: unknown): void {
    this.maxWidth = clampDim(w, VIEWPORT.width);
    // a portrait phone viewport is taller than the desktop one
    this.maxHeight = clampDim(h, Math.max(VIEWPORT.height, VIEWPORT_PROFILES.phone.height));
  }

  /** Pings the viewer every VIEWER_PING_MS (its pong measures the path, see the pacing). */
  private ping(): void {
    if (this.closed) return;
    const id = ++this.pingSeq;
    this.pingsSent.set(id, this.clock.now());
    // a viewer that never answers keeps only the newest few
    for (const old of this.pingsSent.keys()) if (old < id - 4) this.pingsSent.delete(old);
    this.send({ t: "ping", id });
    this.pingTimer = this.clock.schedule(() => this.ping(), VIEWER_PING_MS);
  }

  /**
   * Control or handoffs changed: a new state; input of the old control dropped; a new handoff of
   * the tree shows its conversation's active tab.
   */
  private onControl(): void {
    const pending = this.state.handoffs(this.root);
    const fresh = pending.filter((h) => !this.seenHandoffs.has(handoffKey(h))).at(-1);
    this.seenHandoffs = new Set(pending.map(handoffKey));
    if (fresh !== undefined) {
      const tab = this.browser.activeTabOf(fresh.conversationId);
      if (tab !== undefined) this.choice = tab;
    }
    const control = this.state.control;
    if (control !== this.lastControl) {
      this.lastControl = control;
      this.moveSlot = undefined;
      this.cursor = undefined;
      this.cursorPoint = undefined;
      if (control === "agent") {
        this.inputGen++;
        void this.releaseHeld();
      }
    }
    this.queueState();
  }

  private serial(fn: () => Promise<void>): Promise<void> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run.catch(() => undefined);
  }

  /**
   * A non-frame message cut to the per-message cap (BROWSER_FRAME_MAX_BYTES): long page text is
   * shortened, and a message that still does not fit is dropped (null). Frames are sized when
   * captured.
   */
  private fitted(m: ViewerOut): ViewerOut | null {
    const fits = (x: ViewerOut) => Buffer.byteLength(JSON.stringify(x)) <= this.frameMaxBytes;
    if (fits(m)) return m;
    let small: ViewerOut;
    if (m.t === "state") {
      // the icons go first: the strip falls back to its placeholders
      const plain = { ...m, tabs: m.tabs.map(({ favicon: _icon, ...t }) => t) };
      if (fits(plain)) return plain;
      m = plain;
      small = {
        ...m,
        tabs: m.tabs.map((t) => ({
          ...t,
          title: clip(t.title, 200),
          url: clip(t.url, 200),
          ...(t.blocker === undefined
            ? {}
            : { blocker: { ...t.blocker, url: clip(t.blocker.url, 200) } }),
        })),
        otherTabs: m.otherTabs.map((t) => ({
          ...t,
          title: clip(t.title, 200),
          url: clip(t.url, 200),
        })),
        handoffs: m.handoffs.map((h) => ({ ...h, message: clip(h.message, 200) })),
        dialogs: m.dialogs.map((d) => ({
          ...d,
          message: clip(d.message, 200),
          ...(d.defaultValue === undefined ? {} : { defaultValue: clip(d.defaultValue, 200) }),
        })),
      };
    } else if (m.t === "dialog") {
      small = { ...m, message: clip(m.message, 200) };
    } else if (m.t === "blocked") {
      small = { ...m, url: clip(m.url, 200) };
    } else return null;
    return fits(small) ? small : null;
  }

  /** Sends a JSON message at once: it never waits behind a held frame. */
  private send(raw: ViewerOut): void {
    if (this.closed) return;
    const m = this.fitted(raw);
    if (m === null) return;
    if (!this.out.send(m)) this.awaitDrain();
  }

  private awaitDrain(): void {
    if (this.draining) return;
    this.draining = true;
    this.out.whenDrained().then(() => {
      this.draining = false;
      this.pump();
    });
  }

  private onSession(e: SessionEvent): void {
    if (e.type === "state") this.queueState();
    else if (e.type === "active") {
      // the viewer follows its own agent's new active tab (a popup, a new tab, a switch), and the
      // agent whose tab it shows when that one moves on
      if (e.conversationId === this.conv) this.choice = undefined;
      else if (
        this.shown !== undefined &&
        this.browser.ownerOf(this.shown)?.owner === e.conversationId
      )
        this.choice = this.browser.activeTabOf(e.conversationId);
      this.queueState();
    } else if (e.root !== this.root) return;
    else if (e.type === "blocked")
      this.send({
        t: "blocked",
        host: e.host,
        url: e.url,
        ...(e.kind === "loopback" ? { port: e.port, kind: e.kind } : {}),
      });
    else if (e.type === "permission")
      this.send({
        t: "permission",
        origin: e.origin,
        permission: e.permission,
        grantable: e.grantable,
      });
    else this.send({ t: "dialog", kind: e.kind, message: e.message });
  }

  /** Coalesces bursts of changes into one state message. */
  private queueState(): void {
    if (this.stateQueued) return;
    this.stateQueued = true;
    queueMicrotask(() => {
      this.stateQueued = false;
      this.sendState();
    });
  }

  /**
   * The tab to show: the chosen one while it is in the tree; else the viewer's conversation's
   * active tab; else the active tab of the tree's conversation that acted last; else the tree's
   * first tab; none when the tree owns no tab.
   */
  private computeShown(tree: { id: string; owner?: string }[]): string | undefined {
    if (this.choice !== undefined && tree.some((t) => t.id === this.choice)) return this.choice;
    this.choice = undefined;
    const own = this.browser.activeTabOf(this.conv);
    if (own !== undefined) return own;
    let best: { tab: string; order: number } | undefined;
    for (const owner of new Set(tree.map((t) => t.owner))) {
      if (owner === undefined) continue;
      const tab = this.browser.activeTabOf(owner);
      const order = this.browser.actedOrder(owner);
      if (tab !== undefined && (best === undefined || order > best.order)) best = { tab, order };
    }
    return best?.tab ?? tree[0]?.id;
  }

  /** Pins the owner of the shown tab (besides the viewer's own conversation). */
  private pinShownOwner(): void {
    const owner = this.shown === undefined ? undefined : this.browser.ownerOf(this.shown);
    const next = owner === undefined || owner.owner === this.conv ? undefined : owner.owner;
    if (next === this.pinnedOwner) return;
    if (next !== undefined && owner !== undefined) this.state.pin(next, owner.root);
    if (this.pinnedOwner !== undefined) this.state.unpin(this.pinnedOwner);
    this.pinnedOwner = next;
  }

  private groupOf(owner: string | undefined): string {
    if (owner === this.conv || owner === undefined) return "own";
    let g = this.groups.get(owner);
    if (g === undefined) {
      g = `sub${this.groups.size + 1}`;
      this.groups.set(owner, g);
    }
    return g;
  }

  private sendState(): void {
    if (this.closed) return;
    const all = this.browser.tabs();
    const tree = all.filter((t) => t.root === this.root);
    this.shown = this.computeShown(tree);
    this.pinShownOwner();
    // the screencast follows the shown tab and the viewport profile
    const viewport = this.browser.viewport;
    const vpKey = `${viewport.width}x${viewport.height}`;
    if (this.browser.pageById(this.shown) !== this.page || vpKey !== this.streamedViewport) {
      void this.serial(async () => {
        const key = `${this.browser.viewport.width}x${this.browser.viewport.height}`;
        if (this.browser.pageById(this.shown) === this.page && key === this.streamedViewport)
          return;
        await this.detach();
        await this.attach();
      });
    }
    const order = new Map<string, number>([["own", 0]]);
    const tabs: ViewerTab[] = tree.map((t) => {
      const group = this.groupOf(t.owner);
      if (!order.has(group)) order.set(group, order.size);
      return {
        id: t.id,
        title: t.title,
        url: t.url,
        active: t.id === this.shown,
        group,
        ...(t.blocker === undefined ? {} : { blocker: t.blocker }),
        ...(t.favicon === undefined ? {} : { favicon: t.favicon }),
        ...(t.loading === true ? { loading: true as const } : {}),
      };
    });
    // the own group first, then each other group in order of first appearance (a stable sort)
    tabs.sort((a, b) => (order.get(a.group) ?? 0) - (order.get(b.group) ?? 0));
    const shownTab = tree.find((t) => t.id === this.shown);
    const last = this.browser.lastClickOf(this.shown);
    // the newest pending long wait of the tree (the panel's status line)
    const waiting = this.browser.watches.waitingOf(this.root);
    this.send({
      t: "state",
      tabs,
      ...(this.shown === undefined ? {} : { shown: this.shown }),
      otherTabs: all
        .filter((t) => t.root !== this.root && !isStartBlank(t))
        .map((t) => ({ id: t.id, title: t.title, url: t.url })),
      loading: this.browser.isLoading(this.shown),
      secure: shownTab?.url.startsWith("https:") ?? false,
      control: this.state.control,
      ...(last === undefined ? {} : { lastClick: last }),
      handoffs: this.state.handoffs(this.root).map((h) => ({
        callId: h.callId,
        conversationId: h.conversationId,
        message: h.message,
        tabIds: this.browser.tabsOf(h.conversationId),
      })),
      ...(waiting === undefined
        ? {}
        : { waiting: { label: waiting.label.slice(0, 200), until: waiting.until } }),
      dialogs: this.browser.dialogsOf(this.root),
      viewport,
    });
  }

  private get scale(): number {
    const vp = this.browser.viewport;
    return (
      Math.min(1, this.maxWidth / vp.width, this.maxHeight / vp.height) * this.frameQuality.shrink
    );
  }

  /** Room for the JPEG in one frame message. */
  private get jpegBudget(): number {
    return this.frameMaxBytes - FRAME_HEADER_BYTES;
  }

  private async attach(): Promise<void> {
    if (this.closed) return;
    // the tree owns no tab: no frames (the panel shows its empty state)
    const page = this.shownPage();
    if (page === undefined) return;
    this.streamedViewport = `${this.browser.viewport.width}x${this.browser.viewport.height}`;
    const cdp = await this.browser.context.newCDPSession(page);
    this.page = page;
    this.cdp = cdp;
    cdp.on("Page.screencastFrame", (f: ScreencastFrame) => this.onFrame(cdp, f));
    this.cursorResolver = new CursorResolver(this.browser.context, page, cdp);
    // Screencast is silent on a static page: the first frame is a screenshot. A page a JS dialog
    // holds never answers a capture: bounded, the screencast starts anyway.
    let timer: unknown;
    const first = await Promise.race([
      this.browser
        .capture(page, { maxBytes: this.jpegBudget, maxScale: this.scale })
        .catch(() => null),
      new Promise<null>((r) => {
        timer = this.clock.schedule(() => r(null), FIRST_FRAME_MS);
      }),
    ]);
    this.clock.cancel(timer);
    if (first !== null && this.cdp === cdp) {
      // like any frame: it waits for room (the transport, the pacer), the newest wins
      this.pending = {
        cdp,
        jpeg: Buffer.from(first.data, "base64"),
        width: first.width,
        height: first.height,
      };
      this.pump();
    }
    await this.startScreencast(cdp);
  }

  private async startScreencast(cdp: CDPSession): Promise<void> {
    if (this.closed || this.cdp !== cdp) return;
    await cdp.send("Page.startScreencast", {
      format: "jpeg",
      quality: this.frameQuality.quality,
      maxWidth: Math.max(16, Math.floor(this.browser.viewport.width * this.scale)),
      maxHeight: Math.max(16, Math.floor(this.browser.viewport.height * this.scale)),
      everyNthFrame: 1,
    });
  }

  private async detach(): Promise<void> {
    const cdp = this.cdp;
    this.cdp = undefined;
    this.page = undefined;
    this.pending = undefined;
    this.encodeAck = undefined;
    this.cursorResolver?.dispose();
    this.cursorResolver = undefined;
    if (cdp === undefined) return;
    await cdp.send("Page.stopScreencast").catch(() => undefined);
    await cdp.detach().catch(() => undefined);
  }

  private sendFrame(jpeg: Uint8Array, width: number, height: number): void {
    this.seq++;
    this.pacer.sent(this.seq, this.clock.now());
    if (!this.out.sendFrame(encodeFrame({ seq: this.seq, width, height, jpeg }))) this.awaitDrain();
  }

  /** The viewer acked frames up to `seq`: the link time adapts quality and scale. */
  private onAck(seq: number): void {
    const sample = this.pacer.acked(seq, this.clock.now());
    if (sample === undefined) return;
    if (this.clock.now() - this.lastRestartAt < RESTART_MIN_MS) return;
    if (this.frameQuality.observe(this.pacer.linkMs ?? sample)) this.restart();
  }

  /** Restarts the screencast at the current quality and scale. */
  private restart(): void {
    const cdp = this.cdp;
    if (cdp === undefined) return;
    this.lastRestartAt = this.clock.now();
    this.pacer.reset();
    void this.serial(async () => {
      if (this.cdp !== cdp) return;
      await cdp.send("Page.stopScreencast").catch(() => undefined);
      this.pending = undefined;
      this.encodeAck = undefined;
      await this.startScreencast(cdp);
    });
  }

  private onFrame(cdp: CDPSession, f: ScreencastFrame): void {
    if (this.closed || this.cdp !== cdp) return;
    const bytes = Buffer.from(f.data, "base64");
    if (bytes.length > this.jpegBudget) {
      // Too big for one message: drop it and continue smaller.
      cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => undefined);
      if (this.frameQuality.tooLarge()) this.restart();
      return;
    }
    const { width, height } = jpegSize(bytes);
    // the newest frame wins: one still waiting is replaced, never sent after this one
    this.pending = { cdp, jpeg: bytes, width, height };
    this.encodeAck = { cdp, sessionId: f.sessionId };
    this.pump();
    this.scheduleEncodeAck();
  }

  /**
   * Lets Chromium encode its next frame (screencastFrameAck): at most at the viewer's frame rate
   * while frames flow, and while one waits for the viewer only every ENCODE_MAX_INTERVAL_MS, so
   * the frame sent when room comes is a recent one without encoding frames nobody gets.
   */
  private scheduleEncodeAck(): void {
    if (this.encodeTimer !== undefined) this.clock.cancel(this.encodeTimer);
    this.encodeTimer = undefined;
    const ack = this.encodeAck;
    if (ack === undefined || this.closed) return;
    const gap = this.pending === undefined ? 1000 / VIEWER_MAX_FPS : ENCODE_MAX_INTERVAL_MS;
    const wait = this.lastEncodeAckAt + gap - this.clock.now();
    if (wait > 0) {
      this.encodeTimer = this.clock.schedule(() => {
        this.encodeTimer = undefined;
        this.scheduleEncodeAck();
      }, wait);
      return;
    }
    this.encodeAck = undefined;
    if (this.cdp !== ack.cdp) return;
    this.lastEncodeAckAt = this.clock.now();
    ack.cdp.send("Page.screencastFrameAck", { sessionId: ack.sessionId }).catch(() => undefined);
  }

  /**
   * Sends the newest screencast frame once the pacer allows (viewer acks, link time, rate cap)
   * and the transport is not backed up.
   */
  private pump(): void {
    const pending = this.pending;
    if (pending === undefined || this.closed || this.draining) return;
    const d = this.pacer.decide(this.clock.now());
    if (!d.ok) {
      if (d.waitMs !== undefined && this.pumpTimer === undefined) {
        this.pumpTimer = this.clock.schedule(() => {
          this.pumpTimer = undefined;
          this.pump();
        }, d.waitMs);
      }
      return;
    }
    this.pending = undefined;
    if (this.cdp !== pending.cdp) return;
    this.sendFrame(pending.jpeg, pending.width, pending.height);
    // the frame left: Chromium may encode the next one at the frame rate again
    this.scheduleEncodeAck();
  }

  private async mouse(m: Extract<ViewerIn, { t: "mouse" }>): Promise<void> {
    const page = this.shownPage();
    const p = point(m, this.browser.viewport);
    if (p === null || page === undefined) return;
    this.concern(this.browser.tabIdOf(page));
    const { x, y } = p;
    const button = m.button === "right" ? "right" : "left";
    try {
      if (m.kind === "down") {
        await page.mouse.move(x, y);
        await page.mouse.down({ button });
        // control went to the agent meanwhile: let go at once instead of holding it
        if (this.driving) this.heldButtons.set(button, page);
        else await page.mouse.up({ button });
      } else if (m.kind === "up") {
        this.heldButtons.delete(button);
        await page.mouse.move(x, y);
        await page.mouse.up({ button });
      } else if (m.kind === "wheel") {
        await page.mouse.move(x, y);
        await page.mouse.wheel(Number(m.dx) || 0, Number(m.dy) || 0);
      } else return;
    } catch {
      // the page navigated or closed under the pointer
      return;
    }
    // a click or a scroll may change what is under the pointer
    if (m.kind !== "down") this.wantCursor(x, y);
  }

  private async key(m: Extract<ViewerIn, { t: "key" }>): Promise<void> {
    const page = this.shownPage();
    if (page === undefined) return;
    this.concern(this.browser.tabIdOf(page));
    try {
      if (m.kind === "char") {
        const text = m.text ?? m.key;
        if (typeof text === "string" && text !== "")
          await page.keyboard.insertText(clipCodePoints(text, VIEWER_TEXT_MAX_CHARS));
      } else if (m.kind === "down") {
        await page.keyboard.down(m.key);
        // control went to the agent meanwhile: let go at once instead of holding it
        if (this.driving) this.heldKeys.set(m.key, page);
        else await page.keyboard.up(m.key);
      } else if (m.kind === "up") {
        this.heldKeys.delete(m.key);
        await page.keyboard.up(m.key);
      }
    } catch {
      // a key Playwright does not know (IME process keys, media keys): ignored
    }
  }
}

/** Identifies a pending handoff (a callId is unique only within its conversation's run). */
const handoffKey = (h: { conversationId: string; callId: string }) =>
  `${h.conversationId}\u0000${h.callId}`;

/**
 * A viewer's pointer position inside the current viewport (whatever the panel's rounding), or
 * null.
 */
function point(
  m: { x?: unknown; y?: unknown } | null | undefined,
  vp: { width: number; height: number } = VIEWPORT,
): { x: number; y: number } | null {
  const x = Number(m?.x);
  const y = Number(m?.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return {
    x: Math.max(0, Math.min(vp.width - 1, x)),
    y: Math.max(0, Math.min(vp.height - 1, y)),
  };
}
