import { describe, expect, it } from "vitest";
import { segmentTables, tablesToLists } from "../src/tables.js";

describe("segmentTables (telegram fence rules)", () => {
  it("a fence closes only on a bare fence line, as in html.ts", () => {
    const md = "```\n```js\n| a |\n|---|\n```\n| b |\n|---|\n| 1 |";
    expect(segmentTables(md).map((s) => s.kind)).toEqual(["text", "table"]);
    expect(tablesToLists(md)).toBe("```\n```js\n| a |\n|---|\n```\n- **1**");
  });

  it("reads the column alignment from the delimiter row", () => {
    const [seg] = segmentTables("| a | b | c | d |\n|:--|:-:|--:|---|");
    expect(seg?.kind === "table" && seg.table.align).toEqual([
      "left",
      "center",
      "right",
      undefined,
    ]);
  });

  it("alignment rows, escaped pipes and CJK cells", () => {
    expect(tablesToLists("| 名称 | 说明 |\n|:--|--:|\n| `a\\|b` | 或 |")).toBe("- `a|b` — 或");
  });
});
