/**
 * Worker side of the sheet previewer: exceljs parses the workbook into plain text rows, capped at
 * `MAX_ROWS` x `MAX_COLS` per sheet.
 */
import ExcelJS from "exceljs";
import { serve } from "./serve.js";

export const MAX_ROWS = 100_000;
export const MAX_COLS = 200;

export interface SheetMerge {
  r1: number;
  c1: number;
  r2: number;
  c2: number;
}

export interface SheetData {
  name: string;
  rows: string[][];
  merges: SheetMerge[];
  truncatedRows: boolean;
  truncatedCols: boolean;
}

export interface SheetInput {
  data: ArrayBuffer;
}
export interface SheetOutput {
  sheets: SheetData[];
}

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

/** Formats a date with the date/time tokens of an Excel number format (UTC, as exceljs reads it). */
export function formatDate(d: Date, numFmt: string | undefined): string {
  const iso = d.toISOString();
  if (Number.isNaN(d.getTime())) return "";
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
    else if (t[0] === "d") out += t.length === 1 ? String(d.getUTCDate()) : pad(d.getUTCDate());
    else if (t[0] === "h") {
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
      const v = minute ? d.getUTCMinutes() : d.getUTCMonth() + 1;
      out += t.length === 1 ? String(v) : pad(v);
    } else if (t === "am/pm" || t === "a/p") {
      const pm = d.getUTCHours() >= 12;
      out += t === "a/p" ? (pm ? "P" : "A") : pm ? "PM" : "AM";
    } else out += tok;
  });
  return out;
}

function cellText(cell: ExcelJS.Cell): string {
  const v = cell.value;
  if (v instanceof Date) return formatDate(v, cell.numFmt);
  if (typeof v === "object" && v !== null && "result" in v && v.result instanceof Date) {
    return formatDate(v.result, cell.numFmt);
  }
  return cell.text;
}

export async function parseWorkbook(input: SheetInput): Promise<SheetOutput> {
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(input.data);
  } catch (e) {
    const why = e instanceof Error && e.message !== "" ? e.message : "unreadable";
    throw new Error(`This file is not a valid .xlsx workbook (${why})`);
  }
  const sheets: SheetData[] = [];
  for (const ws of wb.worksheets) {
    const rowCount = ws.rowCount;
    const colCount = ws.columnCount;
    const truncatedRows = rowCount > MAX_ROWS;
    const truncatedCols = colCount > MAX_COLS;
    const nRows = Math.min(rowCount, MAX_ROWS);
    const nCols = Math.min(colCount, MAX_COLS);
    const rows: string[][] = [];
    for (let r = 1; r <= nRows; r++) {
      const out: string[] = [];
      ws.getRow(r).eachCell({ includeEmpty: false }, (cell, c) => {
        if (c > nCols) return;
        while (out.length < c - 1) out.push("");
        out[c - 1] = cellText(cell);
      });
      rows.push(out);
    }
    const refs = (ws.model as { merges?: string[] }).merges ?? [];
    const merges: SheetMerge[] = [];
    for (const ref of refs) {
      const m = parseMerge(ref);
      if (m === undefined || m.r1 >= nRows || m.c1 >= nCols) continue;
      merges.push({ ...m, r2: Math.min(m.r2, nRows - 1), c2: Math.min(m.c2, nCols - 1) });
    }
    sheets.push({ name: ws.name, rows, merges, truncatedRows, truncatedCols });
  }
  return { sheets };
}

// the guard keeps the module importable from a test in a plain node process
if (typeof self !== "undefined") {
  serve<SheetInput, SheetOutput>(async (input) => ({ output: await parseWorkbook(input) }));
}
