/**
 * Markdown -> Telegram rich message HTML, used only for replies that contain a table: Bot API 10.1
 * rich messages (`sendRichMessage`, `editMessageText` with `rich_message`) render a `<table>`
 * natively (https://core.telegram.org/bots/api/rich-messages, read 2026-11-10).
 *
 * Everything around the tables goes through the same converter as the plain HTML path (html.ts):
 * the same escaping, http(s)-only links and mention guard, so a rich reply looks like a plain one
 * plus real tables. Rich HTML collapses whitespace like a browser (checked live 2026-11-10: a bare
 * newline became a space), so newlines outside `<pre>` become `<br>`; newlines next to a block
 * (`<pre>`, `<blockquote>`, a table) are dropped, the block already starts its own line.
 *
 * Returns undefined when plain HTML should be used: no table that fits a rich table, or the reply
 * is over the rich limits (32768 characters, 500 blocks counting table rows; a table wider than
 * 20 columns becomes the list the plain path uses). The caller falls back to plain HTML when
 * Telegram rejects the rich message anyway.
 */

import {
  convertLines,
  inline,
  neutraliseHtmlMentions,
  normaliseMarkdown,
  visibleLength,
} from "./html.js";
import { BR, type MdTable, segmentTables, tableToListMarkdown } from "./tables.js";

export const RICH_LIMITS = { text: 32768, blocks: 500, columns: 20 } as const;

function cell(tag: "th" | "td", text: string, align: MdTable["align"][number]): string {
  const body = text
    .split(BR)
    .map((part) => inline(part.trim()))
    .join("<br>");
  return `<${tag}${align ? ` align="${align}"` : ""}>${body}</${tag}>`;
}

/** A table as rich HTML: bordered and striped (what Telegram gives a Markdown table). */
export function tableToRichHtml(t: MdTable): string {
  const row = (tag: "th" | "td", cells: string[]) =>
    `<tr>${cells.map((c, i) => cell(tag, c, t.align[i])).join("")}</tr>`;
  return `<table bordered striped>${row("th", t.header)}${t.rows.map((r) => row("td", r)).join("")}</table>`;
}

/** Plain-path HTML to rich HTML: line breaks become `<br>` outside `<pre>`, none next to a block. */
function textToRichHtml(html: string): string {
  return html
    .split(/(<pre[^>]*>[\s\S]*?<\/pre>)/)
    .map((part, i) =>
      i % 2 === 1
        ? part
        : part
            .replace(/\n*(<\/?blockquote>)\n*/g, "$1")
            .replace(/^\n+|\n+$/g, "")
            .replace(/\n/g, "<br>"),
    )
    .join("");
}

/** The reply as rich message HTML, or undefined when plain HTML is the better (or only) fit. */
export function markdownToRichHtml(md: string): string | undefined {
  const segments = segmentTables(normaliseMarkdown(md));
  const native = (t: MdTable) => t.header.length <= RICH_LIMITS.columns;
  if (!segments.some((s) => s.kind === "table" && native(s.table))) return undefined;
  const parts: string[] = [];
  let lines: string[] = [];
  let blocks = 0;
  const flush = () => {
    const html = textToRichHtml(convertLines(lines));
    lines = [];
    if (html === "") return;
    parts.push(html);
    // A paragraph, plus each code block and quote.
    blocks += 1 + (html.match(/<pre|<blockquote/g)?.length ?? 0);
  };
  for (const s of segments) {
    if (s.kind === "text") lines.push(...s.lines);
    else if (!native(s.table)) lines.push(...tableToListMarkdown(s.table));
    else {
      flush();
      parts.push(tableToRichHtml(s.table));
      blocks += 1 + s.table.rows.length + 1;
    }
  }
  flush();
  const html = neutraliseHtmlMentions(parts.join(""));
  if (blocks > RICH_LIMITS.blocks || visibleLength(html) > RICH_LIMITS.text) return undefined;
  return html;
}
