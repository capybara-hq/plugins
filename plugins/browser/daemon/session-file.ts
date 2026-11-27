// The daemon's session file (`<state>/session.json`): the open tabs' URLs with their owners, and
// per conversation its active tab, pending handoff and persistent parks, so a daemon restarted
// moments ago (a network change restarts the service on some providers) comes back with them and
// gives each tab back to its owner. The profile (cookies, storage) persists on its own; this adds
// only what Chromium does not keep. An idle stop forgets the file, and a file older than
// RESTORE_MAX_AGE_MS or of another format is ignored: a later start begins with one blank tab.

import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEVICE_SERVICE_RESTORE_MAX_AGE_MS } from "@capybara-hq/plugin-sdk";
import type { BrowserSession } from "./actions.js";
import { HANDOFF_MAX_CHARS, MAX_TABS } from "./protocol.js";
import { type Clock, type DaemonState, HANDOFF_PARK } from "./state.js";

/**
 * A session file older than this is not restored: the SDK's restore window, for which the kernel
 * keeps a deleted conversation's notice owed while the service does not run.
 */
export const RESTORE_MAX_AGE_MS = DEVICE_SERVICE_RESTORE_MAX_AGE_MS;

/** The session file format; a file of another one (an older daemon's) is not restored. */
export const SESSION_FILE_VERSION = 2;

export interface SavedTab {
  /** An http(s) URL. */
  url: string;
  owner: string;
  root: string;
}

export interface SavedConversation {
  id: string;
  root: string;
  /** Index of the conversation's active tab in `tabs`. */
  active?: number;
  handoff?: { callId: string; message: string };
  /** Persistent conversation parks besides the handoff. */
  parks?: { kind: string; key: string }[];
}

export interface SavedSession {
  version: typeof SESSION_FILE_VERSION;
  savedAt: number;
  /** The owned tabs with http(s) URLs, in tab order (unowned tabs are not kept). */
  tabs: SavedTab[];
  conversations: SavedConversation[];
}

const isId = (v: unknown): v is string => typeof v === "string" && v !== "";

/** What `state` must answer for a save. */
type StateView = Pick<DaemonState, "conversationIds" | "rootOf" | "handoffOf" | "parksOf">;

export class SessionFile {
  private readonly file: string;
  private readonly clock: Clock;
  private queued = false;
  private forgotten = false;

  constructor(stateDir: string, clock: Clock) {
    this.file = join(stateDir, "session.json");
    this.clock = clock;
  }

  /** The saved session when it is recent, of this format and well formed; undefined otherwise. */
  read(): SavedSession | undefined {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(this.file, "utf8"));
    } catch {
      return undefined;
    }
    const s = raw as Partial<SavedSession> | null;
    if (
      typeof s !== "object" ||
      s === null ||
      s.version !== SESSION_FILE_VERSION ||
      typeof s.savedAt !== "number" ||
      this.clock.now() - s.savedAt > RESTORE_MAX_AGE_MS ||
      !Array.isArray(s.tabs) ||
      !Array.isArray(s.conversations)
    )
      return undefined;
    const tabs = s.tabs
      .filter(
        (t): t is SavedTab =>
          typeof t === "object" &&
          t !== null &&
          typeof t.url === "string" &&
          /^https?:\/\//i.test(t.url) &&
          isId(t.owner) &&
          isId(t.root),
      )
      .slice(0, MAX_TABS)
      .map((t) => ({ url: t.url, owner: t.owner, root: t.root }));
    const conversations: SavedConversation[] = [];
    for (const c of s.conversations as unknown[]) {
      if (typeof c !== "object" || c === null) continue;
      const x = c as Partial<SavedConversation>;
      if (!isId(x.id) || !isId(x.root)) continue;
      const h = x.handoff;
      const handoff =
        typeof h === "object" && h !== null && isId(h.callId) && typeof h.message === "string"
          ? { callId: h.callId, message: h.message.slice(0, HANDOFF_MAX_CHARS) }
          : undefined;
      const parks = Array.isArray(x.parks)
        ? x.parks
            .filter(
              (p) =>
                typeof p === "object" && p !== null && isId(p.kind) && typeof p.key === "string",
            )
            .map((p) => ({ kind: p.kind, key: p.key }))
        : [];
      conversations.push({
        id: x.id,
        root: x.root,
        ...(typeof x.active === "number" ? { active: x.active } : {}),
        ...(handoff === undefined ? {} : { handoff }),
        ...(parks.length === 0 ? {} : { parks }),
      });
    }
    return { version: SESSION_FILE_VERSION, savedAt: s.savedAt, tabs, conversations };
  }

  /**
   * Writes the session soon (coalesced): the tabs with their owners, and per conversation its
   * active tab, pending handoff and persistent parks, all read when the write runs.
   */
  save(session: BrowserSession, state: StateView): void {
    if (this.queued || this.forgotten) return;
    this.queued = true;
    queueMicrotask(() => {
      this.queued = false;
      if (this.forgotten) return;
      const kept = session
        .tabs()
        .filter(
          (t): t is typeof t & { owner: string; root: string } =>
            t.owner !== undefined && t.root !== undefined && /^https?:\/\//i.test(t.url),
        );
      const tabs: SavedTab[] = kept.map((t) => ({ url: t.url, owner: t.owner, root: t.root }));
      const ids = new Set<string>([...kept.map((t) => t.owner), ...state.conversationIds]);
      const conversations: SavedConversation[] = [];
      for (const id of ids) {
        const root = kept.find((t) => t.owner === id)?.root ?? state.rootOf(id);
        if (root === undefined) continue;
        const active = kept.findIndex((t) => t.owner === id && t.active);
        const handoff = state.handoffOf(id);
        const parks = state
          .parksOf(id)
          .filter((p) => p.persist === true && p.tabId === undefined && p.kind !== HANDOFF_PARK)
          .map((p) => ({ kind: p.kind, key: p.key }));
        if (active < 0 && handoff === undefined && parks.length === 0) continue;
        conversations.push({
          id,
          root,
          ...(active < 0 ? {} : { active }),
          ...(handoff === undefined ? {} : { handoff }),
          ...(parks.length === 0 ? {} : { parks }),
        });
      }
      const body: SavedSession = {
        version: SESSION_FILE_VERSION,
        savedAt: this.clock.now(),
        tabs,
        conversations,
      };
      try {
        writeFileSync(`${this.file}.tmp`, JSON.stringify(body), { mode: 0o600 });
        renameSync(`${this.file}.tmp`, this.file);
      } catch {
        // a full or read-only disk: the next start simply restores nothing
      }
    });
  }

  /**
   * Removes a deleted conversation and the conversations whose tree root it is from the file on
   * disk, keeping its save time (a restore window never grows), so a later start does not restore
   * their tabs. Nothing to do without a file or after {@link forget}.
   */
  dropTree(conversationId: string): void {
    if (this.forgotten) return;
    let raw: SavedSession;
    try {
      raw = JSON.parse(readFileSync(this.file, "utf8")) as SavedSession;
    } catch {
      return;
    }
    const next = withoutTree(raw, conversationId);
    if (next === raw) return;
    try {
      writeFileSync(`${this.file}.tmp`, JSON.stringify(next), { mode: 0o600 });
      renameSync(`${this.file}.tmp`, this.file);
    } catch {
      // a full or read-only disk: the idle close stays the backstop
    }
  }

  /** Removes the file and stops saving (an idle stop). */
  forget(): void {
    this.forgotten = true;
    rmSync(this.file, { force: true });
  }

  /** Gives the conversations their pending handoffs and persistent parks back. */
  restoreState(state: Pick<DaemonState, "noticeHandoff" | "park">, saved: SavedSession): void {
    for (const c of saved.conversations) {
      if (c.handoff !== undefined)
        state.noticeHandoff(c.id, c.root, c.handoff.callId, c.handoff.message);
      for (const p of c.parks ?? []) state.park(c.id, c.root, { ...p, persist: true });
    }
  }

  /**
   * Opens the saved tabs, each for its owner, in a browser that has only its first blank tab, and
   * gives each conversation its active tab back. The navigations are started, not awaited: the
   * first request after a restart does not wait for every page to load.
   */
  async restoreTabs(session: BrowserSession, saved: SavedSession): Promise<void> {
    const ids: (string | undefined)[] = [];
    for (const t of saved.tabs) {
      try {
        ids.push(await session.restoreTab({ owner: t.owner, root: t.root }, t.url));
      } catch {
        // a tab that cannot open is left out
        ids.push(undefined);
      }
    }
    for (const c of saved.conversations) {
      const id = c.active === undefined ? undefined : ids[c.active];
      if (id !== undefined) session.setActive(c.id, id);
    }
  }
}

/**
 * The saved session without a deleted conversation and the conversations whose tree root it is
 * (tabs and per-conversation state); `saved` itself when it holds none of them.
 */
export function withoutTree(saved: SavedSession, conversationId: string): SavedSession {
  const hit = (owner: unknown, root: unknown) =>
    owner === conversationId || root === conversationId;
  if (!Array.isArray(saved.tabs) || !Array.isArray(saved.conversations)) return saved;
  const tabs = saved.tabs.filter((t) => !hit(t?.owner, t?.root));
  const conversations = saved.conversations.filter((c) => !hit(c?.id, c?.root));
  if (tabs.length === saved.tabs.length && conversations.length === saved.conversations.length)
    return saved;
  // an active index points into `tabs`: re-point each kept conversation's active tab
  const kept = conversations.map((c) => {
    if (c.active === undefined) return c;
    const tab = saved.tabs[c.active];
    const at = tab === undefined ? -1 : tabs.indexOf(tab);
    const { active: _active, ...rest } = c;
    return at < 0 ? rest : { ...rest, active: at };
  });
  return { ...saved, tabs, conversations: kept };
}
