// Long waits in the daemon (browser long waits spec §6.2): a parked browser_wait arms a watch on
// its conversation's active tab; the watch evaluates its condition every WATCH_CHECK_MS and
// latches the first outcome (met, or ended by a dialog, the tab closing or the deadline). The
// kernel learns it by polling (each poll is the watch's heartbeat: WATCH_HEARTBEAT_MS without one
// drops the watch). A pending watch is its conversation's park (tab ownership spec §6). Timers are
// allowed here: the daemon runs inside the device.

import type { Page } from "playwright-core";
import {
  MAX_WATCHES,
  WAIT_CONDITION_MAX_CHARS,
  WATCH_HEARTBEAT_MS,
  type WaitCondition,
  type WatchState,
} from "./protocol.js";
import type { Clock } from "./state.js";

/** How often a pending watch looks at its condition. */
export const WATCH_CHECK_MS = 500;
/** The park kind of a pending watch (key: its watch id). */
export const WATCH_PARK = "watch";

/** Where a watch's park goes (DaemonState). */
export interface WatchParks {
  park(conversationId: string, root: string, spec: { kind: string; key: string }): void;
  unpark(conversationId: string, kind: string, key: string): void;
}

const NO_PARKS: WatchParks = { park: () => undefined, unpark: () => undefined };

interface Watch {
  id: string;
  conv: string;
  root: string;
  tabId: string;
  page: Page;
  condition: WaitCondition;
  /** The device clock's deadline. */
  deadline: number;
  startedAt: number;
  lastPolled: number;
  latched: WatchState | undefined;
  timer: unknown;
  /** Removes the page listeners the watch added. */
  off: () => void;
  /** A navigation was seen since the start (a navigation watch). */
  navigated: boolean;
  /** A check is running (no second one meanwhile). */
  checking: boolean;
}

/** One condition's check on a page now (the session's locators). */
export type ConditionCheck = (page: Page, condition: WaitCondition) => Promise<boolean>;

/** A short human label of a condition (the panel's status line). */
export function conditionLabel(c: WaitCondition): string {
  const cut = (s: string) => (s.length <= 80 ? s : `${s.slice(0, 79)}…`);
  if ("text" in c) return `text ${JSON.stringify(cut(c.text))}`;
  if ("ref" in c) return `element ${c.ref}`;
  if ("urlContains" in c) return `URL containing ${JSON.stringify(cut(c.urlContains))}`;
  if ("navigation" in c) return "the next navigation";
  return "the next download";
}

/** The condition when it is exactly one well-formed one, else a reason it is not. */
export function parseCondition(raw: unknown): WaitCondition | string {
  if (typeof raw !== "object" || raw === null) return "The watch needs a condition.";
  const r = raw as Record<string, unknown>;
  const keys = Object.keys(r).filter((k) => r[k] !== undefined);
  if (keys.length !== 1) return "A watch takes exactly one condition.";
  const str = (v: unknown) =>
    typeof v === "string" && v !== "" && v.length <= WAIT_CONDITION_MAX_CHARS ? v : undefined;
  if (str(r.text) !== undefined) return { text: r.text as string };
  if (str(r.ref) !== undefined) return { ref: r.ref as string };
  if (str(r.urlContains) !== undefined) return { urlContains: r.urlContains as string };
  if (r.navigation === true) return { navigation: true };
  if (r.download === true) return { download: true };
  return "The watch's condition is not valid.";
}

/**
 * The watches of one browser session. Every watch is bound to one tab of its conversation;
 * `dialog`, `downloadSaved` and `tabClosed` are the session's hooks.
 */
export class Watches {
  private readonly watches = new Map<string, Watch>();
  private readonly clock: Clock;
  private readonly parks: WatchParks;
  private readonly check: ConditionCheck;
  private readonly onChange: () => void;
  private disposed = false;

  constructor(opts: {
    clock: Clock;
    check: ConditionCheck;
    parks?: WatchParks;
    /** Called when the set of pending watches changes (viewers' `state.waiting`). */
    onChange?: () => void;
  }) {
    this.clock = opts.clock;
    this.check = opts.check;
    this.parks = opts.parks ?? NO_PARKS;
    this.onChange = opts.onChange ?? (() => undefined);
  }

  /** How many watches the session keeps (tests). */
  get size(): number {
    return this.watches.size;
  }

  /**
   * Arms a watch (idempotent per id: a known one answers its state, renewing its heartbeat).
   * `page` is the conversation's active tab.
   */
  start(opts: {
    id: string;
    conv: string;
    root: string;
    tabId: string;
    page: Page;
    condition: WaitCondition;
    remainingMs: number;
  }): WatchState {
    const known = this.watches.get(opts.id);
    if (known !== undefined) {
      known.lastPolled = this.clock.now();
      return this.stateOf(known);
    }
    if (this.watches.size >= MAX_WATCHES) this.evict();
    const now = this.clock.now();
    const w: Watch = {
      id: opts.id,
      conv: opts.conv,
      root: opts.root,
      tabId: opts.tabId,
      page: opts.page,
      condition: opts.condition,
      deadline: now + Math.max(0, opts.remainingMs),
      startedAt: now,
      lastPolled: now,
      latched: undefined,
      timer: undefined,
      off: () => undefined,
      navigated: false,
      checking: false,
    };
    if ("navigation" in opts.condition) {
      const onNav = (f: unknown) => {
        if (f === opts.page.mainFrame()) w.navigated = true;
      };
      opts.page.on("framenavigated", onNav);
      w.off = () => opts.page.off("framenavigated", onNav);
    }
    this.watches.set(w.id, w);
    this.parks.park(w.conv, w.root, { kind: WATCH_PARK, key: w.id });
    this.onChange();
    this.schedule(w, 0);
    return this.stateOf(w);
  }

  /** The watch's state; a poll is its heartbeat. An unknown id is `unknown`. */
  poll(id: string): WatchState {
    const w = this.watches.get(id);
    if (w === undefined) return { state: "unknown" };
    w.lastPolled = this.clock.now();
    return this.stateOf(w);
  }

  /** The watch's state, then forgets it. */
  end(id: string): WatchState {
    const w = this.watches.get(id);
    if (w === undefined) return { state: "unknown" };
    const st = this.stateOf(w);
    this.drop(w);
    return st;
  }

  /** Whether the watch belongs to the conversation (watch ops of another conversation see none). */
  owns(id: string, conv: string): boolean {
    const w = this.watches.get(id);
    return w === undefined || w.conv === conv;
  }

  /** The newest pending watch of a tree (the panel's status line). */
  waitingOf(root: string): { label: string; until: string } | undefined {
    let newest: Watch | undefined;
    for (const w of this.watches.values())
      if (
        w.root === root &&
        w.latched === undefined &&
        (!newest || w.startedAt >= newest.startedAt)
      )
        newest = w;
    return newest === undefined
      ? undefined
      : {
          label: conditionLabel(newest.condition),
          until: new Date(newest.deadline).toISOString(),
        };
  }

  /**
   * A dialog that holds a decision (confirm, prompt) opened on a tab: its pending watches end
   * with reason `dialog`.
   */
  dialog(tabId: string, message: string): void {
    for (const w of this.watches.values())
      if (w.tabId === tabId && w.latched === undefined)
        this.latch(w, { state: "ended", reason: "dialog", detail: message.slice(0, 500) });
  }

  /** A download of the conversation was saved into the workspace: its download watches are met. */
  downloadSaved(conv: string, path: string): void {
    for (const w of this.watches.values())
      if (w.conv === conv && w.latched === undefined && "download" in w.condition)
        this.latch(w, { state: "met", detail: path });
  }

  /** A tab closed: its pending watches end with reason `tab_closed`. */
  tabClosed(tabId: string): void {
    for (const w of this.watches.values())
      if (w.tabId === tabId && w.latched === undefined)
        this.latch(w, { state: "ended", reason: "tab_closed" });
  }

  /** Ends every watch (the session closes): their parks end, later polls are `unknown`. */
  dispose(): void {
    this.disposed = true;
    for (const w of [...this.watches.values()]) this.drop(w);
  }

  private stateOf(w: Watch): WatchState {
    return w.latched ?? { state: "pending" };
  }

  private latch(w: Watch, st: Omit<WatchState, "at">): void {
    if (w.latched !== undefined) return;
    w.latched = { ...st, at: new Date(this.clock.now()).toISOString() };
    w.off();
    this.onChange();
  }

  private drop(w: Watch): void {
    if (this.watches.get(w.id) !== w) return;
    this.watches.delete(w.id);
    if (w.timer !== undefined) this.clock.cancel(w.timer);
    w.timer = undefined;
    w.off();
    this.parks.unpark(w.conv, WATCH_PARK, w.id);
    this.onChange();
  }

  /** At the cap: the oldest latched watch goes, else the oldest one. */
  private evict(): void {
    const all = [...this.watches.values()].sort((a, b) => a.startedAt - b.startedAt);
    const victim = all.find((w) => w.latched !== undefined) ?? all[0];
    if (victim !== undefined) this.drop(victim);
  }

  private schedule(w: Watch, ms: number): void {
    if (this.disposed) return;
    w.timer = this.clock.schedule(() => {
      w.timer = undefined;
      void this.tick(w);
    }, ms);
  }

  /** One look: the heartbeat, the deadline, the tab, then the condition. */
  private async tick(w: Watch): Promise<void> {
    if (this.watches.get(w.id) !== w) return;
    const now = this.clock.now();
    if (now - w.lastPolled >= WATCH_HEARTBEAT_MS) {
      this.drop(w);
      return;
    }
    if (w.latched === undefined && !w.checking) {
      if (w.page.isClosed()) this.latch(w, { state: "ended", reason: "tab_closed" });
      else if ("navigation" in w.condition) {
        if (w.navigated) this.latch(w, { state: "met" });
      } else if (!("download" in w.condition)) {
        w.checking = true;
        try {
          if (await this.check(w.page, w.condition)) this.latch(w, { state: "met" });
        } catch {
          // a page between documents: the next look decides
        } finally {
          w.checking = false;
        }
      }
      if (w.latched === undefined && this.clock.now() >= w.deadline)
        this.latch(w, { state: "ended", reason: "deadline" });
    }
    if (this.watches.get(w.id) !== w) return;
    // a latched watch only waits for its end or its heartbeat drop
    const next =
      w.latched === undefined
        ? WATCH_CHECK_MS
        : Math.max(0, w.lastPolled + WATCH_HEARTBEAT_MS - this.clock.now());
    this.schedule(w, next);
  }
}
