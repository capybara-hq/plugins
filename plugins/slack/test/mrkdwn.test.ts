import { describe, expect, it } from "vitest";
import { markdownToMrkdwn, splitMrkdwn } from "../src/mrkdwn.js";

describe("markdownToMrkdwn", () => {
  it("bold, italics and strikethrough", () => {
    expect(markdownToMrkdwn("**bold** and __also__")).toBe("*bold* and *also*");
    expect(markdownToMrkdwn("*it* and _it_")).toBe("_it_ and _it_");
    expect(markdownToMrkdwn("***both***")).toBe("*_both_*");
    expect(markdownToMrkdwn("~~gone~~")).toBe("~gone~");
  });

  it("inline code is kept verbatim (no formatting inside)", () => {
    expect(markdownToMrkdwn("run `a **b** c` now")).toBe("run `a **b** c` now");
  });

  it("code blocks drop the language and keep content verbatim", () => {
    const md = "before\n```ts\nconst x = **1**;\n# not a heading\n```\nafter";
    expect(markdownToMrkdwn(md)).toBe("before\n```\nconst x = **1**;\n# not a heading\n```\nafter");
  });

  it("links become <url|text>; bare autolinks stay links", () => {
    expect(markdownToMrkdwn("see [the docs](https://x.example/a?b=1&c=2)")).toBe(
      "see <https://x.example/a?b=1&amp;c=2|the docs>",
    );
    expect(markdownToMrkdwn("<https://x.example>")).toBe("<https://x.example>");
    expect(markdownToMrkdwn("[a|b](https://x.example)")).toBe("<https://x.example|a¦b>");
  });

  it("model text cannot inject Slack control sequences through link URLs", () => {
    for (const md of [
      "[x](https://a.com|<!channel>)",
      "<https://x<!here>",
      "[y](https://a.com/<@U123>)",
      "see <https://a.com|<!everyone>>",
    ]) {
      const out = markdownToMrkdwn(md);
      expect(out, md).not.toContain("<!");
      expect(out, md).not.toContain("<@");
      // 每个链接最多一个分隔符 |
      for (const link of out.match(/<[^<>]*>/g) ?? []) {
        expect(link.split("|").length, md).toBeLessThanOrEqual(2);
      }
    }
    expect(markdownToMrkdwn("[x](https://a.com|<!channel>)")).toBe(
      "<https://a.com%7C%3C!channel%3E|x>",
    );
    expect(markdownToMrkdwn("<https://x<!here>")).toBe("<https://x%3C!here>");
  });

  it("headings become bold lines", () => {
    expect(markdownToMrkdwn("# Title\n## **Sub** title")).toBe("*Title*\n*Sub title*");
  });

  it("unordered lists become bullets; ordered lists and nesting are kept", () => {
    expect(markdownToMrkdwn("- one\n* two\n  - nested\n1. first\n2. second")).toBe(
      "• one\n• two\n  • nested\n1. first\n2. second",
    );
  });

  it("escapes &, < and > outside of links", () => {
    expect(markdownToMrkdwn("a < b && c > d")).toBe("a &lt; b &amp;&amp; c &gt; d");
    expect(markdownToMrkdwn("`x<y`")).toBe("`x&lt;y`");
  });

  it("blockquotes are kept", () => {
    expect(markdownToMrkdwn("> quoted **text**")).toBe("> quoted *text*");
  });

  it("does not treat snake_case or 2*3*4 as italics", () => {
    expect(markdownToMrkdwn("snake_case_name and 2*3*4")).toBe("snake_case_name and 2*3*4");
  });
});

describe("splitMrkdwn", () => {
  it("returns one chunk when short enough", () => {
    expect(splitMrkdwn("hello", 10)).toEqual(["hello"]);
  });

  it("splits on paragraph / line boundaries, each chunk within the limit", () => {
    const text = `${"a".repeat(30)}\n\n${"b".repeat(30)}\n${"c".repeat(30)}`;
    const chunks = splitMrkdwn(text, 40);
    expect(chunks).toEqual(["a".repeat(30), "b".repeat(30), "c".repeat(30)]);
  });

  it("hard-cuts a line longer than the limit, preferring spaces", () => {
    const chunks = splitMrkdwn("word ".repeat(20).trim(), 22);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(22);
    expect(chunks.join(" ")).toBe("word ".repeat(20).trim());
    const solid = splitMrkdwn("x".repeat(50), 20);
    expect(solid).toEqual(["x".repeat(20), "x".repeat(20), "x".repeat(10)]);
  });

  it("closes and reopens code fences across chunks", () => {
    const code = Array.from({ length: 10 }, (_, i) => `line ${i}`).join("\n");
    const chunks = splitMrkdwn(`intro\n\`\`\`\n${code}\n\`\`\``, 40);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(40);
      expect((c.match(/```/g) ?? []).length % 2).toBe(0);
    }
  });

  it("never splits a surrogate pair", () => {
    const chunks = splitMrkdwn("😀".repeat(15), 7);
    for (const c of chunks) expect(c).not.toMatch(/[\uD800-\uDBFF]$/);
    expect(chunks.join("")).toBe("😀".repeat(15));
  });
});
