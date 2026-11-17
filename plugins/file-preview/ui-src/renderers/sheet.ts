/** Spreadsheet previewer: tabs of sheets, each a virtualized table with column letters on top. */
import { formatCount, showEmpty, workerReason } from "../app/frame.js";
import { THEME } from "../app/theme.js";
import type { RenderContext, Renderer } from "../app/types.js";
import {
  MAX_CELLS,
  MAX_COLS,
  MAX_ROWS,
  type SheetData,
  type SheetInput,
  type SheetOutput,
} from "../shared/sheet.js";

const STRINGS = {
  zh: {
    truncatedRows: `仅显示每个工作表的前 ${formatCount(MAX_ROWS, "zh")} 行`,
    truncatedCols: `仅显示每个工作表的前 ${formatCount(MAX_COLS, "zh")} 列`,
    emptySheet: "此工作表为空",
    truncatedCells: `单元格过多，仅显示前 ${formatCount(MAX_CELLS, "zh")} 个单元格`,
    hidden: "隐藏的工作表",
    tooLarge: "此工作簿解压后过大，无法预览",
    invalid: "这不是有效的 .xlsx 工作簿（文件已损坏，或扩展名与内容不符）",
  },
  en: {
    truncatedRows: `Showing only the first ${formatCount(MAX_ROWS, "en")} rows of each sheet`,
    truncatedCols: `Showing only the first ${formatCount(MAX_COLS, "en")} columns of each sheet`,
    emptySheet: "This sheet is empty",
    truncatedCells: `Too many cells: showing only the first ${formatCount(MAX_CELLS, "en")}`,
    hidden: "Hidden sheet",
    tooLarge: "This workbook is too large once unpacked to preview",
    invalid: "This is not a valid .xlsx workbook (the file is corrupt or not what its name says)",
  },
} as const;

const STYLE = `
.cap-sheet{display:flex;flex-direction:column;height:100%;min-height:0}
.cap-sheet-tabs{display:flex;gap:2px;overflow-x:auto;border-bottom:1px solid ${THEME.border};flex:none}
.cap-sheet-tab{font:inherit;color:inherit;background:none;border:0;border-bottom:2px solid transparent;padding:6px 12px;cursor:pointer;white-space:nowrap}
.cap-sheet-tab.cap-active{border-bottom-color:${THEME.accent};font-weight:600}
.cap-sheet-body{flex:1;min-height:0;display:flex;flex-direction:column}
.cap-sheet-note{padding:4px 12px;font-size:12px;opacity:.7;flex:none}
.cap-sheet-scroll{flex:1;min-height:0;overflow:auto}
.cap-sheet-table{border-collapse:separate;border-spacing:0;font-size:13px;table-layout:fixed}
.cap-sheet-table td,.cap-sheet-table th{border-right:1px solid ${THEME.border};border-bottom:1px solid ${THEME.border};padding:0 8px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;box-sizing:border-box}
.cap-sheet-table thead th{position:sticky;top:0;z-index:2;background:${THEME.background};font-weight:500}
.cap-sheet-table .cap-sheet-rownum,.cap-sheet-table .cap-sheet-corner{position:sticky;left:0;z-index:1;background:${THEME.background};font-weight:400;opacity:.8;text-align:right}
.cap-sheet-table thead .cap-sheet-corner{z-index:3}
.cap-sheet-merged{text-align:center}
.cap-sheet-tab.cap-hidden{opacity:.55;font-style:italic}
.cap-sheet-spacer td{padding:0;border:0}
`;

/** Row height in px; the window of rows is computed from it, not measured. */
export const ROW_HEIGHT = 24;
const OVERSCAN = 10;
const FALLBACK_VIEWPORT = 600;
const MIN_COLS = 1;
const WIDTH_SAMPLE_ROWS = 200;
const MIN_COL_PX = 48;
const MAX_COL_PX = 320;
const ROWNUM_PX = 56;

function letters(i: number): string {
  let s = "";
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) {
    s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  }
  return s;
}

function el<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const e = doc.createElement(tag);
  if (className !== undefined) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** Pixel width of each column from the header and the first rows, fixed for the whole sheet. */
export function columnWidths(rows: string[][], nCols: number): number[] {
  const widths: number[] = [];
  for (let c = 0; c < nCols; c++) {
    let chars = letters(c).length;
    for (let r = 0; r < Math.min(rows.length, WIDTH_SAMPLE_ROWS); r++) {
      const text = rows[r]?.[c] ?? "";
      let n = 0;
      for (const ch of text) n += (ch.codePointAt(0) ?? 0) > 0x2e7f ? 2 : 1;
      if (n > chars) chars = n;
    }
    widths.push(Math.min(MAX_COL_PX, Math.max(MIN_COL_PX, chars * 8 + 16)));
  }
  return widths;
}

function mountSheet(
  sheet: SheetData,
  host: HTMLElement,
  s: (typeof STRINGS)["en"] | (typeof STRINGS)["zh"],
  signal: AbortSignal,
): void {
  const doc = host.ownerDocument;
  host.replaceChildren();
  const notes = [
    sheet.truncatedRows ? s.truncatedRows : "",
    sheet.truncatedCols ? s.truncatedCols : "",
    sheet.truncatedCells ? s.truncatedCells : "",
  ].filter((n) => n !== "");
  for (const n of notes) host.append(el(doc, "div", "cap-sheet-note", n));
  let nCols = MIN_COLS;
  for (const r of sheet.rows) nCols = Math.max(nCols, r.length);
  for (const m of sheet.merges) nCols = Math.max(nCols, m.c2 + 1);
  if (sheet.rows.length === 0) {
    host.append(el(doc, "div", "cap-state cap-empty", s.emptySheet));
    return;
  }

  // merges by row: a merged cell is its origin with a colSpan; rows below it show it blank
  const byRow = new Map<number, SheetData["merges"]>();
  for (const m of sheet.merges) {
    for (let r = m.r1; r <= m.r2; r++) {
      const list = byRow.get(r);
      if (list) list.push(m);
      else byRow.set(r, [m]);
    }
  }

  const scroller = el(doc, "div", "cap-sheet-scroll");
  const table = el(doc, "table", "cap-sheet-table");
  const widths = columnWidths(sheet.rows, nCols);
  const colgroup = el(doc, "colgroup");
  const numCol = el(doc, "col");
  numCol.style.width = `${ROWNUM_PX}px`;
  colgroup.append(numCol);
  for (const w of widths) {
    const col = el(doc, "col");
    col.style.width = `${w}px`;
    colgroup.append(col);
  }
  table.style.width = `${ROWNUM_PX + widths.reduce((a, b) => a + b, 0)}px`;
  table.append(colgroup);
  const thead = el(doc, "thead");
  const headRow = el(doc, "tr");
  headRow.style.height = `${ROW_HEIGHT}px`;
  headRow.append(el(doc, "th", "cap-sheet-corner"));
  for (let c = 0; c < nCols; c++) headRow.append(el(doc, "th", "cap-sheet-col", letters(c)));
  thead.append(headRow);
  const tbody = el(doc, "tbody");
  table.append(thead, tbody);
  scroller.append(table);
  host.append(scroller);

  const spacer = (h: number): HTMLTableRowElement => {
    const tr = el(doc, "tr", "cap-sheet-spacer");
    const td = el(doc, "td");
    td.colSpan = nCols + 1;
    td.style.height = `${h}px`;
    tr.append(td);
    return tr;
  };

  const rowEl = (r: number): HTMLTableRowElement => {
    const tr = el(doc, "tr");
    tr.style.height = `${ROW_HEIGHT}px`;
    tr.append(el(doc, "th", "cap-sheet-rownum", String(r + 1)));
    const merges = byRow.get(r) ?? [];
    const cells = sheet.rows[r] as string[];
    for (let c = 0; c < nCols; c++) {
      const m = merges.find((x) => c >= x.c1 && c <= x.c2);
      if (m !== undefined && c !== m.c1) continue;
      const td = el(doc, "td", undefined, m !== undefined && r !== m.r1 ? "" : (cells[c] ?? ""));
      if (m !== undefined) {
        td.colSpan = m.c2 - m.c1 + 1;
        td.className = "cap-sheet-merged";
        c = m.c2;
      }
      tr.append(td);
    }
    return tr;
  };

  const total = sheet.rows.length;
  let first = -1;
  let last = -1;
  const paint = () => {
    const viewport = scroller.clientHeight > 0 ? scroller.clientHeight : FALLBACK_VIEWPORT;
    const start = Math.max(0, Math.floor(scroller.scrollTop / ROW_HEIGHT) - OVERSCAN);
    // the sticky header covers the first ROW_HEIGHT px of the viewport and the first row starts
    // below it, so the rows in view end at (scrollTop + viewport) / ROW_HEIGHT - 1
    const end = Math.min(
      total,
      Math.ceil((scroller.scrollTop + viewport) / ROW_HEIGHT - 1) + OVERSCAN,
    );
    if (start === first && end === last) return;
    first = start;
    last = end;
    const nodes: HTMLElement[] = [spacer(start * ROW_HEIGHT)];
    for (let r = start; r < end; r++) nodes.push(rowEl(r));
    nodes.push(spacer((total - end) * ROW_HEIGHT));
    tbody.replaceChildren(...nodes);
  };
  // listeners go when the sheet is replaced or the preview ends
  scroller.addEventListener("scroll", paint, { signal });
  doc.defaultView?.addEventListener("resize", paint, { signal });
  paint();
}

export const render: Renderer = async (file, ctx: RenderContext) => {
  const s = STRINGS[ctx.locale];
  const doc = ctx.root.ownerDocument;
  if (file.size === 0 || file.data.byteLength === 0) {
    showEmpty(ctx.root, ctx.t);
    return;
  }
  let out: SheetOutput;
  try {
    // a copy travels to the worker: transferring file.data would detach it for a retry
    const data = file.data.slice(0);
    out = await ctx.runInWorker<SheetInput, SheetOutput>("sheet", { data }, { transfer: [data] });
  } catch (e) {
    if (ctx.signal.aborted) return;
    ctx.showError(workerReason(e, ctx.locale));
    return;
  }
  if (ctx.signal.aborted) return;
  if (out.error !== undefined) {
    ctx.showError(out.error === "too-large" ? s.tooLarge : s.invalid);
    return;
  }
  if (out.sheets.length === 0) {
    showEmpty(ctx.root, ctx.t);
    return;
  }

  const wrap = el(doc, "div", "cap-sheet");
  wrap.append(el(doc, "style", undefined, STYLE));
  const tabs = el(doc, "div", "cap-sheet-tabs");
  tabs.setAttribute("role", "tablist");
  const body = el(doc, "div", "cap-sheet-body");
  const buttons: HTMLButtonElement[] = [];
  let mounted: AbortController | undefined;
  const stop = () => mounted?.abort();
  ctx.lifetime.addEventListener("abort", stop, { once: true });
  const select = (i: number) => {
    buttons.forEach((b, j) => {
      b.setAttribute("aria-selected", String(i === j));
      b.classList.toggle("cap-active", i === j);
    });
    stop();
    mounted = new AbortController();
    mountSheet(out.sheets[i] as SheetData, body, s, mounted.signal);
  };
  out.sheets.forEach((sh, i) => {
    const b = el(doc, "button", "cap-sheet-tab", sh.name);
    b.type = "button";
    b.setAttribute("role", "tab");
    if (sh.hidden) {
      b.classList.add("cap-hidden");
      b.title = s.hidden;
    }
    b.addEventListener("click", () => select(i));
    buttons.push(b);
    tabs.append(b);
  });
  wrap.append(tabs, body);
  ctx.root.replaceChildren(wrap);
  select(0);
};
