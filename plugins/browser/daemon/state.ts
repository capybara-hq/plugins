// Takeover and lifetime state of the daemon (spec §10): the one place every tool call and every
// viewer stream of the device reaches, so it alone decides who controls the browser. Timers are
// allowed here: the daemon runs inside the device, not in the kernel.

import {
  HANDOFF_KEEPALIVE_MS,
  HANDOFF_MAX_CHARS,
  IDLE_STOP_MS,
  TAKEOVER_GRACE_MS,
} from "./protocol.js";

/** Time source and timers (injected in tests). */
export interface Clock {
  now(): number;
  /** Runs `fn` once after `ms`; returns a handle for `cancel`. */
  schedule(fn: () => void, ms: number): unknown;
  cancel(handle: unknown): void;
}

/**
 * The real clock: the daemon's only timer source. It runs in the device's service process, not in
 * the kernel or an extension (spec §10: the daemon keeps its own timers), so `capybara-plugin
 * check`'s plugin-timer rule, written for extension code, reports this one line by design.
 */
export const systemClock: Clock = {
  now: () => Date.now(),
  schedule: (fn, ms) => setTimeout(fn, ms).unref(),
  cancel: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export interface DaemonStateOptions {
  clock?: Clock;
  idleMs?: number;
  graceMs?: number;
  /** Called once the daemon has had no request and no viewer for `idleMs`. */
  onIdle: () => void;
}

export class DaemonState {
  private readonly clock: Clock;
  private readonly idleMs: number;
  private readonly graceMs: number;
  private readonly onIdle: () => void;
  private readonly listeners = new Set<() => void>();
  private viewers = 0;
  private inflight = 0;
  private since: number | undefined;
  private note: number | undefined;
  private idleTimer: unknown;
  private graceTimer: unknown;
  private disposed = false;
  private pendingHandoff: { callId: string; message: string } | undefined;
  /** When the first notice of the pending handoff arrived (the keepalive counts from it). */
  private handoffSince: number | undefined;

  constructor(opts: DaemonStateOptions) {
    this.clock = opts.clock ?? systemClock;
    this.idleMs = opts.idleMs ?? IDLE_STOP_MS;
    this.graceMs = opts.graceMs ?? TAKEOVER_GRACE_MS;
    this.onIdle = opts.onIdle;
    this.armIdle();
  }

  get control(): "agent" | "user" {
    return this.since === undefined ? "agent" : "user";
  }

  /** When the person took control (ISO), while they hold it. */
  get userControlledSince(): string | undefined {
    return this.since === undefined ? undefined : new Date(this.since).toISOString();
  }

  get viewerCount(): number {
    return this.viewers;
  }

  get requestsInFlight(): number {
    return this.inflight;
  }

  /** Subscribes to control changes; returns the unsubscribe function. */
  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** The pending handoff question (the latest notice), if any. */
  get handoff(): { callId: string; message: string } | undefined {
    return this.pendingHandoff;
  }

  /** Records a handoff question; it replaces any earlier one. */
  noticeHandoff(callId: string, message: string): void {
    const m =
      message.length <= HANDOFF_MAX_CHARS ? message : `${message.slice(0, HANDOFF_MAX_CHARS - 1)}…`;
    this.pendingHandoff = { callId, message: m };
    this.handoffSince ??= this.clock.now();
    this.emit();
    this.armIdle();
  }

  /** Clears the pending handoff when it is `callId`'s; a stale clear changes nothing. */
  clearHandoff(callId: string): void {
    if (this.pendingHandoff?.callId !== callId) return;
    this.endHandoff();
  }

  /**
   * Drops the pending handoff whatever its callId: the next agent tool request means its run has
   * moved on (an aborted run never sends handoff_clear). This is device-wide on purpose: a tool
   * call from any conversation of the device drops it, since they are all the owner's
   * conversations and the browser is one.
   */
  dropHandoff(): void {
    if (this.pendingHandoff === undefined) return;
    this.endHandoff();
  }

  private endHandoff(): void {
    this.pendingHandoff = undefined;
    this.handoffSince = undefined;
    this.emit();
    this.armIdle();
  }

  takeover(): void {
    if (this.since !== undefined) return;
    this.since = this.clock.now();
    this.note = undefined;
    this.emit();
  }

  handback(): void {
    if (this.since === undefined) return;
    this.note = this.since;
    this.since = undefined;
    this.clearGrace();
    this.emit();
  }

  /**
   * When the last takeover began (ISO), once: the first tool reply after a hand back carries it so
   * the agent learns the person drove the browser.
   */
  takeHandbackNote(): string | undefined {
    const n = this.note;
    this.note = undefined;
    return n === undefined ? undefined : new Date(n).toISOString();
  }

  viewerOpened(): void {
    this.viewers++;
    this.clearGrace();
    this.armIdle();
  }

  viewerClosed(): void {
    this.viewers = Math.max(0, this.viewers - 1);
    if (this.viewers === 0 && this.since !== undefined) {
      this.clearGrace();
      this.graceTimer = this.clock.schedule(() => {
        this.graceTimer = undefined;
        this.handback();
      }, this.graceMs);
    }
    this.armIdle();
  }

  requestStarted(): void {
    this.inflight++;
    this.armIdle();
  }

  requestEnded(): void {
    this.inflight = Math.max(0, this.inflight - 1);
    this.armIdle();
  }

  dispose(): void {
    this.disposed = true;
    this.clearGrace();
    if (this.idleTimer !== undefined) this.clock.cancel(this.idleTimer);
    this.idleTimer = undefined;
    this.listeners.clear();
  }

  private emit(): void {
    for (const fn of [...this.listeners]) fn();
  }

  private clearGrace(): void {
    if (this.graceTimer !== undefined) this.clock.cancel(this.graceTimer);
    this.graceTimer = undefined;
  }

  /**
   * (Re)starts the idle countdown when nothing is in use; stops it otherwise. A pending handoff
   * keeps the daemon running until {@link HANDOFF_KEEPALIVE_MS} after its notice (the person is
   * still to answer it); the device's idle suspension may still stop the device sooner.
   */
  private armIdle(): void {
    if (this.idleTimer !== undefined) this.clock.cancel(this.idleTimer);
    this.idleTimer = undefined;
    if (this.disposed || this.viewers > 0 || this.inflight > 0) return;
    const keepalive =
      this.handoffSince === undefined
        ? 0
        : this.handoffSince + HANDOFF_KEEPALIVE_MS - this.clock.now();
    this.idleTimer = this.clock.schedule(
      () => {
        this.idleTimer = undefined;
        this.onIdle();
      },
      Math.max(this.idleMs, keepalive),
    );
  }
}
