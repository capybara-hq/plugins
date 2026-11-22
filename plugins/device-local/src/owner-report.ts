import {
  type DeviceOwnerCeiling,
  parseOwnerCeilingReport,
} from "@capybara-hq/plugin-sdk/device-protocol";

/** Which message carried a report (diagnostics only). */
export type OwnerReportVia = "hello" | "policy" | "bind";

/**
 * The machine owner's authenticated ceiling as this provider keeps it (`connections.owner_report`):
 * the strict report, when and how it arrived, and a block set by an out-of-order report.
 */
export interface StoredOwnerReport {
  report: DeviceOwnerCeiling;
  observedAt: string;
  via: OwnerReportVia;
  /** A later report arrived conflicting: nothing wider than failing closed until a valid one. */
  blocked?: { reason: "conflict"; sequence: number; at: string };
}

/** The stored report in `v`, or null (absent or malformed: never trusted). */
export function storedOwnerReportOf(v: unknown): StoredOwnerReport | null {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  let report: DeviceOwnerCeiling;
  try {
    report = parseOwnerCeilingReport(o.report);
  } catch {
    return null;
  }
  if (typeof o.observedAt !== "string") return null;
  if (o.via !== "hello" && o.via !== "policy" && o.via !== "bind") return null;
  const b = o.blocked as Record<string, unknown> | undefined;
  return {
    report,
    observedAt: o.observedAt,
    via: o.via,
    ...(b &&
      b.reason === "conflict" &&
      typeof b.sequence === "number" &&
      typeof b.at === "string" && {
        blocked: { reason: "conflict" as const, sequence: b.sequence, at: b.at },
      }),
  };
}

const canonicalReport = (r: DeviceOwnerCeiling) => ({
  version: r.version,
  revision: r.revision,
  sequence: r.sequence,
  outsideSandbox: r.outsideSandbox,
  network: r.network,
  allowedDomains: [...r.allowedDomains],
  restrictedProjectReach: r.restrictedProjectReach,
});

/** Whether two reports are the same bytes (same sequence, revision and facts). */
export const sameOwnerReport = (a: DeviceOwnerCeiling, b: DeviceOwnerCeiling): boolean =>
  JSON.stringify(canonicalReport(a)) === JSON.stringify(canonicalReport(b));

/**
 * What a newly arrived report means against the stored one: a higher sequence is recorded; the
 * same sequence, revision and facts is idempotent; a lower sequence is stale; the same sequence
 * with other facts is a protocol conflict. The machine advances its sequence durably before it
 * publishes a new revision, and a new machine credential (`capybara-device login`) starts again.
 */
export function decideOwnerReport(
  stored: StoredOwnerReport | null,
  incoming: DeviceOwnerCeiling,
): "record" | "same" | "stale" | "conflict" {
  if (stored === null) return "record";
  const prev = stored.report;
  if (incoming.sequence > prev.sequence) return "record";
  if (incoming.sequence < prev.sequence) return "stale";
  return sameOwnerReport(incoming, prev) ? "same" : "conflict";
}

/**
 * The owner facts this provider reports and narrows with, never wider than the machine reported:
 * - `report`: an authenticated report;
 * - `blocked`: a conflicting report arrived: fail closed;
 * - `missing`: nothing readable: fail closed.
 */
export interface OwnerFacts {
  state: "report" | "blocked" | "missing";
  /** The owner allows running outside the sandbox (an escalated call). */
  outsideSandbox: boolean;
  restrictedProjectReach: "workspace" | "os-user";
  /** The owner's sandbox allowlist: the machine's host ceiling while its network is `allowlist`. */
  allowedDomains: string[];
  /** The owner's sandbox network (`allowlist` when failing closed). */
  network: "open" | "allowlist";
  revision: string | null;
  sequence: number | null;
}

const FAIL_CLOSED = {
  outsideSandbox: false,
  restrictedProjectReach: "workspace" as const,
  allowedDomains: [],
  network: "allowlist" as const,
};

/** The facts of a stored report (absent or unreadable: missing; blocked: failing closed). */
export function ownerFactsOf(stored: StoredOwnerReport | null): OwnerFacts {
  if (stored === null) return { state: "missing", ...FAIL_CLOSED, revision: null, sequence: null };
  if (stored.blocked)
    return {
      state: "blocked",
      ...FAIL_CLOSED,
      revision: stored.report.revision,
      sequence: stored.report.sequence,
    };
  return {
    state: "report",
    outsideSandbox: stored.report.outsideSandbox,
    restrictedProjectReach: stored.report.restrictedProjectReach,
    allowedDomains: [...stored.report.allowedDomains],
    network: stored.report.network,
    revision: stored.report.revision,
    sequence: stored.report.sequence,
  };
}

/** What became of an arrived report. */
export type OwnerReportOutcome = "recorded" | "same" | "stale" | "conflict";

/**
 * Applies one arrived report to the stored one (the single owner-report rule of every carrier):
 * - a higher sequence is recorded (a block clears);
 * - the same report again keeps the stored one (a block clears: a valid current report arrived);
 * - a stale one changes nothing (a policy event or bind answer committed after a newer report
 *   carries no newer authority);
 * - a conflicting one keeps the facts but blocks them (fail closed) until a valid report arrives.
 * `next` is what to store (undefined: nothing to write).
 */
export function applyOwnerReport(
  stored: StoredOwnerReport | null,
  incoming: DeviceOwnerCeiling,
  via: OwnerReportVia,
  now: string,
): { outcome: OwnerReportOutcome; next?: StoredOwnerReport } {
  const decision = decideOwnerReport(stored, incoming);
  if (decision === "record")
    return { outcome: "recorded", next: { report: incoming, observedAt: now, via } };
  if (decision === "stale" || stored === null) return { outcome: "stale" };
  if (decision === "same") {
    const { blocked: _cleared, ...kept } = stored;
    return { outcome: "same", next: { ...kept, observedAt: now } };
  }
  return {
    outcome: "conflict",
    next: { ...stored, blocked: { reason: "conflict", sequence: incoming.sequence, at: now } },
  };
}
