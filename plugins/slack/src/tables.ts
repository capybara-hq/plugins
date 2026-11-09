/**
 * GFM pipe tables in model replies (https://github.github.com/gfm/#tables-extension- , checked
 * 2026-11-10): finding them and the readable list that replaces a table where no native table
 * can be used. The same parser lives in the telegram plugin (plugins share no code); keep the two
 * in step.
 *
 * A table is a header row with an unescaped `|`, directly followed by a delimiter row
 * (`|---|:--:|`) with the same number of cells, then body rows until a blank line, a line without
 * a `|` or a code fence. Fenced code is never searched, nor lines indented four spaces or more
 * (indented code) or quoted (`>`). `\|` in a cell is a literal pipe; the alignment row is dropped.
 * Body rows are padded or cut to the header's width, as GFM does.
 */

export interface MdTable {
  header: string[];
  rows: string[][];
}

export type Segment = { kind: "text"; lines: string[] } | { kind: "table"; table: MdTable };

const FENCE = /^\s*(```|~~~)/;
const DELIM_CELL = /^:?-+:?$/;

/** Cells of a row split on unescaped pipes (`\|` becomes `|`); undefined when it has no pipe. */
export function splitRow(line: string): string[] | undefined {
  let s = line.trim();
  if (!/(^|[^\\])\|/.test(s)) return undefined;
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  const cells: string[] = [];
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "\\" && s[i + 1] === "|") {
      cur += "|";
      i++;
    } else if (c === "|") {
      cells.push(cur.trim());
      cur = "";
    } else cur += c;
  }
  cells.push(cur.trim());
  return cells;
}

const candidate = (line: string) => !/^\s{4,}/.test(line) && !/^\s*>/.test(line);

function delimiterRow(line: string | undefined, width: number): boolean {
  if (line === undefined || !candidate(line)) return false;
  const cells = splitRow(line);
  return cells !== undefined && cells.length === width && cells.every((c) => DELIM_CELL.test(c));
}

const fit = (cells: string[], width: number) =>
  Array.from({ length: width }, (_, i) => cells[i] ?? "");

/** The Markdown split into text runs and tables, in order (text lines kept verbatim). */
export function segmentTables(md: string): Segment[] {
  const lines = md.replace(/\r\n?/g, "\n").split("\n");
  const out: Segment[] = [];
  let text: string[] = [];
  const flushText = () => {
    if (text.length > 0) out.push({ kind: "text", lines: text });
    text = [];
  };
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    if (FENCE.test(line)) {
      inFence = !inFence;
      text.push(line);
      continue;
    }
    const header = !inFence && candidate(line) ? splitRow(line) : undefined;
    if (!header || !delimiterRow(lines[i + 1], header.length)) {
      text.push(line);
      continue;
    }
    const rows: string[][] = [];
    let j = i + 2;
    for (; j < lines.length; j++) {
      const l = lines[j] as string;
      if (l.trim() === "" || FENCE.test(l) || !candidate(l)) break;
      const cells = splitRow(l);
      if (!cells) break;
      rows.push(fit(cells, header.length));
    }
    flushText();
    out.push({ kind: "table", table: { header, rows } });
    i = j - 1;
  }
  flushText();
  return out;
}

const BR = /<br\s*\/?>/gi;
const CJK_END = /[⺀-鿿가-힯豈-﫿＀-￯]$/u;
/** Indent of the `header: value` lines under a row's first cell. */
const INDENT = "   ";

/** `header: value`, with a full-width colon after a CJK header. */
const pair = (h: string, v: string) => (h === "" ? v : `${h}${CJK_END.test(h) ? "：" : ": "}${v}`);

/** Bold, unless the cell already carries code or strong emphasis (nesting would break them). */
const lead = (cell: string) => (/`|\*\*|__/.test(cell) ? cell : `**${cell}**`);

/**
 * A table as Markdown list lines (inline formatting kept, for the caller's converter): one item per
 * body row, led by its first cell in bold. Two columns: `- **a** — b`. More: the first cell alone,
 * then one indented `header: value` line per non-empty cell, which stays readable on a phone where
 * a wide row would wrap. A table without body rows becomes its header cells on one line.
 */
export function tableToListMarkdown(t: MdTable): string[] {
  const clean = (s: string) => s.replace(BR, " / ").trim();
  const header = t.header.map(clean);
  if (t.rows.length === 0) return [header.filter((h) => h !== "").join(" · ")];
  const out: string[] = [];
  for (const raw of t.rows) {
    const [first = "", ...rest] = raw.map(clean);
    const head = first === "" ? "" : lead(first);
    const items = rest.flatMap((v, i) => (v === "" ? [] : [pair(header[i + 1] ?? "", v)]));
    if (head === "" && items.length === 0) continue;
    if (header.length === 2) {
      out.push(`- ${[head, rest[0] ?? ""].filter((s) => s !== "").join(" — ")}`);
      continue;
    }
    out.push(`- ${head === "" ? (items.shift() ?? "") : head}`);
    for (const it of items) out.push(`${INDENT}${it}`);
  }
  return out;
}

/** The Markdown with every table replaced by {@link tableToListMarkdown}. */
export function tablesToLists(md: string): string {
  return segmentTables(md)
    .flatMap((s) => (s.kind === "text" ? s.lines : tableToListMarkdown(s.table)))
    .join("\n");
}
