/**
 * Sanitizer for agent-produced HTML (the html previewer and docx). The embed holds an embed token,
 * so the output must stay inert: no script, no event handlers, no navigation, no network loads.
 *
 * Layers, each enough on its own for its class of attack:
 * 1. DOMPurify with an explicit config (below): drops script, frames, plugins, forms, meta, base,
 *    link, MathML and every `on*` attribute; checks URL attributes against its scheme allowlist.
 * 2. Our hooks: every URL-bearing attribute is removed unless it is inline media (`data:image/…`
 *    and friends) or an in-document fragment; links keep their text and get the URL as `title`
 *    instead of an `href`, so nothing can navigate the single-page embed.
 * 3. CSS (the `<style>` elements and `style` attributes) goes through a CSS Syntax Level 3
 *    tokenizer: declarations and at-rules whose tokens could load anything (`@import`, `url()`,
 *    `image-set()`, `src()`, …) or run anything (`expression()`) are dropped, then the result is
 *    re-tokenized and dropped whole if a single such token is left. Tokenization is context free,
 *    so escapes (`\40import`, `u\72l(`) and comments cannot hide a load from this check.
 * 4. The result is never serialized and re-parsed (no mXSS round trip): DOMPurify returns nodes
 *    and we append those nodes into a shadow root, so the page's styles cannot reach the embed UI.
 * The embed CSP blocks external loads as well; detection here drives the "not loaded" notice.
 */
import DOMPurify, { type Config } from "dompurify";

export interface SanitizedHtml {
  /** The document's `<head>` and `<body>` elements, inert and adopted into the target document. */
  fragment: DocumentFragment;
  /** The document's `<style>` contents, cleaned of anything that loads or runs. */
  styles: string[];
  /**
   * Something that would have loaded or run was removed, so the notice "external resources and
   * scripts are not loaded" is true: a script element, an `on*` handler, a `javascript:` /
   * `vbscript:` URL, CSS `expression()`, a stylesheet link, a frame or plugin, or a remote or
   * relative `src` / `href` / `url()` / `@import`. Mere pointers (`ping`, `action`, `cite`) do not
   * count, nor do dropped `<meta>` / `<base>` / forms.
   */
  external: boolean;
}

const SVG_NS = "http://www.w3.org/2000/svg";

/**
 * Explicit DOMPurify config. Every option that matters is spelled out, not left to defaults.
 * - WHOLE_DOCUMENT: html input is a full document; its `<head>` styles must survive.
 * - RETURN_DOM_FRAGMENT: hand back nodes, never a string (no serialize / re-parse mXSS).
 * - USE_PROFILES: html + svg (+ filters). No MathML: it adds namespace-confusion surface and
 *   agent html rarely needs it.
 * - FORBID_TAGS: on top of DOMPurify's own refusals (script, iframe, object, embed, …), the
 *   elements that navigate, load, or hide content from the sanitizer.
 * - FORBID_ATTR: attributes that navigate, submit, or ping even without a URL check failing.
 */
const PURIFY_CONFIG: Config & { RETURN_DOM_FRAGMENT: true } = {
  WHOLE_DOCUMENT: true,
  RETURN_DOM_FRAGMENT: true,
  USE_PROFILES: { html: true, svg: true, svgFilters: true },
  FORBID_TAGS: [
    "script",
    "noscript",
    "iframe",
    "frame",
    "frameset",
    "object",
    "embed",
    "applet",
    "portal",
    "fencedframe",
    "form",
    "base",
    "meta",
    "link",
    "title",
    "template",
    "noembed",
    "noframes",
    "xmp",
    "plaintext",
    "math",
    "foreignobject",
    "use",
    "animate",
    "animatemotion",
    "animatetransform",
    "animatecolor",
    "set",
  ],
  FORBID_ATTR: [
    "action",
    "formaction",
    "formmethod",
    "formtarget",
    "formenctype",
    "formnovalidate",
    "form",
    "target",
    "ping",
    "download",
    "srcdoc",
    "manifest",
    "is",
    "attributename",
    // the top layer escapes the frame's clip: no script-free way to open popovers or dialogs
    "popover",
    "popovertarget",
    "popovertargetaction",
    "command",
    "commandfor",
    "interestfor",
    // media starting on its own is the page acting without the person
    "autoplay",
  ],
  ALLOW_UNKNOWN_PROTOCOLS: false,
  ALLOW_DATA_ATTR: true,
  ALLOW_ARIA_ATTR: true,
  SAFE_FOR_XML: true,
  SANITIZE_DOM: true,
  KEEP_CONTENT: true,
};

/** Elements whose mere presence means the page wanted to run or load something we dropped. */
const LOADING_ELEMENTS = new Set([
  "script",
  "iframe",
  "frame",
  "frameset",
  "object",
  "embed",
  "applet",
  "portal",
  "fencedframe",
]);

/** Attributes that carry a URL the browser may load or follow. */
const URL_ATTRS = new Set([
  "src",
  "srcset",
  "imagesrcset",
  "href",
  "xlink:href",
  "poster",
  "background",
  "lowsrc",
  "dynsrc",
  "longdesc",
  "data",
  "code",
  "codebase",
  "archive",
  "classid",
  "icon",
  "action",
  "formaction",
  "ping",
  "cite",
  "profile",
  "usemap",
]);

/** URL attributes that only point somewhere (followed, pinged, cited): never a load on render. */
const POINTER_ATTRS = new Set([
  "action",
  "formaction",
  "ping",
  "cite",
  "longdesc",
  "profile",
  "usemap",
]);

/** Elements whose `href` is a link (followed on click) rather than a resource reference. */
const LINK_ELEMENTS = new Set(["a", "area"]);

type RefKind = "empty" | "fragment" | "inline" | "remote" | "script" | "other";

/**
 * The URL as the WHATWG URL parser reads it before looking for a scheme: C0 controls and spaces
 * trimmed from the two ends only, tab / LF / CR removed anywhere, then lowercased. Any other
 * control or space inside (`d\1 ata:`, `da ta:`) stays, so the value is no scheme at all: a
 * relative, same-origin URL, which is a load.
 */
export function normalizeUrl(value: string): string {
  return (
    value
      // biome-ignore lint/suspicious/noControlCharactersInRegex: the URL parser's own trim set
      .replace(/^[\u0000-\u0020]+|[\u0000-\u0020]+$/g, "")
      .replace(/[\t\n\r]/g, "")
      .toLowerCase()
  );
}

/**
 * Classifies a URL the way a browser resolves it (see `normalizeUrl`). A local reference is only
 * a value whose raw first character is `#` (CSS and svg treat exactly that as same-document);
 * `\1 #x` or ` #x` parse as relative URLs to the embed page, a load.
 */
export function refKind(value: string): RefKind {
  if (value.startsWith("#")) return "fragment";
  const v = normalizeUrl(value);
  if (v === "") return "empty";
  if (v.startsWith("data:")) return "inline";
  const scheme = /^([a-z][a-z0-9+.-]*):/.exec(v);
  // relative and protocol-relative URLs resolve against the embed: a load like any other
  if (!scheme) return "remote";
  if (scheme[1] === "javascript" || scheme[1] === "vbscript") return "script";
  return ["http", "https", "ftp", "ftps", "ws", "wss"].includes(scheme[1] ?? "")
    ? "remote"
    : "other";
}

/** Inline media an `<img>` / `<video>` / `<audio>` / svg `<image>` may show: never a document. */
function isInlineMedia(value: string): boolean {
  return /^data:(image|audio|video)\//.test(normalizeUrl(value));
}

/**
 * The candidate URLs of a `srcset`, split the way the HTML srcset parser does: a URL runs to the
 * next whitespace (trailing commas end the candidate), its descriptors to the next comma outside
 * parentheses. So commas inside a `data:` URL stay in the URL.
 */
export function srcsetUrls(srcset: string): string[] {
  const urls: string[] = [];
  const ws = /[\t\n\f\r ]/;
  let i = 0;
  while (i < srcset.length) {
    while (i < srcset.length && (ws.test(srcset[i] ?? "") || srcset[i] === ",")) i++;
    if (i >= srcset.length) break;
    let end = i;
    while (end < srcset.length && !ws.test(srcset[end] ?? "")) end++;
    let url = srcset.slice(i, end);
    i = end;
    if (url.endsWith(",")) {
      url = url.replace(/,+$/, "");
    } else {
      let depth = 0;
      for (; i < srcset.length; i++) {
        const c = srcset[i];
        if (c === "(") depth++;
        else if (c === ")" && depth > 0) depth--;
        else if (c === "," && depth === 0) break;
      }
    }
    if (url !== "") urls.push(url);
  }
  return urls;
}

/** Keeps the purify instance's per-call state: one instance per call, so no global hooks. */
interface Scan {
  external: boolean;
  links: WeakMap<Element, string>;
}

function handleUrlAttr(node: Element, name: string, value: string, scan: Scan): boolean {
  const tag = node.localName.toLowerCase();
  const kind = refKind(value);
  if ((name === "href" || name === "xlink:href") && LINK_ELEMENTS.has(tag)) {
    // a link keeps its text and shows where it pointed as a tooltip; it never navigates
    if (kind === "script") scan.external = true;
    if (kind === "remote" || /^(mailto|tel):/i.test(value.trim())) scan.links.set(node, value);
    return false;
  }
  if (name === "srcset" || name === "imagesrcset") {
    // candidate lists are not worth parsing: dropped; any non-inline candidate counts as external
    if (srcsetUrls(value).some((u) => !normalizeUrl(u).startsWith("data:"))) {
      scan.external = true;
    }
    return false;
  }
  if (name === "src" || name === "href" || name === "xlink:href" || name === "poster") {
    if (isInlineMedia(value)) return true;
    // svg paint servers and gradients reference each other by fragment
    if (name !== "src" && name !== "poster" && kind === "fragment") return true;
  }
  if ((kind === "remote" && !POINTER_ATTRS.has(name)) || kind === "script") scan.external = true;
  return false;
}

/** Runs DOMPurify over a whole html document and returns inert nodes for `doc`. */
export function sanitizeHtml(html: string, doc: Document): SanitizedHtml {
  const win = doc.defaultView;
  if (!win) throw new Error("sanitizeHtml needs a document with a window");
  const purify = DOMPurify(win);
  // an unsupported environment would hand the input back unsanitized: refuse instead
  if (!purify.isSupported) throw new Error("This browser cannot sanitize html");
  const scan: Scan = { external: false, links: new WeakMap() };

  purify.addHook("uponSanitizeElement", (node, data) => {
    const tag = data.tagName;
    if (LOADING_ELEMENTS.has(tag)) scan.external = true;
    if (tag === "link" && (node as Element).hasAttribute?.("href")) {
      scan.external = true;
    }
  });

  purify.addHook("uponSanitizeAttribute", (node, data) => {
    const name = data.attrName;
    // every `on*` attribute is an event handler; DOMPurify drops it, the notice must say so
    if (name.startsWith("on")) {
      scan.external = true;
      data.keepAttr = false;
      return;
    }
    if (URL_ATTRS.has(name)) {
      data.keepAttr = handleUrlAttr(node, name, data.attrValue, scan);
      return;
    }
    if (name === "style") {
      const css = sanitizeCss(data.attrValue, "declarations");
      if (css.external) scan.external = true;
      if (css.text.trim() === "") data.keepAttr = false;
      else data.attrValue = css.text;
      return;
    }
    // svg presentation attributes (fill, filter, clip-path, mask, marker-*, cursor) take url()
    if (node.namespaceURI === SVG_NS) {
      const verdict = scanTokens(tokenize(preprocess(data.attrValue)));
      if (verdict.bad) {
        if (verdict.external) scan.external = true;
        data.keepAttr = false;
      }
    }
  });

  purify.addHook("afterSanitizeAttributes", (node) => {
    if (node.nodeType !== 1) return;
    const href = scan.links.get(node);
    if (href !== undefined && !node.hasAttribute("title")) node.setAttribute("title", href);
  });

  const fragment = purify.sanitize(html, PURIFY_CONFIG);

  // the styles leave the tree: they are cleaned and mounted as the shadow root's own `<style>`s
  const styles: string[] = [];
  for (const style of Array.from(fragment.querySelectorAll("style"))) {
    const css = sanitizeCss(style.textContent ?? "", "stylesheet");
    if (css.external) scan.external = true;
    if (css.text.trim() !== "") styles.push(css.text);
    style.remove();
  }

  return { fragment: doc.adoptNode(fragment), styles, external: scan.external };
}

/** The host page's own frame around a sanitized document: clips it and contains fixed boxes. */
const FRAME_STYLE =
  "position:relative;contain:layout paint style;isolation:isolate;overflow:auto;height:100%";

/**
 * The document renders as it would on its own (light canvas, browser default font), not in the
 * embed's theme: `all: initial` stops the embed's inherited color and font at the host.
 */
const HOST_CSS =
  ":host{all:initial;display:block;min-height:100%;color:CanvasText;background:Canvas;color-scheme:light}";

/**
 * Mounts a sanitized document into a shadow root under `root`: its `<head>` / `<body>` inside an
 * `<html>` element, so the page's `html` / `body` rules match there and nowhere else. The frame
 * around the host lives in the light DOM where page CSS cannot reach it; `contain: paint` keeps
 * `position: fixed` boxes inside it, so a page cannot draw over the embed's own controls.
 */
export function mountSanitized(root: HTMLElement, result: SanitizedHtml): ShadowRoot {
  const doc = root.ownerDocument;
  const frame = doc.createElement("div");
  frame.className = "cap-html-frame";
  frame.style.cssText = FRAME_STYLE;
  const host = doc.createElement("div");
  host.className = "cap-html-host";
  frame.append(host);
  root.append(frame);
  const shadow = host.attachShadow({ mode: "open" });
  const base = doc.createElement("style");
  base.textContent = HOST_CSS;
  const page = result.styles.map((css) => {
    const el = doc.createElement("style");
    el.textContent = css;
    return el;
  });
  const htmlEl = doc.createElement("html");
  htmlEl.append(result.fragment);
  shadow.append(base, ...page, htmlEl);
  return shadow;
}

// ---------------------------------------------------------------------------------------------
// CSS: a CSS Syntax Level 3 tokenizer (https://www.w3.org/TR/css-syntax-3/#tokenization), just
// enough structure to drop the offending declarations, and a final whole-output token check.

type TokType =
  | "ws"
  | "comment"
  | "str"
  | "badstr"
  | "url"
  | "badurl"
  | "ident"
  | "func"
  | "at"
  | "hash"
  | "num"
  | "delim"
  | "cdo"
  | "cdc"
  | ":"
  | ";"
  | ","
  | "["
  | "]"
  | "("
  | ")"
  | "{"
  | "}";

interface Tok {
  t: TokType;
  start: number;
  end: number;
  /** Decoded value: string contents, url, ident / function / at-keyword name. */
  v: string;
}

/** CSS input preprocessing: newlines normalized, NUL and surrogates replaced. */
function preprocess(css: string): string {
  return css
    .replace(/\r\n?|\f/g, "\n")
    .replaceAll(String.fromCharCode(0), "\uFFFD")
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "\uFFFD");
}

const isDigit = (c: number) => c >= 0x30 && c <= 0x39;
const isHex = (c: number) => isDigit(c) || (c >= 0x41 && c <= 0x46) || (c >= 0x61 && c <= 0x66);
const isLetter = (c: number) => (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a);
const isIdentStart = (c: number) => isLetter(c) || c === 0x5f || c >= 0x80;
const isIdentChar = (c: number) => isIdentStart(c) || isDigit(c) || c === 0x2d;
const isWs = (c: number) => c === 0x0a || c === 0x09 || c === 0x20;
const isNonPrintable = (c: number) =>
  (c >= 0 && c <= 8) || c === 0x0b || (c >= 0x0e && c <= 0x1f) || c === 0x7f;

/** Single-character tokens. */
const SINGLE: Record<string, TokType> = {
  "(": "(",
  ")": ")",
  ",": ",",
  ":": ":",
  ";": ";",
  "[": "[",
  "]": "]",
  "{": "{",
  "}": "}",
};

/** Tokenizes preprocessed CSS. `NaN` from `charCodeAt` past the end stands for EOF. */
function tokenize(s: string): Tok[] {
  const out: Tok[] = [];
  const n = s.length;
  let i = 0;
  const at = (k: number) => (k < n ? s.charCodeAt(k) : Number.NaN);
  const validEscape = (k: number) => at(k) === 0x5c && at(k + 1) !== 0x0a;
  const startsIdent = (k: number) => {
    const c = at(k);
    if (c === 0x2d) return isIdentStart(at(k + 1)) || at(k + 1) === 0x2d || validEscape(k + 1);
    if (isIdentStart(c)) return true;
    return c === 0x5c && validEscape(k);
  };
  const startsNumber = (k: number) => {
    const c = at(k);
    if (c === 0x2b || c === 0x2d) {
      return isDigit(at(k + 1)) || (at(k + 1) === 0x2e && isDigit(at(k + 2)));
    }
    if (c === 0x2e) return isDigit(at(k + 1));
    return isDigit(c);
  };
  // `i` points just past the backslash
  const consumeEscape = (): string => {
    if (i >= n) return "\uFFFD";
    const c = at(i);
    if (isHex(c)) {
      let hex = "";
      while (hex.length < 6 && isHex(at(i))) hex += s[i++];
      if (isWs(at(i))) i++;
      const cp = Number.parseInt(hex, 16);
      if (cp === 0 || (cp >= 0xd800 && cp <= 0xdfff) || cp > 0x10ffff) return "\uFFFD";
      return String.fromCodePoint(cp);
    }
    i++;
    return String.fromCharCode(c);
  };
  const consumeIdentSeq = (): string => {
    let r = "";
    for (;;) {
      const c = at(i);
      if (isIdentChar(c)) r += s[i++];
      else if (validEscape(i)) {
        i++;
        r += consumeEscape();
      } else return r;
    }
  };
  const consumeBadUrlRemnants = () => {
    for (;;) {
      if (i >= n) return;
      if (at(i) === 0x29) {
        i++;
        return;
      }
      if (validEscape(i)) {
        i++;
        consumeEscape();
      } else i++;
    }
  };
  const consumeUrl = (start: number): Tok => {
    let v = "";
    while (isWs(at(i))) i++;
    for (;;) {
      if (i >= n) return { t: "url", start, end: i, v };
      const c = at(i);
      if (c === 0x29) {
        i++;
        return { t: "url", start, end: i, v };
      }
      if (isWs(c)) {
        while (isWs(at(i))) i++;
        if (i >= n) return { t: "url", start, end: i, v };
        if (at(i) === 0x29) {
          i++;
          return { t: "url", start, end: i, v };
        }
        consumeBadUrlRemnants();
        return { t: "badurl", start, end: i, v };
      }
      if (c === 0x22 || c === 0x27 || c === 0x28 || isNonPrintable(c)) {
        consumeBadUrlRemnants();
        return { t: "badurl", start, end: i, v };
      }
      if (c === 0x5c) {
        if (validEscape(i)) {
          i++;
          v += consumeEscape();
          continue;
        }
        consumeBadUrlRemnants();
        return { t: "badurl", start, end: i, v };
      }
      v += s[i++];
    }
  };
  const consumeIdentLike = (start: number): Tok => {
    const name = consumeIdentSeq();
    if (name.toLowerCase() === "url" && at(i) === 0x28) {
      i++;
      while (isWs(at(i)) && isWs(at(i + 1))) i++;
      const q = isWs(at(i)) ? at(i + 1) : at(i);
      if (q === 0x22 || q === 0x27) return { t: "func", start, end: i, v: name };
      return consumeUrl(start);
    }
    if (at(i) === 0x28) {
      i++;
      return { t: "func", start, end: i, v: name };
    }
    return { t: "ident", start, end: i, v: name };
  };
  const consumeNumeric = (start: number): Tok => {
    if (at(i) === 0x2b || at(i) === 0x2d) i++;
    while (isDigit(at(i))) i++;
    if (at(i) === 0x2e && isDigit(at(i + 1))) {
      i++;
      while (isDigit(at(i))) i++;
    }
    const e = at(i);
    if (e === 0x45 || e === 0x65) {
      if (isDigit(at(i + 1))) i++;
      else if ((at(i + 1) === 0x2b || at(i + 1) === 0x2d) && isDigit(at(i + 2))) i += 2;
      while (isDigit(at(i))) i++;
    }
    if (startsIdent(i)) consumeIdentSeq();
    else if (at(i) === 0x25) i++;
    return { t: "num", start, end: i, v: "" };
  };
  const consumeString = (start: number, quote: number): Tok => {
    let v = "";
    for (;;) {
      if (i >= n) return { t: "str", start, end: i, v };
      const c = at(i);
      if (c === quote) {
        i++;
        return { t: "str", start, end: i, v };
      }
      if (c === 0x0a) return { t: "badstr", start, end: i, v };
      if (c === 0x5c) {
        if (i + 1 >= n) {
          i++;
          continue;
        }
        if (at(i + 1) === 0x0a) {
          i += 2;
          continue;
        }
        i++;
        v += consumeEscape();
        continue;
      }
      v += s[i++];
    }
  };

  while (i < n) {
    const start = i;
    const c = at(i);
    if (c === 0x2f && at(i + 1) === 0x2a) {
      const close = s.indexOf("*/", i + 2);
      i = close === -1 ? n : close + 2;
      out.push({ t: "comment", start, end: i, v: "" });
      continue;
    }
    if (isWs(c)) {
      while (isWs(at(i))) i++;
      out.push({ t: "ws", start, end: i, v: "" });
      continue;
    }
    if (c === 0x22 || c === 0x27) {
      i++;
      out.push(consumeString(start, c));
      continue;
    }
    if (c === 0x23) {
      i++;
      if (isIdentChar(at(i)) || validEscape(i)) {
        const v = consumeIdentSeq();
        out.push({ t: "hash", start, end: i, v });
      } else out.push({ t: "delim", start, end: i, v: "#" });
      continue;
    }
    const t = SINGLE[s[i] ?? ""];
    if (t !== undefined) {
      i++;
      out.push({ t, start, end: i, v: "" });
      continue;
    }
    if (c === 0x2b || c === 0x2e) {
      if (startsNumber(i)) out.push(consumeNumeric(start));
      else {
        i++;
        out.push({ t: "delim", start, end: i, v: s[start] ?? "" });
      }
      continue;
    }
    if (c === 0x2d) {
      if (startsNumber(i)) out.push(consumeNumeric(start));
      else if (at(i + 1) === 0x2d && at(i + 2) === 0x3e) {
        i += 3;
        out.push({ t: "cdc", start, end: i, v: "" });
      } else if (startsIdent(i)) out.push(consumeIdentLike(start));
      else {
        i++;
        out.push({ t: "delim", start, end: i, v: "-" });
      }
      continue;
    }
    if (c === 0x3c && s.startsWith("<!--", i)) {
      i += 4;
      out.push({ t: "cdo", start, end: i, v: "" });
      continue;
    }
    if (c === 0x40) {
      i++;
      if (startsIdent(i)) {
        const v = consumeIdentSeq();
        out.push({ t: "at", start, end: i, v });
      } else out.push({ t: "delim", start, end: i, v: "@" });
      continue;
    }
    if (c === 0x5c) {
      if (validEscape(i)) out.push(consumeIdentLike(start));
      else {
        i++;
        out.push({ t: "delim", start, end: i, v: "\\" });
      }
      continue;
    }
    if (isDigit(c)) {
      out.push(consumeNumeric(start));
      continue;
    }
    if (isIdentStart(c)) {
      out.push(consumeIdentLike(start));
      continue;
    }
    // one code point (a surrogate pair stays together)
    i += c >= 0xd800 && c <= 0xdbff && i + 1 < n ? 2 : 1;
    out.push({ t: "delim", start, end: i, v: s.slice(start, i) });
  }
  return out;
}

/** Functions whose string arguments are URLs the browser loads. */
const URL_FUNCS = new Set([
  "url",
  "src",
  "image-set",
  "-webkit-image-set",
  "image",
  "-webkit-image",
  "cross-fade",
  "-webkit-cross-fade",
  "element",
  "-moz-element",
]);

/** Functions that can feed a URL function a value we cannot see. */
const OPAQUE_FUNCS = new Set(["var", "env", "attr", "if", "inherit"]);

interface Verdict {
  bad: boolean;
  external: boolean;
}

function checkRef(value: string, v: Verdict): void {
  const kind = refKind(value);
  if (kind === "inline" || kind === "fragment") return;
  v.bad = true;
  if (kind === "remote" || kind === "script") v.external = true;
}

/** Whether any token in `toks` could load, import or run something. */
function scanTokens(toks: Tok[]): Verdict {
  const v: Verdict = { bad: false, external: false };
  // depth of the innermost URL function we are in (0 = none), as a paren-depth count
  let depth = 0;
  let urlDepth = 0;
  for (const tok of toks) {
    const name = tok.v.toLowerCase();
    switch (tok.t) {
      case "at":
        if (name === "import") {
          v.bad = true;
          v.external = true;
        }
        // registered fonts and properties can leak out of a shadow tree in some engines
        if (name === "font-face" || name === "property") v.bad = true;
        break;
      case "ident":
        if (name === "@import") {
          v.bad = true;
          v.external = true;
        } else if (name === "-moz-binding" || name === "behavior") v.bad = true;
        break;
      case "url":
        checkRef(tok.v, v);
        break;
      case "badurl":
        v.bad = true;
        break;
      case "str":
      case "badstr":
        if (urlDepth > 0) checkRef(tok.v, v);
        break;
      case "func":
        depth++;
        if (name === "expression") {
          v.bad = true;
          v.external = true;
        }
        if (urlDepth > 0 && (OPAQUE_FUNCS.has(name) || name.startsWith("--"))) v.bad = true;
        if (URL_FUNCS.has(name) && urlDepth === 0) urlDepth = depth;
        break;
      case "(":
      case "[":
        depth++;
        break;
      case ")":
      case "]":
        if (depth > 0) {
          if (depth === urlDepth) urlDepth = 0;
          depth--;
        }
        break;
      default:
        break;
    }
  }
  return v;
}

/** Opening and closing tokens of simple blocks; function tokens open a `(` block. */
function opener(t: TokType): string | undefined {
  if (t === "(" || t === "func") return "(";
  if (t === "[") return "[";
  if (t === "{") return "{";
  return undefined;
}
const CLOSER: Partial<Record<TokType, string>> = { ")": "(", "]": "[", "}": "{" };

/**
 * Drops the statements of `css` that could load or run anything and returns the rest.
 * `stylesheet` is a `<style>` body; `declarations` a `style` attribute. The structure pass follows
 * the CSS parser closely enough to keep the harmless rest; it is not the security boundary: the
 * whole-output token check at the end is.
 */
export function sanitizeCss(
  css: string,
  mode: "stylesheet" | "declarations",
): { text: string; external: boolean } {
  const src = preprocess(css);
  const toks = tokenize(src);
  let external = false;
  const keep: boolean[] = toks.map(() => true);
  // open blocks: "B" a rule body (its `;` `{` `}` are statement boundaries), else "(" "[" "{"
  const stack: string[] = [];
  let segStart = 0;
  const top = () => stack[stack.length - 1];
  const segmentIsAtRule = (from: number, to: number) => {
    for (let k = from; k < to; k++) {
      const t = (toks[k] as Tok).t;
      if (t === "ws" || t === "comment" || t === "cdo" || t === "cdc") continue;
      return t === "at";
    }
    return false;
  };
  const isBoundary = (tok: Tok, k: number): boolean => {
    if (stack.length > 0 && top() !== "B") return false;
    if (tok.t === "{") return true;
    if (tok.t === "}") return stack.length > 0;
    if (tok.t !== ";") return false;
    // at the top of a stylesheet only an at-rule ends at `;`; a qualified rule's prelude runs on
    return stack.length > 0 || mode === "declarations" || segmentIsAtRule(segStart, k);
  };

  for (let k = 0; k <= toks.length; k++) {
    const tok = toks[k];
    if (tok !== undefined && !isBoundary(tok, k)) {
      const open = opener(tok.t);
      if (open !== undefined) stack.push(open);
      else if (CLOSER[tok.t] !== undefined && CLOSER[tok.t] === top()) stack.pop();
      continue;
    }
    const verdict = scanTokens(toks.slice(segStart, k));
    if (verdict.external) external = true;
    if (tok?.t === "{") {
      if (!verdict.bad) {
        stack.push("B");
        segStart = k + 1;
        continue;
      }
      // drop the prelude and its whole block
      const inner = ["B"];
      let m = k + 1;
      for (; m < toks.length && inner.length > 0; m++) {
        const x = toks[m] as Tok;
        const open = opener(x.t);
        if (open !== undefined) inner.push(open);
        else if (x.t === "}" && inner[inner.length - 1] === "B") inner.pop();
        else if (CLOSER[x.t] !== undefined && CLOSER[x.t] === inner[inner.length - 1]) inner.pop();
      }
      if (scanTokens(toks.slice(k, m)).external) external = true;
      for (let d = segStart; d < m; d++) keep[d] = false;
      k = m - 1;
      segStart = m;
      continue;
    }
    if (verdict.bad) {
      // a declaration or a statement at-rule, with its `;`; a block's `}` stays
      const end = tok?.t === ";" ? k + 1 : k;
      for (let d = segStart; d < end; d++) keep[d] = false;
    }
    if (tok?.t === "}") stack.pop();
    segStart = k + 1;
  }

  let text = "";
  for (let k = 0; k < toks.length; k++) {
    const tok = toks[k] as Tok;
    if (keep[k]) text += src.slice(tok.start, tok.end);
  }
  // the safety net: whatever the structure pass decided, no loading token may remain
  if (scanTokens(tokenize(text)).bad) return { text: "", external: true };
  return { text, external };
}
