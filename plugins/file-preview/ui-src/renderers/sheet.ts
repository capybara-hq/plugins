/** Spreadsheet previewer: tabs of sheets, each a virtualized table with column letters on top. */
import type { MessageKey } from "../app/frame.js";
import { THEME } from "../app/theme.js";
import type { RenderContext, Renderer } from "../app/types.js";
import type { SheetData, SheetInput, SheetOutput } from "../shared/sheet.js";

const STRINGS = {
  zh: {
    truncatedRows: "仅显示每个工作表的前 100 000 行",
    truncatedCols: "仅显示每个工作表的前 200 列",
    emptySheet: "此工作表为空",
  },
  en: {
    truncatedRows: "Showing only the first 100,000 rows of each sheet",
    truncatedCols: "Showing only the first 200 columns of each sheet",
    emptySheet: "This sheet is empty",
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
.cap-sheet-table{border-collapse:separate;border-spacing:0;font-size:13px;table-layout:auto}
.cap-sheet-table td,.cap-sheet-table th{border-right:1px solid ${THEME.border};border-bottom:1px solid ${THEME.border};padding:0 8px;white-space:nowrap;max-width:360px;overflow:hidden;text-overflow:ellipsis;box-sizing:border-box}
.cap-sheet-table thead th{position:sticky;top:0;z-index:2;background:${THEME.background};font-weight:500}
.cap-sheet-table .cap-sheet-rownum,.cap-sheet-table .cap-sheet-corner{position:sticky;left:0;z-index:1;background:${THEME.background};font-weight:400;opacity:.8;text-align:right}
.cap-sheet-table thead .cap-sheet-corner{z-index:3}
.cap-sheet-merged{text-align:center}
`;

/** Row height in px; the window of rows is computed from it, not measured. */
export const ROW_HEIGHT = 24;
const OVERSCAN = 10;
const FALLBACK_VIEWPORT = 600;
const MIN_COLS = 1;

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

function mountSheet(
  sheet: SheetData,
  host: HTMLElement,
  s: (typeof STRINGS)["en"] | (typeof STRINGS)["zh"],
): void {
  const doc = host.ownerDocument;
  host.replaceChildren();
  const notes = [
    sheet.truncatedRows ? s.truncatedRows : "",
    sheet.truncatedCols ? s.truncatedCols : "",
  ].filter((n) => n !== "");
  for (const n of notes) host.append(el(doc, "div", "cap-sheet-note", n));
  const nCols = Math.max(MIN_COLS, ...sheet.rows.map((r) => r.length));
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
  const thead = el(doc, "thead");
  const headRow = el(doc, "tr");
  headRow.append(el(doc, "th", "cap-sheet-corner"));
  for (let c = 0; c < nCols; c++) headRow.append(el(doc, "th", "cap-sheet-col", letters(c)));
  thead.append(headRow);
  const tbody = el(doc, "tbody");
  table.append(thead, tbody);
  scroller.append(table);
  host.append(scroller);

  const spacer = (h: number): HTMLTableRowElement => {
    const tr = el(doc, "tr", "cap-sheet-spacer");
    tr.style.height = `${h}px`;
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
    const end = Math.min(total, Math.ceil((scroller.scrollTop + viewport) / ROW_HEIGHT) + OVERSCAN);
    if (start === first && end === last) return;
    first = start;
    last = end;
    const nodes: HTMLElement[] = [spacer(start * ROW_HEIGHT)];
    for (let r = start; r < end; r++) nodes.push(rowEl(r));
    nodes.push(spacer((total - end) * ROW_HEIGHT));
    tbody.replaceChildren(...nodes);
  };
  scroller.addEventListener("scroll", paint);
  paint();
}

export const render: Renderer = async (file, ctx: RenderContext) => {
  const s = STRINGS[ctx.locale];
  const doc = ctx.root.ownerDocument;
  if (file.size === 0 || file.data.byteLength === 0) {
    ctx.root.replaceChildren(el(doc, "div", "cap-state cap-empty", ctx.t("empty" as MessageKey)));
    return;
  }
  let out: SheetOutput;
  try {
    out = await ctx.runInWorker<SheetInput, SheetOutput>(
      "sheet",
      { data: file.data },
      { transfer: [file.data] },
    );
  } catch (e) {
    if (ctx.signal.aborted) return;
    ctx.showError(e instanceof Error ? e.message : String(e));
    return;
  }
  if (ctx.signal.aborted) return;
  if (out.sheets.length === 0) {
    ctx.root.replaceChildren(el(doc, "div", "cap-state cap-empty", ctx.t("empty" as MessageKey)));
    return;
  }

  const wrap = el(doc, "div", "cap-sheet");
  wrap.append(el(doc, "style", undefined, STYLE));
  const tabs = el(doc, "div", "cap-sheet-tabs");
  tabs.setAttribute("role", "tablist");
  const body = el(doc, "div", "cap-sheet-body");
  const buttons: HTMLButtonElement[] = [];
  const select = (i: number) => {
    buttons.forEach((b, j) => {
      b.setAttribute("aria-selected", String(i === j));
      b.classList.toggle("cap-active", i === j);
    });
    mountSheet(out.sheets[i] as SheetData, body, s);
  };
  out.sheets.forEach((sh, i) => {
    const b = el(doc, "button", "cap-sheet-tab", sh.name);
    b.type = "button";
    b.setAttribute("role", "tab");
    b.addEventListener("click", () => select(i));
    buttons.push(b);
    tabs.append(b);
  });
  wrap.append(tabs, body);
  ctx.root.replaceChildren(wrap);
  select(0);
};
