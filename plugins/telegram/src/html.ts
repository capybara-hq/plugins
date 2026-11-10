/**
 * Markdown -> Telegram HTML (https://core.telegram.org/bots/api#html-style).
 * Supported tags: b, i, s, code, pre (+ code class="language-x"), a href, blockquote. Headings become bold
 * lines, lists use "•" (numbers are kept), tables become lists (tables.ts). Only `&lt;`, `&gt;`, `&amp;` and `&quot;` are valid entities.
 * Telegram's 4096 limit counts the visible text after entity parsing (UTF-16 code units).
 */

import { tablesToLists } from "./tables.js";

export const TEXT_LIMIT = 4096;

/** Escapes `&`, `<`, `>` for Telegram HTML text. */
export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const escapeAttr = (s: string) => escapeHtml(s).replace(/"/g, "&quot;");

/** `<a href="url">url</a>`, escaped. */
export const htmlLink = (url: string): string =>
  `<a href="${escapeAttr(url)}">${escapeHtml(url)}</a>`;

const WORD_JOINER = "\u2060";

/**
 * Keeps a model from pinging people, judged on the visible text of finished HTML: an `@` directly followed
 * by a username character (not preceded by one, so `a@b.c` stays) gets a U+2060 WORD JOINER after it, so
 * Telegram no longer parses a mention. Skips pre / code content and `<a ...>` tags, and sees through
 * formatting tags (`@<b>x</b>` is a mention too; the joiner goes right after the `@`). Inside a bare URL
 * only an `@` right after `/` is kept (`https://medium.com/@user/post`): Telegram ends a URL at
 * punctuation such as `,` `)` `、`, so `https://x.com,@bob` would otherwise leave `@bob` live.
 */
function neutraliseHtmlMentions(html: string): string {
  return html.replace(
    /(<pre[\s\S]*?<\/pre>)|(<code>[\s\S]*?<\/code>)|(<a [^>]*>)|(https?:\/\/[^\s<]+)|(?<![A-Za-z0-9_])@(?=(?:<[^>]+>)*[A-Za-z0-9_])/g,
    (m, pre?: string, code?: string, a?: string, url?: string) =>
      pre || code || a
        ? m
        : url
          ? url.replace(/(?<![A-Za-z0-9_/])@(?=[A-Za-z0-9_])/g, `@${WORD_JOINER}`)
          : `@${WORD_JOINER}`,
  );
}

const HOLD = "\u0000";

/** True when every tag opened inside `s` is closed inside it (and nothing closes an outer tag). */
function balanced(s: string): boolean {
  const stack: string[] = [];
  for (const m of s.matchAll(/<(\/?)([a-z-]+)[^>]*>/g)) {
    if (m[1] === "") stack.push(m[2] ?? "");
    else if (stack.pop() !== m[2]) return false;
  }
  return stack.length === 0;
}

/** Wraps `re` matches (group 1 = content) in `tag`, skipping matches that would straddle other tags. */
function wrap(s: string, re: RegExp, tag: string): string {
  return s.replace(re, (m, inner: string) => (balanced(inner) ? `<${tag}>${inner}</${tag}>` : m));
}

/** Inline formatting of a non-code segment (no links: those are held by the caller). */
function formatText(seg: string): string {
  let s = escapeHtml(seg);
  s = s.replace(/\*\*\*(?=\S)(.*?\S)\*\*\*/g, (m, inner: string) =>
    balanced(inner) ? `<b><i>${inner}</i></b>` : m,
  );
  s = wrap(s, /~~(?=\S)(.*?\S)~~/g, "s");
  s = wrap(s, /\*\*(?=\S)(.*?\S)\*\*/g, "b");
  s = wrap(s, /(?<![\w])__(?=\S)(.*?\S)__(?!\w)/g, "b");
  s = wrap(s, /(?<![\w*])\*(?=[^\s*])([^*]*?[^\s*])\*(?![\w*])/g, "i");
  s = wrap(s, /(?<![\w_])_(?=[^\s_])([^_]*?[^\s_])_(?![\w_])/g, "i");
  return s;
}

function formatSpan(seg: string): string {
  const held: string[] = [];
  const hold = (v: string) => {
    held.push(v);
    return `${HOLD}${held.length - 1}${HOLD}`;
  };
  const link = (label: string, url: string) =>
    hold(`<a href="${escapeAttr(url)}">${formatText(label)}</a>`);
  const s = formatText(
    seg
      .replace(
        /(?<!!)\[([^\]\n]+)\]\((https?:\/\/(?:[^\s()]|\([^\s()]*\))+)\)/g,
        (_m, l: string, u: string) => link(l, u),
      )
      .replace(/<(https?:\/\/[^>\s]+)>/g, (_m, u: string) => link(u, u)),
  );
  return s.replace(
    new RegExp(`${HOLD}(\\d+)${HOLD}`, "g"),
    (_m, i: string) => held[Number(i)] ?? "",
  );
}

/** One line of inline content: code spans verbatim (escaped only), the rest formatted. */
function inline(line: string): string {
  let out = "";
  let last = 0;
  for (const m of line.matchAll(/`([^`\n]+)`/g)) {
    out += `${formatSpan(line.slice(last, m.index))}<code>${escapeHtml(m[1] ?? "")}</code>`;
    last = m.index + m[0].length;
  }
  return out + formatSpan(line.slice(last));
}

function convertLine(line: string): string {
  const h = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
  if (h) {
    const body = (h[1] ?? "").replace(/\*\*|__/g, "");
    return body === "" ? "" : `<b>${inline(body)}</b>`;
  }
  const li = /^(\s*)[-*+]\s+(.*)$/.exec(line);
  if (li) return `${li[1]}• ${inline(li[2] ?? "")}`;
  return inline(line);
}

function codeBlock(lang: string, lines: string[]): string {
  const body = escapeHtml(lines.join("\n"));
  const l = lang.replace(/[^A-Za-z0-9_+#.-]/g, "");
  return l === "" ? `<pre>${body}</pre>` : `<pre><code class="language-${l}">${body}</code></pre>`;
}

/**
 * Converts a model reply from Markdown to Telegram HTML (mentions neutralised outside code). The
 * HTML style has no tables: each table becomes a list first (tables.ts).
 */
export function markdownToTelegramHtml(md: string): string {
  const lines = tablesToLists(md.replace(/\r\n?/g, "\n").replaceAll("\u0000", "")).split("\n");
  const out: string[] = [];
  let fence: { lang: string; lines: string[] } | undefined;
  let quote: string[] | undefined;
  const closeQuote = () => {
    if (quote) out.push(`<blockquote>${quote.join("\n")}</blockquote>`);
    quote = undefined;
  };
  for (const line of lines) {
    if (fence) {
      if (/^\s*(```|~~~)\s*$/.test(line)) {
        out.push(codeBlock(fence.lang, fence.lines));
        fence = undefined;
      } else fence.lines.push(line);
      continue;
    }
    const open = /^\s*(?:```|~~~)\s*([^\s`]*)/.exec(line);
    if (open) {
      closeQuote();
      fence = { lang: open[1] ?? "", lines: [] };
      continue;
    }
    const q = /^\s{0,3}>\s?(.*)$/.exec(line);
    if (q) {
      quote ??= [];
      quote.push(convertLine(q[1] ?? ""));
      continue;
    }
    closeQuote();
    out.push(convertLine(line));
  }
  if (fence) out.push(codeBlock(fence.lang, fence.lines));
  closeQuote();
  return neutraliseHtmlMentions(out.join("\n"));
}

type Token =
  | { kind: "tag"; text: string; name: string; close: boolean }
  | { kind: "text"; text: string; len: number };

function tokenise(html: string): Token[] {
  const tokens: Token[] = [];
  const re = /<(\/?)([a-z-]+)[^>]*>|&(?:amp|lt|gt|quot);|[\s\S]/gu;
  for (const m of html.matchAll(re)) {
    if (m[2] !== undefined)
      tokens.push({ kind: "tag", text: m[0], name: m[2], close: m[1] === "/" });
    else
      tokens.push({
        kind: "text",
        text: m[0],
        len: m[0].startsWith("&") && m[0].length > 1 ? 1 : m[0].length,
      });
  }
  return tokens;
}

const openers = (stack: string[][]) => stack.map((t) => t[0]).join("");
const closers = (stack: string[][]) =>
  [...stack]
    .reverse()
    .map((t) => `</${t[1]}>`)
    .join("");

/** The visible length of Telegram HTML as Telegram counts it (UTF-16 code units, an entity is one). */
export function visibleLength(html: string): number {
  let n = 0;
  for (const t of tokenise(html)) if (t.kind === "text") n += t.len;
  return n;
}

/**
 * `html` cut to at most `limit` visible characters, ending in an ellipsis (inside the tags the cut
 * closes); tags stay balanced.
 */
export function truncateHtml(html: string, limit = TEXT_LIMIT): string {
  if (visibleLength(html) <= limit) return html;
  const head = splitHtml(html, limit - 1)[0] ?? "";
  const closing = /(?:<\/[a-z-]+>)*$/.exec(head)?.[0] ?? "";
  return `${head.slice(0, head.length - closing.length)}…${closing}`;
}

/**
 * `lead` and `body` in one message, separated by a blank line, within `limit` visible characters:
 * the lead is cut first, then (when the body alone is too long) the lead is dropped and the body cut.
 */
export function fitHtml(lead: string, body: string, limit = TEXT_LIMIT): string {
  const sep = "\n\n";
  if (lead === "") return truncateHtml(body, limit);
  if (body === "") return truncateHtml(lead, limit);
  const room = limit - visibleLength(body) - sep.length;
  // Room for at least one character of the lead and its ellipsis.
  if (room >= 2) return `${truncateHtml(lead, room)}${sep}${body}`;
  return truncateHtml(body, limit);
}

/**
 * Splits Telegram HTML into parts of at most `limit` visible characters. Never cuts inside a tag or entity;
 * open tags are closed at the end of a part and reopened at the start of the next. Prefers cutting at a
 * newline (in the second half of the part), then at a space.
 */
export function splitHtml(html: string, limit = TEXT_LIMIT): string[] {
  const tokens = tokenise(html);
  const parts: string[] = [];
  let cur: Token[] = [];
  let vis = 0;
  let stack: string[][] = []; // [open tag text, name]
  let prefix = "";
  let cand: { i: number; vis: number; stack: string[][] } | undefined;
  // The last newline in the part: a cut there keeps lines (a list item, a table row) whole.
  let nl: typeof cand;

  const emit = (toks: Token[], count: number, at: string[][]) => {
    if (count > 0) parts.push(prefix + toks.map((t) => t.text).join("") + closers(at));
  };
  for (const t of tokens) {
    if (t.kind === "tag") {
      if (t.close) {
        const at = stack.findLastIndex((s) => s[1] === t.name);
        if (at >= 0) stack = stack.slice(0, at);
      } else stack = [...stack, [t.text, t.name]];
      cur.push(t);
      continue;
    }
    if (vis + t.len > limit) {
      if (nl && nl.vis >= limit / 2) cand = nl;
      if (cand && cand.vis >= limit / 2) {
        emit(cur.slice(0, cand.i), cand.vis, cand.stack);
        const rest = cur.slice(cand.i + 1);
        prefix = openers(cand.stack);
        vis = vis - cand.vis - 1;
        cur = rest;
      } else {
        emit(cur, vis, stack);
        prefix = openers(stack);
        vis = 0;
        cur = [];
      }
      cand = undefined;
      nl = undefined;
    }
    if (/^\s$/.test(t.text)) cand = { i: cur.length, vis, stack: [...stack] };
    if (t.text === "\n") nl = cand;
    cur.push(t);
    vis += t.len;
  }
  emit(cur, vis, stack);
  return parts.length > 0 ? parts : [""];
}
