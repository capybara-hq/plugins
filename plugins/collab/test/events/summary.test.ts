import { describe, expect, it } from "vitest";
import { SUMMARY_MAX_BYTES, storedDetail, summarize } from "../../src/events/summary.js";

const bytes = (s: string) => new TextEncoder().encode(s).length;

describe("collab event summaries", () => {
  it("summary stays under 4096 bytes for a huge description", () => {
    const detail = storedDetail("BIG-1", "x".repeat(200), {
      description: "描述".repeat(40_000),
      changedFields: Array.from({ length: 500 }, (_, i) => `field_${i}`),
    });
    // The row keeps only the excerpt.
    expect(detail.description).toHaveLength(500);
    const s = summarize("item.created", detail, { actor: "Li".repeat(5000) });
    expect(bytes(s)).toBeLessThanOrEqual(SUMMARY_MAX_BYTES);
    expect(s).not.toContain("描述".repeat(251));
  });

  it("names the actor in the first sentence", () => {
    const detail = storedDetail("WR-1", "first", { fromStatus: "Drafting", toStatus: "Review" });
    expect(summarize("item.status_changed", detail, { actor: "PM (agent of Li)" })).toBe(
      'WR-1 "first": status changed from "Drafting" to "Review" by PM (agent of Li).',
    );
  });

  it("names the assignment pair, falling back to ids", () => {
    const detail = storedDetail("WR-3", "third", {
      responsibleAccountId: "acct-eng",
      executingAgentId: "agent-eng",
    });
    expect(
      summarize("item.assigned", detail, { actor: "Li", responsible: "Wang", agent: "Coder" }),
    ).toBe('WR-3 "third" was assigned to Wang with Coder by Li.');
    expect(summarize("item.unassigned", detail, { actor: "Li" })).toBe(
      'WR-3 "third" is no longer assigned to agent-eng of acct-eng (changed by Li).',
    );
  });

  it("describes an answered decision", () => {
    const detail = storedDetail("WR-2", "second", { answer: "Use Postgres" });
    expect(summarize("decision.answered", detail, { actor: "Li" })).toBe(
      'Li answered a decision on WR-2 "second": Use Postgres',
    );
  });
});
