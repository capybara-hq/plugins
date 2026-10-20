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

describe("toCardMarkdown: links (only http(s) and mailto become links)", () => {
  it("keeps http(s) and mailto links", () => {
    expect(toCardMarkdown("[docs](https://open.larksuite.com/a?b=1&c=2)")).toBe(
      "[docs](https://open.larksuite.com/a?b=1&c=2)",
    );
    expect(toCardMarkdown("[mail](mailto:a@b.example)")).toBe("[mail](mailto:a@b.example)");
  });

  it("renders links with other schemes, images and reference links as literal text", () => {
    for (const [input, shown] of [
      ["[x](javascript:alert(1))", "\\[x\\](javascript:alert(1))"],
      ["[x](lark://applink/open)", "\\[x\\](lark://applink/open)"],
      ["[x](data:text/html,hi)", "\\[x\\](data:text/html,hi)"],
      ["![img](img_v2_key)", "!\\[img\\](img_v2_key)"],
      ["[x][1]\n[1]: javascript:alert(1)", "\\[x\\]\\[1\\]\n\\[1\\]: javascript:alert(1)"],
    ] as const) {
      const out = toCardMarkdown(input);
      expect(out, input).toBe(shown);
      expect(out, input).not.toMatch(/(?<!\\)\]\(/);
    }
  });

  it("backslash-prefixed vectors cannot unescape the brackets into a live link", () => {
    for (const input of [
      "\\[x\\](javascript:alert(1))",
      "\\[x\\](lark://applink/open)",
      "\\\\[x\\\\](javascript:alert(1))",
      "\\[x](javascript:alert(1))",
      "[x\\](javascript:alert(1))",
      "\\![x](data:text/html,hi)",
      "\\[x\\]\\[1\\]\n\\[1\\]: javascript:alert(1)",
    ]) {
      const out = toCardMarkdown(input);
      // 一个 `]` 前面若有偶数个反斜杠（含 0 个）就是未转义的，后面跟 `(` 即链接
      const live = [...out.matchAll(/(\\*)\]\(([^)\s]*)/g)].filter(
        (m) => (m[1] ?? "").length % 2 === 0 && !/^(https?:\/\/|mailto:)/i.test(m[2] ?? ""),
      );
      expect(live, `${input} → ${out}`).toEqual([]);
      expect(out, input).not.toMatch(/(^|[^\\])(\\\\)*\]:/m);
    }
    expect(toCardMarkdown("a\\b")).toBe("a&#92;b");
  });

  it("encodes ) ] spaces and < > in destinations; no entities inside destinations", () => {
    expect(toCardMarkdown("[w](https://en.wikipedia.org/wiki/Foo_(bar))")).toBe(
      "[w](https://en.wikipedia.org/wiki/Foo_%28bar%29)",
    );
    expect(toCardMarkdown("see <https://a.example/x)y]z?q=1&r=2>")).toBe(
      "see [https://a.example/x)y\\]z?q=1&#38;r=2](https://a.example/x%29y%5Dz?q=1&r=2)",
    );
  });

  it("link labels are escaped like text", () => {
    expect(toCardMarkdown("[<at id=all></at>](https://a.example)")).toBe(
      "[&#60;at id=all>&#60;/at>](https://a.example)",
    );
  });
});

describe("toCardMarkdown: entity-encoded <at inside code", () => {
  it("also neutralizes &#60;at / &lt;at / &#x3c;at in code", () => {
    for (const input of [
      "`&#60;at id=all&#62;&#60;/at&#62;`",
      "```\n&lt;at id=all&gt;&lt;/at&gt;\n```",
      "`&#x3C;at id=all&#x3E;`",
    ]) {
      const out = toCardMarkdown(input);
      expect(out, input).not.toMatch(/&(#0*60|#x0*3c|lt);?\s*\/?\s*at/i);
      expect(out.replace(/\u200b/g, ""), input).toBe(input);
    }
  });
});

describe("toCardMarkdown: fence tracking follows CommonMark", () => {
  const LIVE = /<font|(?<!\\)\](?:\(lark:|\(javascript:)/i;

  it("a line like ```a``` is an inline code span, not a fence opener", () => {
    const input =
      "```a```\n[click](lark://applink/x) <font color=red>hi</font> [j](javascript:alert(1))";
    const out = toCardMarkdown(input);
    expect(out).not.toMatch(LIVE);
    expect(out).toContain("&#60;font color=red>");
    expect(out).toContain("\\[click\\](lark://applink/x)");
  });

  it("a shorter fence line does not close a longer fence", () => {
    const input = "````\n```\n````\n<font color='red'>APPROVED</font> [open](lark://x)";
    const out = toCardMarkdown(input);
    expect(out).not.toMatch(LIVE);
    expect(out.split("\n").slice(0, 3)).toEqual(["````", "```", "````"]);
  });

  it("a closer must use the opener's character and have only whitespace after it", () => {
    for (const input of [
      "~~~\n```\n~~~\n<font color=red>x</font>",
      "```\n~~~\n```\n<font color=red>x</font>",
      "~~~~\n~~~\n~~~~  \n<font color=red>x</font>",
      "```\n```js\n```\n<font color=red>x</font>",
    ]) {
      const out = toCardMarkdown(input);
      expect(out, input).not.toMatch(LIVE);
      expect(out.split("\n").slice(0, 3), input).toEqual(input.split("\n").slice(0, 3));
    }
  });

  it("a longer closer closes; a tilde info string may contain backticks", () => {
    expect(toCardMarkdown("```\n<b>\n`````\n<b>")).toBe("```\n<b>\n`````\n&#60;b>");
    expect(toCardMarkdown("~~~ a`b\n<b>\n~~~\n<b>")).toBe("~~~ a`b\n<b>\n~~~\n&#60;b>");
  });

  it("an indented (4+ spaces) fence-like line is not a fence", () => {
    expect(toCardMarkdown("    ```\n<b>")).toBe("    ```\n&#60;b>");
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

  it("does not cut inside an inline code span", () => {
    const line = `${"word ".repeat(30)}\`a code span that must stay whole\` ${"tail ".repeat(30)}`;
    const parts = splitMarkdown(line, 170);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) {
      expect(p.length).toBeLessThanOrEqual(170);
      expect((p.match(/`/g) ?? []).length % 2, p).toBe(0);
    }
  });

  /** 测试自带的 CommonMark 围栏判定：返回每行是否在代码块里（含围栏行本身），以及末尾是否仍未收尾。 */
  const fenceState = (s: string) => {
    let open: { c: string; n: number } | undefined;
    for (const line of s.split("\n")) {
      if (open === undefined) {
        const m = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
        if (m && !(m[1]?.startsWith("`") && m[2]?.includes("`")))
          open = { c: (m[1] ?? "")[0] ?? "", n: (m[1] ?? "").length };
      } else {
        const m = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
        if (m && m[1]?.[0] === open.c && (m[1]?.length ?? 0) >= open.n) open = undefined;
      }
    }
    return open;
  };

  it("reopens a longer / tilde fence with the same marker and closes it the same way", () => {
    for (const marker of ["````", "~~~~"]) {
      const body = Array.from({ length: 40 }, (_, i) => (i % 5 === 0 ? "```" : `line ${i}`));
      const text = `${marker}md\n${body.join("\n")}\n${marker}\n&#60;font>after`;
      const parts = splitMarkdown(text, 120);
      expect(parts.length).toBeGreaterThan(2);
      for (const [i, p] of parts.entries()) {
        expect(p.length).toBeLessThanOrEqual(120);
        expect(fenceState(p), p).toBeUndefined();
        if (i > 0 && i < parts.length - 1) expect(p.startsWith(`${marker}md\n`), p).toBe(true);
      }
      expect(parts.at(-1)?.endsWith(`${marker}\n&#60;font>after`)).toBe(true);
    }
  });

  it("an inline ```a``` line does not make the splitter open a fence", () => {
    const text = `\`\`\`a\`\`\`\n${Array.from({ length: 30 }, (_, i) => `text ${i}`).join("\n")}`;
    for (const p of splitMarkdown(text, 60)) expect(p).not.toMatch(/^[`~]{3,}$/m);
  });
});
