// The daemon's session file (`<state>/session.json`): the open tabs' URLs and the pending handoff,
// so a daemon restarted moments ago (a network change restarts the service on some providers)
// comes back with them. The profile (cookies, storage) persists on its own; this adds only what
// Chromium does not keep. An idle stop forgets the file, and a file older than
// RESTORE_MAX_AGE_MS is ignored: a later start begins with one blank tab, as before.

import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type BrowserSession, normalizeUrl } from "./actions.js";
import { HANDOFF_MAX_CHARS, MAX_TABS } from "./protocol.js";
import type { Clock } from "./state.js";

/** A session file older than this is not restored. */
export const RESTORE_MAX_AGE_MS = 10 * 60_000;

export interface SavedSession {
  savedAt: number;
  /** The tabs' http(s) URLs in tab order. */
  tabs: string[];
  /** Index of the active tab in `tabs`. */
  active: number;
  handoff?: { callId: string; message: string };
}

export class SessionFile {
  private readonly file: string;
  private readonly clock: Clock;
  private queued = false;
  private forgotten = false;

  constructor(stateDir: string, clock: Clock) {
    this.file = join(stateDir, "session.json");
    this.clock = clock;
  }

  /** The saved session when it is recent and well formed; undefined otherwise. */
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
      typeof s.savedAt !== "number" ||
      this.clock.now() - s.savedAt > RESTORE_MAX_AGE_MS ||
      !Array.isArray(s.tabs)
    )
      return undefined;
    const tabs = s.tabs.filter(
      (u): u is string => typeof u === "string" && /^https?:\/\//i.test(u),
    );
    const h = s.handoff;
    const handoff =
      typeof h === "object" &&
      h !== null &&
      typeof h.callId === "string" &&
      h.callId !== "" &&
      typeof h.message === "string"
        ? { callId: h.callId, message: h.message.slice(0, HANDOFF_MAX_CHARS) }
        : undefined;
    return {
      savedAt: s.savedAt,
      tabs: tabs.slice(0, MAX_TABS),
      active: typeof s.active === "number" ? s.active : 0,
      ...(handoff === undefined ? {} : { handoff }),
    };
  }

  /**
   * Writes the session soon (coalesced): the tabs' URLs and the pending handoff, both read when
   * the write runs.
   */
  save(
    session: BrowserSession,
    handoffNow: () => { callId: string; message: string } | undefined,
  ): void {
    if (this.queued || this.forgotten) return;
    this.queued = true;
    queueMicrotask(() => {
      this.queued = false;
      if (this.forgotten) return;
      const handoff = handoffNow();
      const all = session.tabs();
      const kept = all.filter((t) => /^https?:\/\//i.test(t.url));
      const active = Math.max(
        0,
        kept.findIndex((t) => t.active),
      );
      const body: SavedSession = {
        savedAt: this.clock.now(),
        tabs: kept.map((t) => t.url),
        active,
        ...(handoff === undefined ? {} : { handoff }),
      };
      try {
        writeFileSync(`${this.file}.tmp`, JSON.stringify(body), { mode: 0o600 });
        renameSync(`${this.file}.tmp`, this.file);
      } catch {
        // a full or read-only disk: the next start simply restores nothing
      }
    });
  }

  /** Removes the file and stops saving (an idle stop). */
  forget(): void {
    this.forgotten = true;
    rmSync(this.file, { force: true });
  }

  /**
   * Opens the saved tabs in a browser that has only its first blank tab. The navigations are
   * started, not awaited: the first request after a restart does not wait for every page to load.
   */
  async restoreTabs(session: BrowserSession, saved: SavedSession): Promise<void> {
    if (saved.tabs.length === 0) return;
    const ids: string[] = [];
    for (const [i, url] of saved.tabs.entries()) {
      try {
        const page = i === 0 ? await session.activePage() : await session.openTab();
        ids.push(session.tabIdOf(page));
        void session.viewerNav({ url: normalizeUrl(url) });
      } catch {
        // a tab that cannot open is left out
      }
    }
    const active = ids[saved.active];
    if (active !== undefined) await session.switchTo(active).catch(() => undefined);
  }
}
