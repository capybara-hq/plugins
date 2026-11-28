import { describe, expect, it } from "vitest";
import { SUMMARY_MAX_BYTES, summarize, withActor } from "../../src/events/summary.js";

const bytes = (s: string) => new TextEncoder().encode(s).length;

describe("collab event summaries", () => {
  it("summary stays under 4096 bytes for a huge description", () => {
    const description = "描述".repeat(40_000);
    const s = summarize("item.created", "BIG-1", "x".repeat(200), {
      description,
      changedFields: Array.from({ length: 500 }, (_, i) => `field_${i}`),
    });
    expect(bytes(s)).toBeLessThanOrEqual(SUMMARY_MAX_BYTES);
    // Never the full description: at most its first 500 characters.
    expect(s).not.toContain("描述".repeat(251));
    expect(bytes(withActor(s, "Li".repeat(5000)))).toBeLessThanOrEqual(SUMMARY_MAX_BYTES);
  });

  it("names the actor after the change", () => {
    const s = summarize("item.status_changed", "WR-1", "first", {
      fromStatus: "Drafting",
      toStatus: "Review",
    });
    expect(withActor(s, "PM (agent of Li)")).toBe(
      'WR-1 "first": status changed from "Drafting" to "Review". By PM (agent of Li).',
    );
  });

  it("describes an answered decision", () => {
    const s = summarize("decision.answered", "WR-2", "second", { answer: "Use Postgres" });
    expect(s).toBe('A decision on WR-2 "second" was answered: Use Postgres');
  });
});
