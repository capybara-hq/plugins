// One viewer stream (spec §8): the active tab's screencast at the viewer's size, paced by its
// acks (viewer-pacing.ts: frames kept small and few enough that input never waits long behind
// them) and capped in rate and message size; its input, address bar and tab actions, applied only
// while the person holds control (the watch state is read-only); the page's cursor under the
// pointer; takeover and hand back; and every state change, blocked host and dialog. A new viewer
// gets the full state at once (the panel remounts on expand and collapse, so the daemon is the
// source of truth).

import type { CDPSession, Page } from "playwright-core";
import {
  type BrowserSession,
  captureFitting,
  clip,
  jpegSize,
  type SessionEvent,
} from "./actions.js";
import { CursorResolver } from "./cursor.js";
import {
  clipCodePoints,
  encodeFrame,
  FRAME_HEADER_BYTES,
  VIEWER_MAX_FPS,
  VIEWER_TEXT_MAX_CHARS,
  VIEWER_UNACKED_FRAMES,
  VIEWPORT,
  type ViewerCursor,
  type ViewerIn,
  type ViewerOut,
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

  constructor(opts: {
    browser: BrowserSession;
    state: DaemonState;
    transport: ViewerTransport;
    clock: Clock;
    frameMaxBytes: number;
  }) {
    this.browser = opts.browser;
    this.state = opts.state;
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
      this.sendState();
      void this.serial(() => this.attach());
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
        this.state.takeover();
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
        this.input(() =>
          this.browser.viewerNav({
            ...(typeof m.url === "string" ? { url: m.url } : {}),
            ...(m.action === undefined ? {} : { action: m.action }),
          }),
        );
        return;
      case "tab":
        this.input(async () => {
          try {
            if (m.action === "open") await this.browser.openTab();
            else if (m.action === "switch" && m.tabId !== undefined)
              await this.browser.switchTo(m.tabId);
            else if (m.action === "close" && m.tabId !== undefined) {
              await this.browser.tabById(m.tabId).close();
              await this.browser.activePage();
            }
          } catch {
            // a stale tab id: the next state message shows the real tabs
          }
        });
        return;
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
    const p = point(m);
    if (p === null) return;
    if (this.moveSlot !== undefined) {
      this.moveSlot.x = p.x;
      this.moveSlot.y = p.y;
      return;
    }
    const slot = { ...p };
    this.input(async () => {
      if (this.moveSlot === slot) this.moveSlot = undefined;
      const page = await this.browser.activePage();
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

  /** Ends the viewer: stops its screencast and its subscriptions. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.inputGen++;
    await this.releaseHeld();
    for (const u of this.unsubscribe.splice(0)) u();
    for (const t of [this.pumpTimer, this.pingTimer, this.encodeTimer])
      if (t !== undefined) this.clock.cancel(t);
    await this.serial(() => this.detach());
  }

  private setSize(w: unknown, h: unknown): void {
    this.maxWidth = clampDim(w, VIEWPORT.width);
    this.maxHeight = clampDim(h, VIEWPORT.height);
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

  /** Control changed (takeover, hand back): a new state, and input of the old control dropped. */
  private onControl(): void {
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
      const handoff =
        m.handoff === undefined
          ? {}
          : { handoff: { ...m.handoff, message: clip(m.handoff.message, 200) } };
      small = {
        ...m,
        tabs: m.tabs.map((t) => ({ ...t, title: clip(t.title, 200), url: clip(t.url, 200) })),
        ...handoff,
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
      this.queueState();
      void this.serial(async () => {
        const page = await this.browser.activePage();
        if (page === this.page) return;
        await this.detach();
        await this.attach();
      });
    } else if (e.type === "blocked") this.send({ t: "blocked", host: e.host, url: e.url });
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

  private sendState(): void {
    const tabs = this.browser.tabs();
    const active = tabs.find((t) => t.active);
    const last = this.browser.lastClick;
    this.send({
      t: "state",
      tabs,
      loading: this.browser.loading,
      secure: active?.url.startsWith("https:") ?? false,
      control: this.state.control,
      ...(last === undefined ? {} : { lastClick: last }),
      ...(this.state.handoff === undefined ? {} : { handoff: this.state.handoff }),
    });
  }

  private get scale(): number {
    return (
      Math.min(1, this.maxWidth / VIEWPORT.width, this.maxHeight / VIEWPORT.height) *
      this.frameQuality.shrink
    );
  }

  /** Room for the JPEG in one frame message. */
  private get jpegBudget(): number {
    return this.frameMaxBytes - FRAME_HEADER_BYTES;
  }

  private async attach(): Promise<void> {
    if (this.closed) return;
    const page = await this.browser.activePage();
    const cdp = await this.browser.context.newCDPSession(page);
    this.page = page;
    this.cdp = cdp;
    cdp.on("Page.screencastFrame", (f: ScreencastFrame) => this.onFrame(cdp, f));
    this.cursorResolver = new CursorResolver(this.browser.context, page, cdp);
    // Screencast is silent on a static page: the first frame is a screenshot.
    const first = await captureFitting(cdp, {
      maxBytes: this.jpegBudget,
      maxScale: this.scale,
    }).catch(() => null);
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
      maxWidth: Math.max(16, Math.floor(VIEWPORT.width * this.scale)),
      maxHeight: Math.max(16, Math.floor(VIEWPORT.height * this.scale)),
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
    const page = await this.browser.activePage();
    const p = point(m);
    if (p === null) return;
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
    const page = await this.browser.activePage();
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

/** A viewer's pointer position inside the viewport (whatever the panel's rounding), or null. */
function point(m: { x: unknown; y: unknown }): { x: number; y: number } | null {
  const x = Number(m.x);
  const y = Number(m.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return {
    x: Math.max(0, Math.min(VIEWPORT.width - 1, x)),
    y: Math.max(0, Math.min(VIEWPORT.height - 1, y)),
  };
}
