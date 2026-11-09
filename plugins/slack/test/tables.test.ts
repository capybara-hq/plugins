import { describe, expect, it } from "vitest";
import { segmentTables, splitRow, tablesToLists, tableToListMarkdown } from "../src/tables.js";

/** The reply that leaked raw pipes into Slack. */
const ATTEMPTS = [
  "**实际情况**",
  "| 尝试 | 结果 |",
  "|---|---|",
  "| 列出会话（第 1 次） | 报错：`Could not obtain an access token: the app's authorization server is unavailable` |",
  "| 列出会话（第 2 次） | 报错：`The user has not connected Slack`（提示已弹出连接卡片） |",
  "| 读取刚才那个私信频道 D0BBPQXM55F | 同样报错：`The user has not connected Slack` |",
].join("\n");

const CHATS = [
  "| 会话 | 类型 | 最新内容 |",
  "|:--|:-:|--:|",
  "| #所有-meta1 (C0BABB5B5L6) | 公开频道 | 1 条：「晚间招呼」（由 connector 在 11-09 23:13 代发） |",
  "| #dev | 公开频道 | |",
].join("\n");

describe("splitRow", () => {
  it("splits on unescaped pipes, trims cells, drops the outer pipes", () => {
    expect(splitRow("| a | b |")).toEqual(["a", "b"]);
    expect(splitRow("a|b")).toEqual(["a", "b"]);
    expect(splitRow("| a \\| b | c |")).toEqual(["a | b", "c"]);
    expect(splitRow("| a | |")).toEqual(["a", ""]);
    expect(splitRow("no pipe")).toBeUndefined();
    expect(splitRow("only \\| escaped")).toBeUndefined();
  });
});

describe("segmentTables", () => {
  it("finds a table under a paragraph line; the alignment row is dropped", () => {
    const segs = segmentTables(ATTEMPTS);
    expect(segs).toHaveLength(2);
    expect(segs[0]).toEqual({ kind: "text", lines: ["**实际情况**"] });
    expect(segs[1]).toMatchObject({
      kind: "table",
      table: { header: ["尝试", "结果"] },
    });
    const t = segs[1]?.kind === "table" ? segs[1].table : undefined;
    expect(t?.rows).toHaveLength(3);
    expect(t?.rows[1]).toEqual([
      "列出会话（第 2 次）",
      "报错：`The user has not connected Slack`（提示已弹出连接卡片）",
    ]);
  });

  it("pads short rows and cuts long ones to the header's width", () => {
    const segs = segmentTables("| a | b |\n|---|---|\n| 1 |\n| 1 | 2 | 3 |");
    expect(segs[0]).toEqual({
      kind: "table",
      table: {
        header: ["a", "b"],
        rows: [
          ["1", ""],
          ["1", "2"],
        ],
      },
    });
  });

  it("a paragraph right after a table ends it (blank line or a line without a pipe)", () => {
    const segs = segmentTables(`${CHATS}\n以上是结果。`);
    expect(segs.map((s) => s.kind)).toEqual(["table", "text"]);
    expect(segs[1]).toEqual({ kind: "text", lines: ["以上是结果。"] });
  });

  it("leaves tables in code fences, indented code, quotes and lone pipe lines alone", () => {
    for (const md of [
      "```\n| a | b |\n|---|---|\n| 1 | 2 |\n```",
      "~~~md\n| a | b |\n|---|---|\n~~~",
      "    | a | b |\n    |---|---|",
      "> | a | b |\n> |---|---|",
      "a | b",
      "| a | b |\n| not a delimiter |",
      "| a | b |\n|---|",
    ]) {
      expect(segmentTables(md).every((s) => s.kind === "text")).toBe(true);
      expect(tablesToLists(md)).toBe(md);
    }
  });

  it("a fence right after a table ends the table", () => {
    const segs = segmentTables("| a |\n|---|\n| 1 |\n```\nx\n```");
    expect(segs.map((s) => s.kind)).toEqual(["table", "text"]);
  });
});

describe("tableToListMarkdown", () => {
  it("two columns: one line per row, the first cell bold (not when it has code)", () => {
    expect(tablesToLists(ATTEMPTS)).toBe(
      [
        "**实际情况**",
        "- **列出会话（第 1 次）** — 报错：`Could not obtain an access token: the app's authorization server is unavailable`",
        "- **列出会话（第 2 次）** — 报错：`The user has not connected Slack`（提示已弹出连接卡片）",
        "- **读取刚才那个私信频道 D0BBPQXM55F** — 同样报错：`The user has not connected Slack`",
      ].join("\n"),
    );
    expect(tableToListMarkdown({ header: ["k", "v"], rows: [["`id`", "1"]] })).toEqual([
      "- `id` — 1",
    ]);
  });

  it("more columns: the first cell, then indented header: value lines; empty cells skipped", () => {
    expect(tablesToLists(CHATS)).toBe(
      [
        "- **#所有-meta1 (C0BABB5B5L6)**",
        "   类型：公开频道",
        "   最新内容：1 条：「晚间招呼」（由 connector 在 11-09 23:13 代发）",
        "- **#dev**",
        "   类型：公开频道",
      ].join("\n"),
    );
  });

  it("an ASCII header gets an ASCII colon; <br> becomes a separator", () => {
    expect(
      tableToListMarkdown({ header: ["Name", "Status", "Notes"], rows: [["api", "ok", "a<br>b"]] }),
    ).toEqual(["- **api**", "   Status: ok", "   Notes: a / b"]);
  });

  it("an empty first cell leads with the next pair; empty rows are dropped; header-only tables", () => {
    expect(
      tableToListMarkdown({
        header: ["a", "b", "c"],
        rows: [
          ["", "1", "2"],
          ["", "", ""],
        ],
      }),
    ).toEqual(["- b: 1", "   c: 2"]);
    expect(tableToListMarkdown({ header: ["a", "b"], rows: [["", "x"]] })).toEqual(["- x"]);
    expect(tableToListMarkdown({ header: ["a", "", "c"], rows: [] })).toEqual(["a · c"]);
  });

  it("escaped pipes come out as plain pipes", () => {
    expect(tablesToLists("| op | meaning |\n|---|---|\n| `a \\| b` | or |")).toBe("- `a | b` — or");
  });
});
