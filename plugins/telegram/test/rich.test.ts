import { describe, expect, it } from "vitest";
import { markdownToRichHtml, RICH_LIMITS, tableToRichHtml } from "../src/rich.js";
import { segmentTables } from "../src/tables.js";

const WJ = "⁠";

describe("markdownToRichHtml", () => {
  it("is undefined without a table, so the plain HTML path is used", () => {
    expect(markdownToRichHtml("**hi**\n- a\n- b")).toBeUndefined();
    expect(markdownToRichHtml("```\n| a | b |\n|---|---|\n| 1 | 2 |\n```")).toBeUndefined();
  });

  it("renders a table natively with alignment, inline formatting, <br> and escaped pipes", () => {
    const html = markdownToRichHtml(
      "| Name | Value | Note |\n|:--|--:|---|\n| **a** | `1<2` | [l](https://e.com) |\n| b | x<br>y | p \\| q |",
    );
    expect(html).toBe(
      '<table bordered striped><tr><th align="left">Name</th><th align="right">Value</th><th>Note</th></tr>' +
        '<tr><td align="left"><b>a</b></td><td align="right"><code>1&lt;2</code></td><td><a href="https://e.com">l</a></td></tr>' +
        '<tr><td align="left">b</td><td align="right">x<br>y</td><td>p | q</td></tr></table>',
    );
  });

  it("keeps line breaks as <br> (rich HTML collapses newlines) and none next to blocks", () => {
    const html = markdownToRichHtml(
      "# Title\nline 1\nline 2\n\n| a |\n|---|\n| 1 |\n\nafter\n> q1\n> q2\n\n```ts\nx = 1;\n\ny\n```\nend",
    );
    expect(html).toBe(
      "<b>Title</b><br>line 1<br>line 2" +
        "<table bordered striped><tr><th>a</th></tr><tr><td>1</td></tr></table>" +
        "after<blockquote>q1<br>q2</blockquote>" +
        '<pre><code class="language-ts">x = 1;\n\ny</code></pre>end',
    );
  });

  it("keeps the plain path's guards: mentions, http(s)-only links, escaped HTML", () => {
    const html = markdownToRichHtml(
      "@bob <script>x</script> [t](tg://user?id=1) `@code`\n\n| who |\n|---|\n| @alice |",
    );
    expect(html).toContain(`@${WJ}bob`);
    expect(html).toContain(`<td>@${WJ}alice</td>`);
    expect(html).toContain("<code>@code</code>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("[t](tg://user?id=1)");
    expect(html).not.toContain("<a ");
  });

  it("turns a table over 20 columns into the plain path's list, next to native tables", () => {
    const cols = RICH_LIMITS.columns + 1;
    const wide = `| ${Array.from({ length: cols }, (_, i) => `h${i}`).join(" | ")} |\n|${"---|".repeat(cols)}\n| ${Array.from({ length: cols }, (_, i) => `v${i}`).join(" | ")} |`;
    expect(markdownToRichHtml(wide)).toBeUndefined();
    const html = markdownToRichHtml(`${wide}\n\n| a |\n|---|\n| 1 |`);
    expect(html).toContain("• <b>v0</b><br>   h1: v1");
    expect(html?.match(/<table/g)).toHaveLength(1);
  });

  it("is undefined over the rich limits (text length, blocks)", () => {
    const table = "| a |\n|---|\n| 1 |";
    expect(markdownToRichHtml(`${"x".repeat(RICH_LIMITS.text + 1)}\n\n${table}`)).toBeUndefined();
    const rows = Array.from({ length: RICH_LIMITS.blocks }, (_, i) => `| ${i} |`).join("\n");
    expect(markdownToRichHtml(`| a |\n|---|\n${rows}`)).toBeUndefined();
    expect(markdownToRichHtml(`${"x".repeat(5000)}\n\n${table}`)).toContain("<table");
  });
});

describe("tableToRichHtml", () => {
  it("a header-only table and padded rows", () => {
    const [seg] = segmentTables("| a | b |\n|---|---|\n| 1 |");
    expect(seg?.kind).toBe("table");
    if (seg?.kind !== "table") return;
    expect(tableToRichHtml(seg.table)).toBe(
      "<table bordered striped><tr><th>a</th><th>b</th></tr><tr><td>1</td><td></td></tr></table>",
    );
    expect(tableToRichHtml({ header: ["a"], rows: [], align: [undefined] })).toBe(
      "<table bordered striped><tr><th>a</th></tr></table>",
    );
  });
});
