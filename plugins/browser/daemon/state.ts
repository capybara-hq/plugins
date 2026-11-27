// Takeover and lifetime state of the daemon (spec §10): the one place every tool call and every
// viewer stream of the device reaches, so it alone decides who controls the browser. It also keeps
// what the daemon knows per conversation (tab ownership spec §4–§6): requests in flight, the last
// activity, viewer pins, parks (a pending handoff is one), the hand back note and the idle close.
// Timers are allowed here: the daemon runs inside the device, not in the kernel.

import {
  CONVERSATION_IDLE_MS,
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

/**
 * A park: the conversation waits without a model turn on the browser (spec §6). A pending handoff
 * is the kind `handoff`; a parked long wait (plugins#207) or a held decision dialog (plugins#208)
 * use their own kinds. A park without `tabId` makes the conversation in use (adopt refused, never
 * evicted, never idle closed); a park with `tabId` pins only that tab (adopt, eviction and the idle
 * close skip it; the conversation's other tabs idle as usual). Every park keeps an otherwise idle
 * daemon running under HANDOFF_KEEPALIVE_MS, counted from the oldest. `persist`: saved in the
 * session file and restored (only conversation parks: a tab's id does not survive a restart).
 */
export interface ParkSpec {
  kind: string;
  /** Distinguishes parks of one kind in one conversation (a watch id, a dialog id). */
  key: string;
  tabId?: string;
  persist?: boolean;
}

export interface Park extends ParkSpec {
  /** When the park began. */
  since: number;
}

/** A pending handoff as the daemon keeps it. */
export interface PendingHandoff {
  conversationId: string;
  rootConversationId: string;
  callId: string;
  message: string;
  /** When its first notice arrived. */
  since: number;
}

/** The park kind of a pending handoff (key {@link HANDOFF_PARK_KEY}: one per conversation). */
export const HANDOFF_PARK = "handoff";
const HANDOFF_PARK_KEY = "";

interface ConversationEntry {
  root: string;
  /** Requests in flight, from arrival to reply (queued and `wait` included). */
  inflight: number;
  /** The last request arrival or reply, viewer unpin or ownership gained. */
  lastActiveAt: number;
  /** Viewers pinning the conversation (its own viewers, and those showing one of its tabs). */
  pins: number;
  parks: Map<string, Park>;
  handoff: { callId: string; message: string } | undefined;
  idleTimer: unknown;
}

export interface DaemonStateOptions {
  clock?: Clock;
  idleMs?: number;
  graceMs?: number;
  /** A conversation idle for this long has its tabs closed (default CONVERSATION_IDLE_MS). */
  conversationIdleMs?: number;
  /** Called once the daemon has had no request and no viewer for `idleMs`. */
  onIdle: () => void;
  /**
   * Called when a conversation has had no request, no pinning viewer and no conversation park for
   * `conversationIdleMs`: close its tabs (except those a tab park pins). Its state here is deleted
   * right after (kept only while a tab park remains).
   */
  onConversationIdle?: (conversationId: string) => void;
}

const parkId = (kind: string, key: string) => `${kind}\u0000${key}`;

export class DaemonState {
  private readonly clock: Clock;
  private readonly idleMs: number;
  private readonly graceMs: number;
  private readonly conversationIdleMs: number;
  private readonly onIdle: () => void;
  private readonly onConversationIdle: (conversationId: string) => void;
  private readonly listeners = new Set<() => void>();
  private readonly conversations = new Map<string, ConversationEntry>();
  private viewers = 0;
  private inflight = 0;
  private since: number | undefined;
  /** Conversations the running takeover concerns (told on their next ok reply after it ends). */
  private concerned = new Set<string>();
  /** Hand back notes not yet told: conversation id to when the takeover began. */
  private readonly notes = new Map<string, number>();
  private idleTimer: unknown;
  private graceTimer: unknown;
  private disposed = false;

  constructor(opts: DaemonStateOptions) {
    this.clock = opts.clock ?? systemClock;
    this.idleMs = opts.idleMs ?? IDLE_STOP_MS;
    this.graceMs = opts.graceMs ?? TAKEOVER_GRACE_MS;
    this.conversationIdleMs = opts.conversationIdleMs ?? CONVERSATION_IDLE_MS;
    this.onIdle = opts.onIdle;
    this.onConversationIdle = opts.onConversationIdle ?? (() => undefined);
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

  /** Subscribes to control, handoff and park changes; returns the unsubscribe function. */
  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  // ---- conversations

  /** The conversations the daemon keeps state for (tests, the session file). */
  get conversationIds(): string[] {
    return [...this.conversations.keys()];
  }

  /** Whether the daemon keeps state for the conversation. */
  known(conversationId: string): boolean {
    return this.conversations.has(conversationId);
  }

  /** The root of a conversation's tree, when the daemon knows the conversation. */
  rootOf(conversationId: string): string | undefined {
    return this.conversations.get(conversationId)?.root;
  }

  private entry(conversationId: string, root: string): ConversationEntry {
    let e = this.conversations.get(conversationId);
    if (e === undefined) {
      e = {
        root,
        inflight: 0,
        lastActiveAt: this.clock.now(),
        pins: 0,
        parks: new Map(),
        handoff: undefined,
        idleTimer: undefined,
      };
      this.conversations.set(conversationId, e);
    }
    return e;
  }

  /**
   * Records activity of a conversation that is not a request (it gained a tab: a restore, an
   * adopt, a tab the person opened): its idle countdowns start again.
   */
  seen(conversationId: string, root: string): void {
    const e = this.entry(conversationId, root);
    e.lastActiveAt = this.clock.now();
    this.armConversation(conversationId, e);
  }

  /** A request of the conversation arrived (it is in use until {@link requestFinished}). */
  requestArrived(conversationId: string, root: string): void {
    const e = this.entry(conversationId, root);
    e.inflight++;
    e.lastActiveAt = this.clock.now();
    this.armConversation(conversationId, e);
  }

  /** The conversation's request got its reply. */
  requestFinished(conversationId: string): void {
    const e = this.conversations.get(conversationId);
    if (e === undefined) return;
    e.inflight = Math.max(0, e.inflight - 1);
    e.lastActiveAt = this.clock.now();
    this.armConversation(conversationId, e);
  }

  /** A viewer pins the conversation (its own, or the owner of the tab it shows). */
  pin(conversationId: string, root: string): void {
    const e = this.entry(conversationId, root);
    e.pins++;
    this.armConversation(conversationId, e);
  }

  unpin(conversationId: string): void {
    const e = this.conversations.get(conversationId);
    if (e === undefined) return;
    e.pins = Math.max(0, e.pins - 1);
    e.lastActiveAt = this.clock.now();
    this.armConversation(conversationId, e);
  }

  /**
   * Whether the conversation is in use: a request in flight or a conversation park. Adopt of its
   * tabs is refused meanwhile, and the cap eviction skips it.
   */
  busy(conversationId: string): boolean {
    const e = this.conversations.get(conversationId);
    if (e === undefined) return false;
    if (e.inflight > 0) return true;
    for (const p of e.parks.values()) if (p.tabId === undefined) return true;
    return false;
  }

  /** Whether a viewer pins the conversation. */
  pinned(conversationId: string): boolean {
    return (this.conversations.get(conversationId)?.pins ?? 0) > 0;
  }

  /** How long the conversation has been without activity (unknown: forever). */
  idleFor(conversationId: string): number {
    const e = this.conversations.get(conversationId);
    return e === undefined ? Number.POSITIVE_INFINITY : this.clock.now() - e.lastActiveAt;
  }

  /** The last activity of the conversation (unknown: never). */
  lastActiveAt(conversationId: string): number {
    return this.conversations.get(conversationId)?.lastActiveAt ?? Number.NEGATIVE_INFINITY;
  }

  // ---- parks

  /** Starts (or renews the spec of) a park; a park of the same kind and key keeps its start. */
  park(conversationId: string, root: string, spec: ParkSpec): void {
    const e = this.entry(conversationId, root);
    const id = parkId(spec.kind, spec.key);
    const since = e.parks.get(id)?.since ?? this.clock.now();
    e.parks.set(id, { ...spec, since });
    this.armConversation(conversationId, e);
    this.armIdle();
    this.emit();
  }

  /** Ends a park; an unknown one changes nothing. */
  unpark(conversationId: string, kind: string, key: string): void {
    const e = this.conversations.get(conversationId);
    if (e === undefined || !e.parks.delete(parkId(kind, key))) return;
    e.lastActiveAt = this.clock.now();
    this.armConversation(conversationId, e);
    this.armIdle();
    this.emit();
  }

  /** The conversation's parks. */
  parksOf(conversationId: string): Park[] {
    return [...(this.conversations.get(conversationId)?.parks.values() ?? [])];
  }

  /** Whether a tab park pins the tab. */
  tabParked(tabId: string): boolean {
    for (const e of this.conversations.values())
      for (const p of e.parks.values()) if (p.tabId === tabId) return true;
    return false;
  }

  /** Drops the tab parks of a tab that closed. */
  tabClosed(tabId: string): void {
    for (const [conv, e] of this.conversations) {
      let changed = false;
      for (const [id, p] of e.parks) if (p.tabId === tabId) changed = e.parks.delete(id) || changed;
      if (changed) this.armConversation(conv, e);
    }
    this.armIdle();
  }

  // ---- handoffs (a park of kind HANDOFF_PARK)

  /** The tree's or every pending handoff, oldest first. */
  handoffs(root?: string): PendingHandoff[] {
    const out: PendingHandoff[] = [];
    for (const [conversationId, e] of this.conversations) {
      if (e.handoff === undefined || (root !== undefined && e.root !== root)) continue;
      const since = e.parks.get(parkId(HANDOFF_PARK, HANDOFF_PARK_KEY))?.since ?? 0;
      out.push({ conversationId, rootConversationId: e.root, ...e.handoff, since });
    }
    return out.sort((a, b) => a.since - b.since);
  }

  /** The conversation's pending handoff, if any. */
  handoffOf(conversationId: string): { callId: string; message: string } | undefined {
    return this.conversations.get(conversationId)?.handoff;
  }

  /** Records the conversation's handoff question; it replaces an earlier one of the conversation. */
  noticeHandoff(conversationId: string, root: string, callId: string, message: string): void {
    const m =
      message.length <= HANDOFF_MAX_CHARS ? message : `${message.slice(0, HANDOFF_MAX_CHARS - 1)}…`;
    const e = this.entry(conversationId, root);
    e.handoff = { callId, message: m };
    this.park(conversationId, root, { kind: HANDOFF_PARK, key: HANDOFF_PARK_KEY, persist: true });
    this.emit();
  }

  /** Clears the conversation's pending handoff when it is `callId`'s; a stale clear changes nothing. */
  clearHandoff(conversationId: string, callId: string): void {
    if (this.conversations.get(conversationId)?.handoff?.callId !== callId) return;
    this.endHandoff(conversationId);
  }

  /**
   * Drops the conversation's pending handoff whatever its callId: the conversation's next tool
   * request means its run moved on (an aborted run never sends handoff_clear). Other
   * conversations' handoffs stay.
   */
  dropHandoff(conversationId: string): void {
    if (this.conversations.get(conversationId)?.handoff === undefined) return;
    this.endHandoff(conversationId);
  }

  private endHandoff(conversationId: string): void {
    const e = this.conversations.get(conversationId);
    if (e === undefined) return;
    e.handoff = undefined;
    this.unpark(conversationId, HANDOFF_PARK, HANDOFF_PARK_KEY);
    this.emit();
  }

  // ---- deleted conversations

  /**
   * Forgets a deleted conversation and every conversation whose tree root it is (the kernel's
   * conversation-deleted notice): their requests' counts, pins, parks (tab parks included),
   * handoffs, hand back notes and idle countdowns, as the idle close does and more (a deleted
   * conversation keeps no park). Returns the conversations it forgot.
   */
  forgetTree(conversationId: string): string[] {
    const gone: string[] = [];
    for (const [id, e] of this.conversations) {
      if (id !== conversationId && e.root !== conversationId) continue;
      if (e.idleTimer !== undefined) this.clock.cancel(e.idleTimer);
      e.idleTimer = undefined;
      gone.push(id);
    }
    for (const id of [conversationId, ...gone]) {
      this.conversations.delete(id);
      this.notes.delete(id);
      this.concerned.delete(id);
    }
    if (gone.length > 0) {
      this.armIdle();
      this.emit();
    }
    return gone;
  }

  // ---- takeover

  /**
   * The person takes control of the browser (every conversation's agent is refused meanwhile).
   * `owners`: the conversations owning a tab now, told on hand back.
   */
  takeover(owners: Iterable<string> = []): void {
    if (this.since !== undefined) return;
    this.since = this.clock.now();
    this.concerned = new Set(owners);
    this.emit();
  }

  /** The person used a tab of `conversationId` during the takeover: it is told on hand back. */
  concern(conversationId: string | undefined): void {
    if (this.since === undefined || conversationId === undefined) return;
    this.concerned.add(conversationId);
  }

  handback(): void {
    if (this.since === undefined) return;
    for (const c of this.concerned) this.notes.set(c, this.since);
    this.concerned = new Set();
    this.since = undefined;
    this.clearGrace();
    this.emit();
  }

  /**
   * When the last takeover that concerned the conversation began (ISO), once: its first ok reply
   * after the hand back carries it so its agent learns the person drove the browser.
   */
  takeHandbackNote(conversationId: string): string | undefined {
    const n = this.notes.get(conversationId);
    this.notes.delete(conversationId);
    return n === undefined ? undefined : new Date(n).toISOString();
  }

  // ---- viewers and requests (the daemon's own idle stop)

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
    for (const e of this.conversations.values()) {
      if (e.idleTimer !== undefined) this.clock.cancel(e.idleTimer);
      e.idleTimer = undefined;
    }
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
   * (Re)starts the conversation's idle countdown when it is not in use (no request in flight, no
   * viewer pin, no conversation park); stops it otherwise.
   */
  private armConversation(conversationId: string, e: ConversationEntry): void {
    if (e.idleTimer !== undefined) this.clock.cancel(e.idleTimer);
    e.idleTimer = undefined;
    if (this.disposed || e.pins > 0 || this.busy(conversationId)) return;
    const wait = Math.max(0, e.lastActiveAt + this.conversationIdleMs - this.clock.now());
    e.idleTimer = this.clock.schedule(() => {
      e.idleTimer = undefined;
      this.idleClose(conversationId, e);
    }, wait);
  }

  /** Closes an idle conversation's tabs and deletes what the daemon keeps for it. */
  private idleClose(conversationId: string, e: ConversationEntry): void {
    if (this.conversations.get(conversationId) !== e) return;
    try {
      this.onConversationIdle(conversationId);
    } finally {
      this.notes.delete(conversationId);
      this.concerned.delete(conversationId);
      // a tab park keeps its tab: the conversation stays known (its countdown starts again when
      // the park ends or the conversation is active)
      if (e.parks.size === 0) this.conversations.delete(conversationId);
    }
  }

  /** When the oldest pending park began, if any. */
  private oldestPark(): number | undefined {
    let oldest: number | undefined;
    for (const e of this.conversations.values())
      for (const p of e.parks.values())
        if (oldest === undefined || p.since < oldest) oldest = p.since;
    return oldest;
  }

  /**
   * (Re)starts the idle countdown when nothing is in use; stops it otherwise. Pending parks keep
   * the daemon running until {@link HANDOFF_KEEPALIVE_MS} after the oldest one began (the person
   * is still to answer a handoff); the device's idle suspension may still stop the device sooner.
   */
  private armIdle(): void {
    if (this.idleTimer !== undefined) this.clock.cancel(this.idleTimer);
    this.idleTimer = undefined;
    if (this.disposed || this.viewers > 0 || this.inflight > 0) return;
    const oldest = this.oldestPark();
    const keepalive = oldest === undefined ? 0 : oldest + HANDOFF_KEEPALIVE_MS - this.clock.now();
    this.idleTimer = this.clock.schedule(
      () => {
        this.idleTimer = undefined;
        this.onIdle();
      },
      Math.max(this.idleMs, keepalive),
    );
  }
}
