import type { MdTable } from "./tables.js";

/**
 * A Markdown table → a Block Kit `table` block (https://docs.slack.dev/reference/block-kit/blocks/table-block ,
 * checked 2026-11-10): at most 100 rows (the header counts) of at most 20 cells; the cells of a
 * table, and of all tables in one message, at most 10,000 characters; `column_settings` (`align`,
 * `is_wrapped`) at most 20. A table may be sent in `blocks` of chat.postMessage and chat.update.
 * The reference no longer says so, but earlier versions and several integrations report one table
 * per message, shown at its bottom (`invalid_attachments` / `only_one_table_allowed` otherwise):
 * renderSend therefore puts one table, as the last block, in each message.
 *
 * Cells are `raw_text` (plain) or `rich_text` (one `rich_text_section`) when the cell has inline
 * formatting: `text` elements with `style` bold / italic / strike / code
 * (https://docs.slack.dev/reference/block-kit/block-elements/text-element ) and `link` elements
 * (https://docs.slack.dev/reference/block-kit/block-elements/link-element ), only for http(s) and
 * mailto, like mrkdwn.ts. Rich text is structured: a `text` element is shown literally, so `<!channel>`
 * or `<@U1>` in a cell can't mention anyone (mentions are their own element types) and needs no
 * escaping. Header cells are bold. Every column wraps (`is_wrapped`), so long cells stay readable
 * on a phone instead of being cut.
 */

export const TABLE_MAX_ROWS = 100;
export const TABLE_MAX_COLUMNS = 20;
export const TABLE_MAX_CHARS = 10_000;

type Cell = Record<string, unknown>;
type Style = { bold?: true; italic?: true; strike?: true; code?: true };
type Element = { type: "text"; text: string; style?: Style } | LinkElement;
type LinkElement = { type: "link"; url: string; text: string; style?: Style };

/** A cell for an empty Markdown cell: Slack's text fields need at least one character. */
const EMPTY = " ";

function withStyle<T extends Element>(e: T, style: Style): T {
  return Object.keys(style).length === 0 ? e : { ...e, style: { ...e.style, ...style } };
}

const EMPHASIS =
  /\*\*\*(\S(?:.*?\S)?)\*\*\*|\*\*(\S(?:.*?\S)?)\*\*|(?<!\w)__(\S(?:.*?\S)?)__(?!\w)|(?<![\w*])\*(?=[^\s*])([^*]*?[^\s*])\*(?![\w*])|(?<![\w_])_(?=[^\s_])([^_]*?[^\s_])_(?![\w_])|~~(\S(?:.*?\S)?)~~/;

/** Emphasis (bold, italic, strike, nested) of a run without code or links. */
function emphasis(s: string, style: Style): Element[] {
  const out: Element[] = [];
  let rest = s;
  while (rest !== "") {
    const m = EMPHASIS.exec(rest);
    if (!m) break;
    if (m.index > 0)
      out.push(withStyle<Element>({ type: "text", text: rest.slice(0, m.index) }, style));
    const [, bi, b, b2, i, i2, st] = m;
    if (bi !== undefined) out.push(...emphasis(bi, { ...style, bold: true, italic: true }));
    else if (b !== undefined || b2 !== undefined)
      out.push(...emphasis((b ?? b2) as string, { ...style, bold: true }));
    else if (i !== undefined || i2 !== undefined)
      out.push(...emphasis((i ?? i2) as string, { ...style, italic: true }));
    else out.push(...emphasis(st as string, { ...style, strike: true }));
    rest = rest.slice(m.index + m[0].length);
  }
  if (rest !== "") out.push(withStyle<Element>({ type: "text", text: rest }, style));
  return out;
}

const LINK =
  /\[([^\]\n]+)\]\(((?:https?:\/\/|mailto:)[^\s)]+)\)|<((?:https?:\/\/|mailto:)[^>\s]+)>/;

/** Links and emphasis of a run without code. Link labels keep their emphasis as link style. */
function links(s: string): Element[] {
  const out: Element[] = [];
  let rest = s;
  for (let m = LINK.exec(rest); m; m = LINK.exec(rest)) {
    out.push(...emphasis(rest.slice(0, m.index), {}));
    const url = (m[2] ?? m[3]) as string;
    if (m[1] === undefined) out.push({ type: "link", url, text: url });
    else
      for (const e of emphasis(m[1], {})) {
        // Link styles have no `code`.
        const { code: _code, ...style } = e.style ?? {};
        out.push(withStyle<LinkElement>({ type: "link", url, text: e.text }, style));
      }
    rest = rest.slice(m.index + m[0].length);
  }
  out.push(...emphasis(rest, {}));
  return out;
}

/** Inline Markdown of a cell → rich text elements (code spans verbatim). */
export function cellElements(md: string): Element[] {
  const out: Element[] = [];
  let last = 0;
  for (const m of md.matchAll(/`([^`\n]+)`/g)) {
    out.push(...links(md.slice(last, m.index)));
    out.push({ type: "text", text: m[1] as string, style: { code: true } });
    last = m.index + m[0].length;
  }
  out.push(...links(md.slice(last)));
  return out.filter((e) => e.text !== "");
}

/** The text a cell shows (what counts toward the character limits). */
export const cellText = (md: string) =>
  cellElements(md.replace(/<br\s*\/?>/gi, "\n"))
    .map((e) => e.text)
    .join("");

function cell(md: string, header: boolean): Cell {
  const els = cellElements(md.replace(/<br\s*\/?>/gi, "\n")).map((e) =>
    header ? withStyle(e, { bold: true }) : e,
  );
  if (els.length === 0) return { type: "raw_text", text: EMPTY };
  if (els.every((e) => e.type === "text" && e.style === undefined)) {
    return { type: "raw_text", text: els.map((e) => e.text).join("") };
  }
  return { type: "rich_text", elements: [{ type: "rich_text_section", elements: els }] };
}

const rowChars = (row: string[]) => row.reduce((n, c) => n + Math.max(cellText(c).length, 1), 0);

/**
 * The table as one or more table blocks (each with the header row again) that fit the limits,
 * or undefined when it can't be a native table (too many columns, or one row alone over the
 * character limit): the caller then sends it as a list.
 */
export function tableBlocks(t: MdTable): Record<string, unknown>[] | undefined {
  const width = t.header.length;
  if (width > TABLE_MAX_COLUMNS || t.rows.length === 0) return undefined;
  const headChars = rowChars(t.header);
  const groups: string[][][] = [];
  let cur: string[][] = [];
  let chars = headChars;
  for (const row of t.rows) {
    const n = rowChars(row);
    if (headChars + n > TABLE_MAX_CHARS) return undefined;
    if (cur.length > 0 && (cur.length + 1 >= TABLE_MAX_ROWS || chars + n > TABLE_MAX_CHARS)) {
      groups.push(cur);
      cur = [];
      chars = headChars;
    }
    cur.push(row);
    chars += n;
  }
  groups.push(cur);
  const column_settings = Array.from({ length: width }, () => ({ is_wrapped: true }));
  return groups.map((rows) => ({
    type: "table",
    column_settings,
    rows: [t.header.map((c) => cell(c, true)), ...rows.map((r) => r.map((c) => cell(c, false)))],
  }));
}
