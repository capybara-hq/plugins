/**
 * Worker side of the sheet previewer: exceljs parses the workbook into plain text rows, capped at
 * `MAX_ROWS` x `MAX_COLS` per sheet and `MAX_CELLS` per workbook.
 */
import ExcelJS from "exceljs";
import type { SheetData, SheetInput, SheetMerge, SheetOutput } from "../shared/sheet.js";
import { serve } from "./serve.js";

export const MAX_ROWS = 100_000;
export const MAX_COLS = 200;
/** Cells (values) kept across all sheets of one workbook. */
export const MAX_CELLS = 2_000_000;

/** Column letters ("AB") to a 0-based index. */
function colIndex(letters: string): number {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** "A1:C3" to a 0-based merge, or undefined for anything else. */
function parseMerge(ref: string): SheetMerge | undefined {
  const m = /^\$?([A-Z]+)\$?(\d+):\$?([A-Z]+)\$?(\d+)$/.exec(ref);
  if (m === null) return undefined;
  return {
    r1: Number(m[2]) - 1,
    c1: colIndex(m[1] as string),
    r2: Number(m[4]) - 1,
    c2: colIndex(m[3] as string),
  };
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

// Excel prints English names unless the file carries a locale (`[$-804]`), which we do not honor.
const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** Formats a date with the date/time tokens of an Excel number format (UTC, as exceljs reads it). */
export function formatDate(d: Date, numFmt: string | undefined): string {
  // an out-of-range serial is an Invalid Date: show nothing derived from it
  if (Number.isNaN(d.getTime())) return "";
  const iso = d.toISOString();
  const fmt = (numFmt ?? "").split(";")[0]?.replace(/\[[^\]]*\]/g, "") ?? "";
  if (!/[ymdhs]/i.test(fmt.replace(/"[^"]*"/g, ""))) {
    return iso.endsWith("T00:00:00.000Z")
      ? iso.slice(0, 10)
      : `${iso.slice(0, 10)} ${iso.slice(11, 19)}`;
  }
  const ampm = /am\/pm|a\/p/i.test(fmt);
  const tokens = fmt.match(/"[^"]*"|am\/pm|a\/p|y+|m+|d+|h+|s+|\\.|./gi) ?? [];
  let out = "";
  tokens.forEach((tok, i) => {
    const t = tok.toLowerCase();
    if (tok.startsWith('"')) out += tok.slice(1, -1);
    else if (tok.startsWith("\\")) out += tok.slice(1);
    else if (t[0] === "y")
      out += t.length <= 2 ? pad(d.getUTCFullYear() % 100) : pad(d.getUTCFullYear(), 4);
    else if (t[0] === "d") {
      const day = d.getUTCDay();
      if (t.length >= 4) out += DAYS[day];
      else if (t.length === 3) out += (DAYS[day] as string).slice(0, 3);
      else out += t.length === 1 ? String(d.getUTCDate()) : pad(d.getUTCDate());
    } else if (t[0] === "h") {
      const h = ampm ? d.getUTCHours() % 12 || 12 : d.getUTCHours();
      out += t.length === 1 ? String(h) : pad(h);
    } else if (t[0] === "s")
      out += t.length === 1 ? String(d.getUTCSeconds()) : pad(d.getUTCSeconds());
    else if (t[0] === "m") {
      // minutes right after an hour token or right before a seconds token, else the month
      const prev = tokens
        .slice(0, i)
        .reverse()
        .find((x) => /^[a-z]/i.test(x) && !/^am|^a\//i.test(x));
      const next = tokens.slice(i + 1).find((x) => /^[a-z]/i.test(x));
      const minute = /^h/i.test(prev ?? "") || /^s/i.test(next ?? "");
      if (minute) out += t.length === 1 ? String(d.getUTCMinutes()) : pad(d.getUTCMinutes());
      else {
        const name = MONTHS[d.getUTCMonth()] as string;
        if (t.length >= 5) out += name.slice(0, 1);
        else if (t.length === 4) out += name;
        else if (t.length === 3) out += name.slice(0, 3);
        else out += t.length === 1 ? String(d.getUTCMonth() + 1) : pad(d.getUTCMonth() + 1);
      }
    } else if (t === "am/pm" || t === "a/p") {
      const pm = d.getUTCHours() >= 12;
      out += t === "a/p" ? (pm ? "P" : "A") : pm ? "PM" : "AM";
    } else out += tok;
  });
  return out;
}

function cellText(cell: ExcelJS.Cell): string {
  const v = cell.value;
  if (v instanceof Date) return formatDate(v, cell.numFmt) || cell.text;
  if (typeof v === "object" && v !== null && "result" in v && v.result instanceof Date) {
    return formatDate(v.result, cell.numFmt) || cell.text;
  }
  return cell.text;
}

export async function parseWorkbook(input: SheetInput, maxCells = MAX_CELLS): Promise<SheetOutput> {
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(input.data);
  } catch {
    // the renderer words the reason (zh / en) from the code
    return { sheets: [], error: "invalid" };
  }
  const sheets: SheetData[] = [];
  let budget = maxCells;
  for (const ws of wb.worksheets) {
    const rows: string[][] = [];
    let truncatedRows = false;
    let truncatedCols = false;
    let truncatedCells = false;
    let width = 0;
    ws.eachRow({ includeEmpty: false }, (row, r) => {
      if (truncatedCells) return;
      const out: string[] = [];
      let any = false;
      row.eachCell({ includeEmpty: false }, (cell, c) => {
        if (c > MAX_COLS) {
          truncatedCols = true;
          return;
        }
        if (r > MAX_ROWS) {
          any = true;
          return;
        }
        if (budget <= 0) {
          truncatedCells = true;
          return;
        }
        budget--;
        while (out.length < c - 1) out.push("");
        out[c - 1] = cellText(cell);
        any = true;
      });
      if (r > MAX_ROWS) {
        if (any) truncatedRows = true;
        return;
      }
      if (truncatedCells && out.length === 0) return;
      while (rows.length < r - 1) rows.push([]);
      rows.push(out);
      width = Math.max(width, out.length);
    });
    const nRows = Math.min(rows.length, MAX_ROWS);
    const refs = (ws.model as { merges?: string[] }).merges ?? [];
    const merges: SheetMerge[] = [];
    for (const ref of refs) {
      const m = parseMerge(ref);
      if (m === undefined || m.r1 >= nRows || m.c1 >= MAX_COLS) continue;
      merges.push({ ...m, r2: Math.min(m.r2, MAX_ROWS - 1), c2: Math.min(m.c2, MAX_COLS - 1) });
    }
    sheets.push({
      name: ws.name,
      hidden: ws.state !== "visible",
      rows,
      merges,
      truncatedRows,
      truncatedCols,
      truncatedCells,
    });
  }
  return { sheets };
}

// the guard keeps the module importable from a test in a plain node process
if (typeof self !== "undefined") {
  serve<SheetInput, SheetOutput>(async (input) => ({ output: await parseWorkbook(input) }));
}
