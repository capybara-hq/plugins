import { describe, expect, it } from "vitest";
import {
  escapeHtml,
  markdownToTelegramHtml as md,
  splitHtml,
  TEXT_LIMIT,
} from "../src/html.js";

const WJ = "⁠";

const visible = (html: string) =>
  html
    .replace(/<[^>]*>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");

function wellFormed(html: string): boolean {
  const stack: string[] = [];
  for (const m of html.matchAll(/<(\/?)([a-z-]+)[^>]*>/g)) {
    if (m[1] === "") stack.push(m[2] ?? "");
    else if (stack.pop() !== m[2]) return false;
  }
  return stack.length === 0 && !/<(?![a-z/])/.test(html) && !/&(?!(amp|lt|gt|quot);)/.test(html);
}

describe("markdownToTelegramHtml", () => {
  it("escapes HTML in text", () => {
    expect(md("<script>alert(1)</script>")).toBe("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(md("a < b & c")).toBe("a &lt; b &amp; c");
  });

  it("converts the supported inline formats", () => {
    expect(md("**b** *i* ~~s~~ `c`")).toBe("<b>b</b> <i>i</i> <s>s</s> <code>c</code>");
    expect(md("***x***")).toBe("<b><i>x</i></b>");
    expect(md("`a<b>&`")).toBe("<code>a&lt;b&gt;&amp;</code>");
  });

  it("does not emit mis-nested tags", () => {
    for (const s of ["**a *b** c*", "~~a **b~~ c**", "*a **b* c**"]) {
      expect(wellFormed(md(s))).toBe(true);
    }
  });

  it("converts https links and escapes the href", () => {
    expect(md("[x](https://e.com)")).toBe('<a href="https://e.com">x</a>');
    expect(md('[x](https://e.com/?a=1&b="2")')).toBe(
      '<a href="https://e.com/?a=1&amp;b=&quot;2&quot;">x</a>',
    );
    expect(md("<https://e.com/a>")).toBe('<a href="https://e.com/a">https://e.com/a</a>');
  });

  it("leaves non-http links and images as plain escaped text", () => {
    expect(md("[x](tg://user?id=1)")).toBe("[x](tg://user?id=1)");
    expect(md("[x](javascript:alert(1))")).not.toContain("<a");
    expect(md("![alt](https://e.com/i.png)")).toBe("![alt](https://e.com/i.png)");
  });

  it("neutralises mentions outside code and hrefs", () => {
    expect(md("ping @everyone_team")).toBe(`ping @${WJ}everyone_team`);
    expect(md("`@alice`")).toBe("<code>@alice</code>");
    expect(md("```\n@alice\n```")).toBe("<pre>@alice</pre>");
    expect(md("[x](https://e.com/@u)")).toBe('<a href="https://e.com/@u">x</a>');
    expect(md("[@bob](https://e.com)")).toBe(`<a href="https://e.com">@${WJ}bob</a>`);
    expect(md("mail me @ home")).toBe("mail me @ home");
  });

  it("neutralises mentions hidden behind formatting", () => {
    for (const s of [
      "@**x**",
      "@`x`",
      "@[x](https://e.com)",
      "@~~x~~",
      "@__x__",
      "@*x*",
      "@***x***",
    ]) {
      const out = md(s);
      expect(visible(out)).not.toMatch(/@[A-Za-z0-9_]/);
      expect(wellFormed(out)).toBe(true);
    }
  });

  it("leaves emails and URLs intact", () => {
    expect(md("write a@b.c")).toBe("write a@b.c");
    expect(md("see https://medium.com/@user/post now")).toBe(
      "see https://medium.com/@user/post now",
    );
    expect(md("https://medium.com/@user/post @bob")).toBe(
      `https://medium.com/@user/post @${WJ}bob`,
    );
  });

  it("neutralises a mention glued to a bare URL by punctuation Telegram ends the URL at", () => {
    expect(md("see https://x.com,@bob")).toBe(`see https://x.com,@${WJ}bob`);
    expect(md("(https://x.com)@bob")).toBe(`(https://x.com)@${WJ}bob`);
    expect(md("https://x.com、@bob")).toBe(`https://x.com、@${WJ}bob`);
    expect(md("https://user@x.com/a")).toBe("https://user@x.com/a");
  });

  it("supports one level of parentheses in link URLs", () => {
    expect(md("[x](https://en.wikipedia.org/wiki/Foo_(bar)) after")).toBe(
      '<a href="https://en.wikipedia.org/wiki/Foo_(bar)">x</a> after',
    );
  });

  it("converts fenced code with and without a language", () => {
    expect(md("```ts\nlet a = 1 < 2;\n```")).toBe(
      '<pre><code class="language-ts">let a = 1 &lt; 2;</code></pre>',
    );
    expect(md("```\nx\n```")).toBe("<pre>x</pre>");
    expect(md("```js\nunclosed")).toBe('<pre><code class="language-js">unclosed</code></pre>');
    expect(md('```a"><b\nx\n```')).not.toContain('"><b');
  });

  it("converts headings, lists and quotes", () => {
    expect(md("## Title")).toBe("<b>Title</b>");
    expect(md("- one\n* two\n1. three")).toBe("• one\n• two\n1. three");
    expect(md("> a\n> **b**\nplain")).toBe("<blockquote>a\n<b>b</b></blockquote>\nplain");
  });
});

describe("escapeHtml", () => {
  it("escapes & < >", () => {
    expect(escapeHtml("<a & b>")).toBe("&lt;a &amp; b&gt;");
  });
});

describe("splitHtml", () => {
  it("returns short html unchanged", () => {
    expect(splitHtml("<b>hi</b>")).toEqual(["<b>hi</b>"]);
  });

  it("splits long text with bold spans into well-formed parts within the limit", () => {
    const html = md(Array.from({ length: 1200 }, (_, i) => `**w${i}** word`).join(" "));
    expect(visible(html).length).toBeGreaterThan(10_000);
    const parts = splitHtml(html);
    expect(parts.length).toBeGreaterThan(2);
    for (const p of parts) {
      expect(visible(p).length).toBeLessThanOrEqual(TEXT_LIMIT);
      expect(wellFormed(p)).toBe(true);
    }
    expect(parts.map(visible).join(" ").replace(/\s+/g, " ")).toBe(
      visible(html).replace(/\s+/g, " "),
    );
  });

  it("closes and reopens a bold span cut in the middle", () => {
    const parts = splitHtml(`<b>${"ab ".repeat(10)}</b>`, 12);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) {
      expect(p.startsWith("<b>")).toBe(true);
      expect(p.endsWith("</b>")).toBe(true);
      expect(visible(p).length).toBeLessThanOrEqual(12);
    }
  });

  it("splits an oversized code block into several pre parts", () => {
    const html = md(
      `\`\`\`py\n${Array.from({ length: 2000 }, (_, i) => `x = ${i} < 3`).join("\n")}\n\`\`\``,
    );
    const parts = splitHtml(html);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) {
      expect(p.startsWith('<pre><code class="language-py">')).toBe(true);
      expect(p.endsWith("</code></pre>")).toBe(true);
      expect(visible(p).length).toBeLessThanOrEqual(TEXT_LIMIT);
      expect(wellFormed(p)).toBe(true);
    }
  });

  it("counts entities as one visible character and never cuts inside one", () => {
    const parts = splitHtml("&amp;".repeat(25), 10);
    expect(parts).toEqual(["&amp;".repeat(10), "&amp;".repeat(10), "&amp;".repeat(5)]);
  });

  it("counts UTF-16 code units and keeps surrogate pairs whole", () => {
    const parts = splitHtml("😀".repeat(7), 5);
    for (const p of parts) {
      expect(p.length).toBeLessThanOrEqual(5);
      expect(p).toMatch(/^(?:😀)+$/u);
    }
    expect(parts.join("")).toBe("😀".repeat(7));
  });

  it("keeps a link whole and reopens it across a cut", () => {
    const parts = splitHtml('<a href="https://e.com">aaaa bbbb cccc</a>', 6);
    for (const p of parts) {
      expect(p.startsWith('<a href="https://e.com">')).toBe(true);
      expect(wellFormed(p)).toBe(true);
    }
  });
});
