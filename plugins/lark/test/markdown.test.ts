import { describe, expect, it } from "vitest";
import { escapePlain, splitMarkdown, toCardMarkdown } from "../src/markdown.js";

/** 卡片 Markdown 里能 @ 人的只有 `<at …></at>` 标签（https://open.larksuite.com/document/uAjLw4CM/ukzMukzMukzM/feishu-cards/card-json-v2-components/content-components/rich-text ）。 */
const AT_TAG = /<\s*at[\s>/]/i;

describe("toCardMarkdown", () => {
  it("keeps standard Markdown (headings, emphasis, lists, quotes, links, newlines, indentation)", () => {
    const md = [
      "# Title",
      "**bold** *it* ~~del~~",
      "- item",
      "  - nested",
      "1. one",
      "> quote",
      "[docs](https://open.larksuite.com/document)",
      "",
      "    indented line",
    ].join("\n");
    expect(toCardMarkdown(md)).toBe(md);
  });

  it("keeps fenced code blocks and inline code byte-for-byte (generics, HTML, ampersands)", () => {
    const md =
      "Use `List<String> & co`:\n```ts\nconst a: Map<K, V> = new Map();\nif (a && b) {}\n```";
    expect(toCardMarkdown(md)).toBe(md);
  });

  it("escapes < and & outside code so model text cannot inject Lark tags", () => {
    expect(toCardMarkdown("a < b & c")).toBe("a &#60; b &#38; c");
    expect(toCardMarkdown("<font color='red'>x</font>")).toBe("&#60;font color='red'>x&#60;/font>");
    expect(toCardMarkdown("&#60;at id=all&#62;")).toBe("&#38;#60;at id=all&#38;#62;");
  });

  it("turns <https://…> autolinks into [url](url) instead of mangling them", () => {
    expect(toCardMarkdown("see <https://example.com/a?b=1>")).toBe(
      "see [https://example.com/a?b=1](https://example.com/a?b=1)",
    );
  });

  it("model text can never ping everyone or anyone (<at id=all>, user_id=all, ids=, email=)", () => {
    const attacks = [
      "<at id=all></at>",
      '<at user_id="all"></at>',
      "<AT ID=all></AT>",
      "< at id=all></at>",
      "<at ids=ou_1,ou_2></at>",
      "<at email=a@b.com></at>",
      "hi <at id=all></at> there",
      "[<at id=all></at>](https://a.com)",
      "[x](https://a.com/<at id=all></at>)",
      "`<at id=all></at>`",
      "``x`` <at id=all></at> `y`",
      "```\n<at id=all></at>\n```",
      "~~~\n<at id=all></at>\n~~~",
      "```\nunclosed <at id=all></at>",
      "**<at id=all></at>**",
      "> <at id=all></at>",
      "&lt;at id=all&gt;&lt;/at&gt;",
    ];
    for (const a of attacks) {
      const out = toCardMarkdown(a);
      expect(out, a).not.toMatch(AT_TAG);
    }
  });

  it("plain @all / @everyone stays literal text (cards only mention via <at>)", () => {
    expect(toCardMarkdown("@all @everyone @_user_1")).toBe("@all @everyone @_user_1");
  });

  it("normalises CRLF", () => {
    expect(toCardMarkdown("a\r\nb\rc")).toBe("a\nb\nc");
  });
});

describe("escapePlain", () => {
  it("renders a value literally (no Markdown, no tags)", () => {
    const out = escapePlain("*x* _y_ <at id=all></at> [a](b) # h 2026-10-20");
    expect(out).not.toMatch(AT_TAG);
    expect(out).toBe("\\*x\\* \\_y\\_ &#60;at id=all\\>&#60;/at\\> \\[a\\]\\(b\\) # h 2026-10-20");
    expect(escapePlain("# title\n- item\n+ x")).toBe("\\# title\n\\- item\n\\+ x");
  });
});

describe("splitMarkdown", () => {
  it("returns short text unchanged", () => {
    expect(splitMarkdown("hello", 100)).toEqual(["hello"]);
  });

  it("packs lines into chunks within the limit", () => {
    const text = Array.from({ length: 30 }, (_, i) => `line ${i} ${"x".repeat(20)}`).join("\n");
    const parts = splitMarkdown(text, 200);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(200);
    expect(parts.join("\n").replace(/\n+/g, "\n")).toBe(text);
  });

  it("closes and reopens a code fence cut in the middle", () => {
    const code = Array.from({ length: 40 }, (_, i) => `console.log(${i});`).join("\n");
    const parts = splitMarkdown(`intro\n\`\`\`js\n${code}\n\`\`\``, 200);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) {
      expect(p.length).toBeLessThanOrEqual(200);
      expect((p.match(/^```/gm) ?? []).length % 2, p).toBe(0);
    }
  });

  it("never cuts an entity or a surrogate pair in half", () => {
    const text = `${"&#60;".repeat(100)}${"😀".repeat(100)}`;
    const parts = splitMarkdown(text, 63);
    for (const p of parts) {
      expect(p.length).toBeLessThanOrEqual(63);
      expect(p).not.toMatch(/&#?\d*$/);
      expect(p).not.toMatch(/^\d*;/);
      expect(/[\uD800-\uDBFF]$/.test(p)).toBe(false);
    }
    expect(parts.join("")).toBe(text);
  });
});
