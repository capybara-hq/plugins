// @vitest-environment jsdom
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { mountSanitized, sanitizeCss, sanitizeHtml } from "../ui-src/app/sanitize.js";

const HOSTILE = join(import.meta.dirname, "fixtures", "hostile");
const fixture = (name: string) => readFileSync(join(HOSTILE, name), "utf8");

/** Whether a fixture references something remote that we expect to be removed and reported. */
const EXTERNAL: Record<string, boolean | "any"> = {
  "anchors.html": false,
  "css-urls.html": true,
  "data-urls.html": true,
  "form.html": true,
  "fragment-refs.html": true,
  "frames.html": true,
  "handlers.html": true,
  "js-urls.html": true,
  "link-stylesheet.html": true,
  "meta-base.html": false,
  // the payloads swallow each other; each line is checked on its own below
  "mxss.html": "any",
  "script.html": true,
  "srcset.html": true,
  "style-attr.html": true,
  "style-import.html": true,
  "svg-refs.html": true,
  "svg-script.html": true,
  "url-whitespace.html": true,
};

const FORBIDDEN_TAGS = [
  "script",
  "iframe",
  "frame",
  "frameset",
  "object",
  "embed",
  "applet",
  "portal",
  "form",
  "base",
  "meta",
  "link",
  "template",
  "noscript",
  "math",
  "use",
  "animate",
  "set",
  "foreignobject",
  "handler",
  "isindex",
];

/** Every element under `root`, through shadow roots. */
function allElements(root: ParentNode): Element[] {
  const out: Element[] = [];
  for (const el of Array.from(root.querySelectorAll("*"))) {
    out.push(el);
    if (el.shadowRoot) out.push(...allElements(el.shadowRoot));
  }
  return out;
}

/** CSS that loads or runs nothing: no import, no url() but data: / fragment, no expression. */
function assertInertCss(css: string) {
  const lower = css.toLowerCase();
  expect(lower).not.toMatch(/@import|\\40|\\69|expression\s*\(|-moz-binding|behavior|javascript:/);
  expect(lower).not.toMatch(/image-set|cross-fade|\bsrc\s*\(/);
  for (const m of lower.matchAll(/url\(\s*(['"]?)\s*([^'")\s]*)/g)) {
    expect(m[2]).toMatch(/^(data:|#)/);
  }
  expect(lower).not.toMatch(/u\\|\\72|\\0*55/);
}

/** The invariants every sanitized document must hold, whatever went in. */
function assertInert(root: ParentNode, styles: string[]) {
  for (const el of allElements(root)) {
    const tag = el.localName.toLowerCase();
    expect(FORBIDDEN_TAGS, `<${tag}> survived`).not.toContain(tag);
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      const value = attr.value;
      expect(name.startsWith("on"), `${tag}[${name}]`).toBe(false);
      expect(value, `${tag}[${name}]`).not.toMatch(/javascript:|vbscript:|data:text\/html/i);
      expect([
        "action",
        "formaction",
        "ping",
        "srcdoc",
        "srcset",
        "target",
        "background",
      ]).not.toContain(name);
      if (name === "href" || name === "xlink:href") {
        expect(["a", "area"], `${tag} keeps a link`).not.toContain(tag);
        expect(value).toMatch(/^(#|data:image\/)/);
      }
      if (["src", "poster", "lowsrc", "dynsrc"].includes(name)) {
        expect(value).toMatch(/^data:(image|audio|video)\//);
      }
      if (name === "style") assertInertCss(value);
      if (el.namespaceURI === "http://www.w3.org/2000/svg" && /url\(/i.test(value)) {
        expect(value).toMatch(/url\(\s*['"]?#/i);
      }
    }
  }
  for (const css of styles) assertInertCss(css);
  for (const style of Array.from(root.querySelectorAll("style")))
    assertInertCss(style.textContent ?? "");
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("sanitizeHtml over hostile fixtures", () => {
  const files = readdirSync(HOSTILE).filter((f) => f.endsWith(".html"));

  it("covers every fixture on disk", () => {
    expect(files.sort()).toEqual(Object.keys(EXTERNAL).sort());
  });

  for (const file of files) {
    it(`${file}: nothing that runs, loads or navigates survives`, () => {
      const result = sanitizeHtml(fixture(file), document);
      expect(result.fragment.ownerDocument).toBe(document);
      expect(result.fragment.querySelectorAll("style")).toHaveLength(0);
      assertInert(result.fragment, result.styles);
      if (EXTERNAL[file] !== "any") expect(result.external).toBe(EXTERNAL[file]);
      // the harmless part of the document is kept
      if (file !== "anchors.html" && file !== "mxss.html")
        expect(result.fragment.textContent).toContain("kept");
      // mounted, the invariants still hold in the live document
      const shadow = mountSanitized(document.body, result);
      assertInert(shadow, []);
    });
  }

  it("mxss.html: each payload on its own is inert", () => {
    const lines = fixture("mxss.html")
      .split("\n")
      .filter((l) => l.trim() !== "");
    expect(lines.length).toBeGreaterThan(5);
    for (const line of lines) {
      const result = sanitizeHtml(line, document);
      assertInert(result.fragment, result.styles);
      assertInert(mountSanitized(document.body, result), []);
    }
  });

  it("keeps the harmless css of a stylesheet and drops the rest", () => {
    const { styles } = sanitizeHtml(fixture("css-urls.html"), document);
    const css = styles.join("\n");
    expect(css).toContain("color: blue");
    expect(css).toContain("color: green");
    expect(css).toContain("url(data:image/png;base64,AAAA)");
    expect(css).toContain("url(#clip)");
    expect(css).not.toContain("evil.example");
    expect(css).not.toContain("@font-face { font-family: f; src");
  });

  it("keeps body rules from a stylesheet that also imports", () => {
    const { styles, external } = sanitizeHtml(fixture("style-import.html"), document);
    expect(external).toBe(true);
    expect(styles.join("")).toContain("body { color: red }");
    expect(styles.join("")).not.toContain("evil.example");
  });

  it("keeps the harmless declarations of a style attribute", () => {
    const { fragment } = sanitizeHtml(fixture("style-attr.html"), document);
    const div = fragment.querySelector("div");
    expect(div?.getAttribute("style")).toBe("color:green");
  });

  it("turns links into non-navigating text with the URL as title", () => {
    const { fragment, external } = sanitizeHtml(fixture("anchors.html"), document);
    expect(external).toBe(false);
    const links = Array.from(fragment.querySelectorAll("a"));
    const x = links.find((a) => a.textContent === "x");
    expect(x?.hasAttribute("href")).toBe(false);
    expect(x?.getAttribute("title")).toBe("https://example.com");
    const frag = links.find((a) => a.textContent === "frag");
    expect(frag?.hasAttribute("href")).toBe(false);
    expect(frag?.hasAttribute("ping")).toBe(false);
    expect(frag?.hasAttribute("target")).toBe(false);
    const mail = links.find((a) => a.textContent === "mail");
    expect(mail?.getAttribute("title")).toBe("mailto:a@example.com");
    expect(mail?.hasAttribute("download")).toBe(false);
    expect(links.find((a) => a.textContent === "y")?.getAttribute("title")).toBe("kept title");
    expect(fragment.querySelector("area")?.hasAttribute("href")).toBe(false);
  });

  it("keeps inline media and in-document svg references", () => {
    const { fragment } = sanitizeHtml(fixture("svg-refs.html"), document);
    const images = Array.from(fragment.querySelectorAll("image"));
    expect(images.map((i) => i.getAttribute("href"))).toEqual([
      null,
      null,
      "data:image/png;base64,AAAA",
    ]);
    expect(fragment.querySelector("#g2")?.getAttribute("href")).toBe("#g");
    const rects = Array.from(fragment.querySelectorAll("rect"));
    expect(rects[0]?.hasAttribute("fill")).toBe(false);
    expect(rects[0]?.getAttribute("filter")).toBe("url(#f)");
    expect(rects[1]?.getAttribute("stroke")).toBe("url(#g)");
    expect(rects[1]?.hasAttribute("mask")).toBe(false);
    const { fragment: pic } = sanitizeHtml(fixture("srcset.html"), document);
    expect(pic.querySelector('img[alt="inline"]')?.getAttribute("src")).toBe(
      "data:image/png;base64,AAAA",
    );
    const { fragment: data } = sanitizeHtml(fixture("data-urls.html"), document);
    expect(data.querySelector('img[alt="svg"]')?.getAttribute("src")).toMatch(
      /^data:image\/svg\+xml/,
    );
    expect(data.querySelector('img[alt="html"]')?.hasAttribute("src")).toBe(false);
    expect(data.querySelector('img[alt="blob"]')?.hasAttribute("src")).toBe(false);
  });

  it("url-whitespace.html: inner controls and spaces never pass for data:", () => {
    const { fragment, styles, external } = sanitizeHtml(fixture("url-whitespace.html"), document);
    expect(external).toBe(true);
    const css = styles.join("\n");
    expect(css).toContain("color: green");
    expect(css).not.toMatch(/ata:|api/);
    const divs = Array.from(fragment.querySelectorAll("div"));
    expect(divs[0]?.getAttribute("style")).toBe("color:green");
    expect(divs[1]?.hasAttribute("style")).toBe(false);
    expect(divs[2]?.hasAttribute("style")).toBe(false);
    for (const rect of Array.from(fragment.querySelectorAll("rect"))) {
      expect(rect.hasAttribute("fill")).toBe(false);
    }
    expect(fragment.querySelector("image")?.hasAttribute("href")).toBe(false);
    expect(fragment.querySelector('img[alt="space"]')?.hasAttribute("src")).toBe(false);
    expect(fragment.querySelector('img[alt="ctl"]')?.hasAttribute("src")).toBe(false);
    // each place on its own sets the flag
    for (const html of [
      '<style>a{background:url("d\\1 ata:image/png,x")}</style>',
      '<div style="background:url(da\\20 ta:image/png,x)">x</div>',
      '<svg><rect fill="url(d\\1 ata:/../api#g)"/></svg>',
    ]) {
      expect(sanitizeHtml(html, document).external, html).toBe(true);
    }
  });

  it("fragment-refs.html: only a raw leading # is a local reference", () => {
    const { fragment, styles, external } = sanitizeHtml(fixture("fragment-refs.html"), document);
    expect(external).toBe(true);
    const css = styles.join("\n");
    expect(css).toContain("url(#ok)");
    expect(css).toContain("color: green");
    expect(css.match(/url\(/g)).toHaveLength(1);
    expect(fragment.querySelector("div")?.getAttribute("style")).toBe("color:green");
    const rects = Array.from(fragment.querySelectorAll("rect"));
    expect(rects.map((r) => r.getAttribute("filter"))).toEqual([null, null, "url(#f)"]);
    expect(fragment.querySelector("#g2")?.hasAttribute("href")).toBe(false);
    for (const html of [
      '<style>a{filter:url("\\1 #x")}</style>',
      "<div style='filter:url(\" #x\")'>x</div>",
      '<svg><rect filter="url(\\1 #f)"/></svg>',
    ]) {
      expect(sanitizeHtml(html, document).external, html).toBe(true);
    }
  });

  it("weighs every srcset candidate for the notice", () => {
    const flag = (srcset: string) => sanitizeHtml(`<img srcset="${srcset}">`, document).external;
    expect(flag("data:image/png;base64,AAAA 1x, https://evil.example/b.png 2x")).toBe(true);
    expect(flag("data:image/png;base64,AAAA 1x,//evil.example/b.png 2x")).toBe(true);
    expect(flag("data:image/png;base64,AAAA 1x, data:image/png;base64,BBBB 2x")).toBe(false);
    expect(flag("data:image/png;base64,AA,AA 1x")).toBe(false);
  });

  it("flags removed handlers and script urls, and drops autoplay", () => {
    expect(sanitizeHtml('<div onclick="x()">a</div>', document).external).toBe(true);
    expect(sanitizeHtml('<a href="javascript:x()">a</a>', document).external).toBe(true);
    const { fragment } = sanitizeHtml(
      '<video autoplay src="data:video/mp4;base64,AAAA"></video>',
      document,
    );
    expect(fragment.querySelector("video")?.hasAttribute("autoplay")).toBe(false);
  });

  it("reports nothing external for a plain document", () => {
    const result = sanitizeHtml("<h1>Title</h1><p style='color:red'>text</p>", document);
    expect(result.external).toBe(false);
    expect(result.fragment.querySelector("p")?.getAttribute("style")).toBe("color:red");
  });
});

describe("sanitizeCss", () => {
  const cases: Array<[string, string]> = [
    ["@import url(https://x/a.css); a{color:red}", " a{color:red}"],
    ['@import "x.css" screen; a{color:red}', " a{color:red}"],
    ["@\\69mport url(https://x/a.css); a{color:red}", " a{color:red}"],
    ["@IMPORT url(https://x/a.css); a{color:red}", " a{color:red}"],
    ["a{background:url(https://x/a.png);color:red}", "a{color:red}"],
    ["a{background:url(  'https://x/a.png'  );color:red}", "a{color:red}"],
    ["a{background:URL(//x/a.png);color:red}", "a{color:red}"],
    ["a{background:u\\72l(//x/a.png);color:red}", "a{color:red}"],
    ["a{background:\\75 rl(//x/a.png);color:red}", "a{color:red}"],
    ["a{background:url(java\\73 cript:alert(1));color:red}", "a{color:red}"],
    ["a{width:expression(alert(1));color:red}", "a{color:red}"],
    ["a{width:EXPRESSION(alert(1));color:red}", "a{color:red}"],
    ["@font-face{font-family:f;src:url(http://x/f.woff)}a{color:red}", "a{color:red}"],
    ['a{background:image-set("https://x/a.png" 1x);color:red}', "a{color:red}"],
    ["a{background:image-set(var(--a) 1x);color:red}", "a{color:red}"],
    ['a{background:src("https://x/a.png");color:red}', "a{color:red}"],
    ["a{background:src(var(--a));color:red}", "a{color:red}"],
    ["a{cursor:url(https://x/c.cur),auto;color:red}", "a{color:red}"],
    ["@media screen{a{background:url(https://x)}b{color:red}}", "@media screen{a{}b{color:red}}"],
    ["@namespace url(https://x); a{color:red}", " a{color:red}"],
    ["a{color:red}@import url(https://x/late.css);", "a{color:red}"],
    ["a{background:url(https://x\\29 );color:red}", "a{color:red}"],
    ["a{background:\\000075rl(https://x);color:red}", "a{color:red}"],
    ["a{background:\\75\\72\\6c(https://x);color:red}", "a{color:red}"],
    ["a{b:f(;);c:url(https://x)}", "a{b:f(;);}"],
    ["a{--x:{;};c:url(https://x)}", "a{--x:{;};}"],
    [
      "@media (min-width:1px){@import url(https://x);a{color:red}}",
      "@media (min-width:1px){a{color:red}}",
    ],
    ["<!--a{background:url(https://x)}-->", "<!--a{}-->"],
    ['a{x:image-set("data:image/png,a" 1x, "https://x" 2x);color:red}', "a{color:red}"],
    [
      "a{background:url(data:image/png,a\\)b)} b{background:url(https://x)}",
      "a{background:url(data:image/png,a\\)b)} b{}",
    ],
    // an escaped paren makes an ident, not a url: the browser loads nothing
    ["a{background:url\\(https://x)}", "a{background:url\\(https://x)}"],
    // the URL parser strips C0 and space only at the ends and tab / LF / CR inside: an inner
    // control or space makes a relative (same-origin) URL, never data:
    ['a{background:url("d\\1 ata:image/png,x");color:red}', "a{color:red}"],
    ["a{background:url(d\\1 ata:/../../../api/v1/me);color:red}", "a{color:red}"],
    ["a{background:url(da\\20 ta:image/png,x);color:red}", "a{color:red}"],
    ['a{background:url("da\\20 ta:image/png,x");color:red}', "a{color:red}"],
    ['a{background:url("da ta:image/png,x");color:red}', "a{color:red}"],
    ['a{background:image-set("d\\1 ata:image/png,x" 1x);color:red}', "a{color:red}"],
    // ...while the ones a browser does strip still read as data:
    ['a{background:url(" \\1 data:image/png,x ")}', 'a{background:url(" \\1 data:image/png,x ")}'],
    ['a{background:url("da\\9 ta:image/png,x")}', 'a{background:url("da\\9 ta:image/png,x")}'],
    // @font-face and @property can leak out of a shadow tree in some engines
    ['@font-face{font-family:f;src:local("x")}a{color:red}', "a{color:red}"],
    ["@property --x{syntax:'*';inherits:true}a{color:red}", "a{color:red}"],
    // a reference is local only when its raw value starts with `#`; anything before the `#`
    // makes a relative URL to the embed page itself
    ['a{filter:url("\\1 #x");color:red}', "a{color:red}"],
    ['a{filter:url(" #x");color:red}', "a{color:red}"],
    ['a{filter:url("\\9 #x");color:red}', "a{color:red}"],
    ["a{filter:url(\\1 #x);color:red}", "a{color:red}"],
    // a url inside an unterminated block or string is still caught by the final check
    ["a{background:url(https://x/a.png", "a{"],
    [
      "a{content:'x;background:url(https://x/a.png)';color:red}",
      "a{content:'x;background:url(https://x/a.png)';color:red}",
    ],
  ];
  for (const [input, expected] of cases) {
    it(`cleans ${JSON.stringify(input)}`, () => {
      const out = sanitizeCss(input, "stylesheet");
      expect(out.text).toBe(expected);
    });
  }

  it("treats strings outside url functions as text, not loads", () => {
    expect(sanitizeCss('a::before{content:"https://x/a.png"}', "stylesheet")).toEqual({
      text: 'a::before{content:"https://x/a.png"}',
      external: false,
    });
  });

  it("keeps data: and fragment urls", () => {
    const css = "a{background:url(data:image/png;base64,AAAA);clip-path:url(#c);mask:url('#m')}";
    expect(sanitizeCss(css, "stylesheet")).toEqual({ text: css, external: false });
  });

  it("reports remote references and script as external, local junk as not", () => {
    expect(sanitizeCss("a{background:url(https://x)}", "stylesheet").external).toBe(true);
    expect(sanitizeCss("a{background:url(rel.png)}", "stylesheet").external).toBe(true);
    // script schemes and expression() are "scripts not loaded": they show the notice too
    expect(sanitizeCss('a{background:url("javascript:alert(1)")}', "stylesheet").external).toBe(
      true,
    );
    expect(sanitizeCss("a{width:expression(1)}", "stylesheet").external).toBe(true);
    // an unquoted url with a `(` inside is a bad-url token: the browser loads nothing
    expect(sanitizeCss("a{background:url(data:x(1))}", "stylesheet")).toEqual({
      text: "a{}",
      external: false,
    });
  });

  it("drops declarations of a style attribute one by one", () => {
    expect(sanitizeCss("color:red;background:url(//x/a.png);width:1px", "declarations").text).toBe(
      "color:red;width:1px",
    );
  });

  it("does not let an escaped @ start an import", () => {
    // `\40import` is an ident, not an at-keyword: the browser reads it and everything up to the
    // next `{` as one (invalid) selector, so the rule it starts goes with it
    const out = sanitizeCss(
      "\\40import url(https://x/a.css); a{color:red} b{color:blue}",
      "stylesheet",
    );
    expect(out.text).toBe(" b{color:blue}");
    expect(out.external).toBe(true);
  });

  it("keeps a whole qualified rule prelude at the top level together", () => {
    // the browser reads `x: url(...); a` as one (invalid) selector; nothing of it may load
    const out = sanitizeCss("x:url(https://x/a.png); a{color:red}", "stylesheet");
    expect(out.text).not.toContain("https://x");
  });
});

describe("mountSanitized", () => {
  it("scopes the page's styles to a shadow root, never the embed's own frame", () => {
    const appRoot = document.createElement("div");
    appRoot.id = "app";
    document.body.append(appRoot);
    const result = sanitizeHtml(
      "<html><head><style>body { color: red } p { margin: 0 }</style></head><body><p>hi</p></body></html>",
      document,
    );
    const shadow = mountSanitized(appRoot, result);
    // the page's <style> lives only in the shadow root; the embed's document has none of it
    const styles = Array.from(shadow.querySelectorAll("style")).map((s) => s.textContent);
    expect(styles.some((s) => s?.includes("body { color: red }"))).toBe(true);
    expect(Array.from(document.querySelectorAll("style"))).toHaveLength(0);
    // the page's `body` selector has its own `<body>` to match, inside the shadow tree
    const pageBody = shadow.querySelector("body");
    expect(pageBody).not.toBeNull();
    expect(pageBody?.matches("body")).toBe(true);
    expect(pageBody).not.toBe(document.body);
    expect(document.body.contains(pageBody)).toBe(false);
    expect(pageBody?.querySelector("p")?.textContent).toBe("hi");
    // the host resets what the embed's theme would otherwise pass down
    expect(styles[0]).toContain(":host{all:initial");
    // the frame around the host clips and contains fixed boxes, and page css cannot reach it
    const frame = appRoot.querySelector(".cap-html-frame") as HTMLElement;
    expect(frame.style.contain).toContain("paint");
    expect(shadow.host.parentElement).toBe(frame);
  });
});
