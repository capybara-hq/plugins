// One viewer stream (spec §8): the active tab's screencast at the viewer's size, paced by its
// acks and capped in rate and message size; its input, address bar and tab actions; takeover and
// hand back; and every state change, blocked host and dialog. A new viewer gets the full state at
// once (the panel remounts on expand and collapse, so the daemon is the source of truth).

import type { CDPSession, Page } from "playwright-core";
import {
  type BrowserSession,
  captureFitting,
  clip,
  jpegSize,
  type SessionEvent,
} from "./actions.js";
import {
  VIEWER_MAX_FPS,
  VIEWER_UNACKED_FRAMES,
  VIEWPORT,
  type ViewerIn,
  type ViewerOut,
} from "./protocol.js";
import type { Clock, DaemonState } from "./state.js";

/** Where a viewer's messages go: `send` returns false while the transport is backed up. */
export interface ViewerTransport {
  send(m: ViewerOut): boolean;
  whenDrained(): Promise<void>;
}

/** Room for the frame message's JSON around the base64 JPEG. */
const FRAME_JSON_OVERHEAD = 128;
const START_QUALITY = 60;
const MIN_QUALITY = 20;

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
  /** Lowered when a frame does not fit the message cap. */
  private quality = START_QUALITY;
  private shrink = 1;
  private started = false;
  private closed = false;
  private page: Page | undefined;
  private cdp: CDPSession | undefined;
  /** Serializes attach / detach / restart. */
  private chain: Promise<unknown> = Promise.resolve();
  private inputChain: Promise<void> = Promise.resolve();
  /** Bumped on close and hand back: input queued before it is dropped, not replayed. */
  private inputGen = 0;
  private seq = 0;
  private acked = 0;
  private lastSentAt = 0;
  private pendingAck: { cdp: CDPSession; sessionId: number } | undefined;
  private pumpTimer: unknown;
  private draining = false;
  private stateQueued = false;

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
      this.unsubscribe.push(
        this.browser.on((e) => this.onSession(e)),
        this.state.onChange(() => this.queueState()),
      );
      this.sendState();
      void this.serial(() => this.attach());
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
        if (typeof m.seq === "number" && m.seq > this.acked) this.acked = Math.min(m.seq, this.seq);
        this.pump();
        return;
      case "takeover":
        this.state.takeover();
        return;
      case "handback":
        this.inputGen++;
        this.state.handback();
        return;
      case "mouse":
        this.input(() => this.mouse(m));
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

  /** Runs viewer input in arrival order, apart from the screencast chain. */
  private input(fn: () => Promise<void>): void {
    const gen = this.inputGen;
    const guarded = () => (gen === this.inputGen && !this.closed ? fn() : Promise.resolve());
    const run = this.inputChain.then(guarded, guarded);
    this.inputChain = run.catch(() => undefined);
  }

  /** Ends the viewer: stops its screencast and its subscriptions. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.inputGen++;
    for (const u of this.unsubscribe.splice(0)) u();
    if (this.pumpTimer !== undefined) this.clock.cancel(this.pumpTimer);
    await this.serial(() => this.detach());
  }

  private setSize(w: unknown, h: unknown): void {
    this.maxWidth = clampDim(w, VIEWPORT.width);
    this.maxHeight = clampDim(h, VIEWPORT.height);
    this.shrink = 1;
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
    if (m.t === "frame" || fits(m)) return m;
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
    } else {
      small = { ...m, url: clip(m.url, 200) };
    }
    return fits(small) ? small : null;
  }

  private send(raw: ViewerOut): void {
    if (this.closed) return;
    const m = this.fitted(raw);
    if (m === null) return;
    if (!this.out.send(m) && !this.draining) {
      this.draining = true;
      this.out.whenDrained().then(() => {
        this.draining = false;
        this.pump();
      });
    }
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
      Math.min(1, this.maxWidth / VIEWPORT.width, this.maxHeight / VIEWPORT.height) * this.shrink
    );
  }

  /** Room for the JPEG's decoded bytes in one frame message. */
  private get jpegBudget(): number {
    return Math.floor(((this.frameMaxBytes - FRAME_JSON_OVERHEAD) * 3) / 4);
  }

  private async attach(): Promise<void> {
    if (this.closed) return;
    const page = await this.browser.activePage();
    const cdp = await this.browser.context.newCDPSession(page);
    this.page = page;
    this.cdp = cdp;
    cdp.on("Page.screencastFrame", (f: ScreencastFrame) => this.onFrame(cdp, f));
    // Screencast is silent on a static page: the first frame is a screenshot.
    const first = await captureFitting(cdp, {
      maxBytes: this.jpegBudget,
      maxScale: this.scale,
    }).catch(() => null);
    if (first !== null && this.cdp === cdp) {
      this.sendFrame(first.data, first.width, first.height);
    }
    await this.startScreencast(cdp);
  }

  private async startScreencast(cdp: CDPSession): Promise<void> {
    if (this.closed || this.cdp !== cdp) return;
    await cdp.send("Page.startScreencast", {
      format: "jpeg",
      quality: this.quality,
      maxWidth: Math.max(16, Math.floor(VIEWPORT.width * this.scale)),
      maxHeight: Math.max(16, Math.floor(VIEWPORT.height * this.scale)),
      everyNthFrame: 1,
    });
  }

  private async detach(): Promise<void> {
    const cdp = this.cdp;
    this.cdp = undefined;
    this.page = undefined;
    this.pendingAck = undefined;
    if (cdp === undefined) return;
    await cdp.send("Page.stopScreencast").catch(() => undefined);
    await cdp.detach().catch(() => undefined);
  }

  private sendFrame(jpeg: string, width: number, height: number): void {
    this.seq++;
    this.lastSentAt = this.clock.now();
    this.send({ t: "frame", seq: this.seq, jpeg, width, height });
  }

  private onFrame(cdp: CDPSession, f: ScreencastFrame): void {
    if (this.closed || this.cdp !== cdp) return;
    const bytes = Buffer.from(f.data, "base64");
    if (bytes.length > this.jpegBudget) {
      // Too big for one message: drop it and continue smaller.
      cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => undefined);
      if (this.quality > MIN_QUALITY) this.quality = Math.max(MIN_QUALITY, this.quality - 15);
      else this.shrink *= 0.75;
      void this.serial(async () => {
        if (this.cdp !== cdp) return;
        await cdp.send("Page.stopScreencast").catch(() => undefined);
        await this.startScreencast(cdp);
      });
      return;
    }
    const { width, height } = jpegSize(bytes);
    this.sendFrame(f.data, width, height);
    this.pendingAck = { cdp, sessionId: f.sessionId };
    this.pump();
  }

  /**
   * Acks the held screencast frame (letting Chromium send the next) once the viewer has room for
   * it, the transport is not backed up and the rate cap allows.
   */
  private pump(): void {
    const pending = this.pendingAck;
    if (pending === undefined || this.closed || this.draining) return;
    if (this.seq - this.acked >= VIEWER_UNACKED_FRAMES) return;
    const wait = this.lastSentAt + 1000 / VIEWER_MAX_FPS - this.clock.now();
    if (wait > 0) {
      if (this.pumpTimer === undefined) {
        this.pumpTimer = this.clock.schedule(() => {
          this.pumpTimer = undefined;
          this.pump();
        }, wait);
      }
      return;
    }
    this.pendingAck = undefined;
    pending.cdp
      .send("Page.screencastFrameAck", { sessionId: pending.sessionId })
      .catch(() => undefined);
  }

  private async mouse(m: Extract<ViewerIn, { t: "mouse" }>): Promise<void> {
    const page = await this.browser.activePage();
    if (!Number.isFinite(Number(m.x)) || !Number.isFinite(Number(m.y))) return;
    // inside the viewport, whatever the panel's rounding
    const x = Math.max(0, Math.min(VIEWPORT.width - 1, Number(m.x)));
    const y = Math.max(0, Math.min(VIEWPORT.height - 1, Number(m.y)));
    const button = m.button === "right" ? "right" : "left";
    try {
      if (m.kind === "move") await page.mouse.move(x, y);
      else if (m.kind === "down") {
        await page.mouse.move(x, y);
        await page.mouse.down({ button });
      } else if (m.kind === "up") {
        await page.mouse.move(x, y);
        await page.mouse.up({ button });
      } else if (m.kind === "wheel") {
        await page.mouse.move(x, y);
        await page.mouse.wheel(Number(m.dx) || 0, Number(m.dy) || 0);
      }
    } catch {
      // the page navigated or closed under the pointer
    }
  }

  private async key(m: Extract<ViewerIn, { t: "key" }>): Promise<void> {
    const page = await this.browser.activePage();
    try {
      if (m.kind === "char") {
        const text = m.text ?? m.key;
        if (typeof text === "string" && text !== "") await page.keyboard.insertText(text);
      } else if (m.kind === "down") await page.keyboard.down(m.key);
      else if (m.kind === "up") await page.keyboard.up(m.key);
    } catch {
      // a key Playwright does not know (IME process keys, media keys): ignored
    }
  }
}
