import { describe, expect, it } from "vitest";
import {
  applyOwnerReport,
  decideOwnerReport,
  ownerFactsOf,
  type StoredOwnerReport,
  storedOwnerReportOf,
} from "../src/index.js";

const report = (sequence: number, over: Record<string, unknown> = {}) =>
  ({
    version: 3,
    revision: `r${sequence}`,
    sequence,
    outsideSandbox: true,
    network: "open",
    restrictedProjectReach: "os-user",
    allowedDomains: ["a.test"],
    ...over,
  }) as StoredOwnerReport["report"];
const stored = (r: StoredOwnerReport["report"]): StoredOwnerReport => ({
  report: r,
  observedAt: "2026-11-17T00:00:00.000Z",
  via: "hello",
});
const NOW = "2026-11-22T00:00:00.000Z";

describe("owner report ordering", () => {
  it("records higher, repeats same, refuses lower and same-sequence different bytes", () => {
    const s = stored(report(3));
    expect(decideOwnerReport(null, report(0))).toBe("record");
    expect(decideOwnerReport(s, report(4))).toBe("record");
    expect(decideOwnerReport(s, report(3))).toBe("same");
    expect(decideOwnerReport(s, report(2))).toBe("stale");
    expect(decideOwnerReport(s, report(3, { outsideSandbox: false }))).toBe("conflict");
    expect(decideOwnerReport(s, report(3, { revision: "other" }))).toBe("conflict");
  });

  it("a stale report changes nothing, a conflicting one blocks, a valid one unblocks", () => {
    const s = stored(report(3));
    expect(applyOwnerReport(s, report(2), "policy", NOW)).toEqual({ outcome: "stale" });
    const conflict = applyOwnerReport(s, report(3, { outsideSandbox: false }), "policy", NOW);
    expect(conflict.outcome).toBe("conflict");
    // the facts stay the recorded ones; the block fails them closed
    expect(conflict.next?.report).toEqual(s.report);
    expect(conflict.next?.blocked).toEqual({ reason: "conflict", sequence: 3, at: NOW });
    const blocked = conflict.next as StoredOwnerReport;
    expect(ownerFactsOf(blocked).state).toBe("blocked");
    const same = applyOwnerReport(blocked, report(3), "hello", NOW);
    expect(same.outcome).toBe("same");
    expect(same.next?.blocked).toBeUndefined();
    const newer = applyOwnerReport(blocked, report(4, { outsideSandbox: false }), "policy", NOW);
    expect(newer).toEqual({
      outcome: "recorded",
      next: { report: report(4, { outsideSandbox: false }), observedAt: NOW, via: "policy" },
    });
  });
});

describe("owner facts", () => {
  it("reads only the report and fails closed without one", () => {
    expect(ownerFactsOf(stored(report(1, { outsideSandbox: false })))).toMatchObject({
      state: "report",
      outsideSandbox: false,
      restrictedProjectReach: "os-user",
      allowedDomains: ["a.test"],
      network: "open",
    });
    expect(ownerFactsOf(null)).toMatchObject({
      state: "missing",
      outsideSandbox: false,
      restrictedProjectReach: "workspace",
      network: "allowlist",
      allowedDomains: [],
    });
    expect(
      ownerFactsOf({ ...stored(report(2)), blocked: { reason: "conflict", sequence: 2, at: "x" } }),
    ).toMatchObject({
      state: "blocked",
      outsideSandbox: false,
      restrictedProjectReach: "workspace",
      network: "allowlist",
    });
  });

  it("a stored report that does not parse strictly is never trusted", () => {
    expect(storedOwnerReportOf(stored(report(1)))).toEqual(stored(report(1)));
    expect(storedOwnerReportOf({ junk: true })).toBeNull();
    expect(storedOwnerReportOf(null)).toBeNull();
    expect(storedOwnerReportOf({ ...stored(report(1)), via: "elsewhere" })).toBeNull();
    // a protocol 3 report (version 2, fullAccess) is unreadable: missing, fail closed
    const v2 = {
      ...stored(report(1)),
      report: {
        version: 2,
        revision: "r1",
        sequence: 1,
        fullAccess: true,
        restrictedProjectReach: "os-user",
        restrictedAllowedDomains: [],
      },
    };
    expect(storedOwnerReportOf(v2)).toBeNull();
    expect(ownerFactsOf(storedOwnerReportOf(v2)).state).toBe("missing");
    // an unknown block reason is dropped, not trusted as a block of another kind
    expect(
      storedOwnerReportOf({
        ...stored(report(1)),
        blocked: { reason: "stale", sequence: 1, at: "x" },
      })?.blocked,
    ).toBeUndefined();
  });
});
