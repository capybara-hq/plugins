import type { CapybaraEvent, ClientStorage } from "@capybara-hq/plugin-client";

/** What the HUD shows for a conversation: the live events seen in this browser session. */
export interface Counts {
  runs: number;
  tools: number;
  errors: number;
  approvals: number;
}

export const ZERO: Counts = { runs: 0, tools: 0, errors: 0, approvals: 0 };

/** Stored per conversation in session client storage: the counts and the last counted seq. */
interface Stored {
  seq: number;
  counts: Counts;
}

const key = (conversationId: string) => `counts:${conversationId}`;

function read(storage: ClientStorage, conversationId: string): Stored {
  const raw = storage.get(key(conversationId), "session");
  if (raw === null) return { seq: -1, counts: ZERO };
  try {
    const v = JSON.parse(raw) as Partial<Stored>;
    const c = (v.counts ?? {}) as Partial<Counts>;
    const n = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : 0);
    return {
      seq: typeof v.seq === "number" ? v.seq : -1,
      counts: {
        runs: n(c.runs),
        tools: n(c.tools),
        errors: n(c.errors),
        approvals: n(c.approvals),
      },
    };
  } catch {
    return { seq: -1, counts: ZERO };
  }
}

/** The counts of a conversation, or null when this browser session has seen no event of it yet. */
export function readCounts(storage: ClientStorage, conversationId: string): Counts | null {
  const stored = read(storage, conversationId);
  return stored.seq < 0 ? null : stored.counts;
}

/** The counts after one client event. */
function next(c: Counts, e: CapybaraEvent): Counts | null {
  if (e.type === "run.started") return { ...c, runs: c.runs + 1 };
  if (e.type === "approval.requested") return { ...c, approvals: c.approvals + 1 };
  if (e.type === "tool.finished") {
    return e.isError ? { ...c, errors: c.errors + 1 } : { ...c, tools: c.tools + 1 };
  }
  return null;
}

/**
 * Counts one client event into session storage. Idempotent by `seq` (events arrive once each, in
 * seq order), so the extension's listener (alive from the page's first load) and the HUD can both
 * record the same event, in either order, and it counts once.
 */
export function recordEvent(storage: ClientStorage, e: CapybaraEvent): void {
  const stored = read(storage, e.conversationId);
  if (e.seq <= stored.seq) return;
  const counts = next(stored.counts, e);
  if (counts === null) return;
  storage.set(key(e.conversationId), JSON.stringify({ seq: e.seq, counts }), "session");
}
