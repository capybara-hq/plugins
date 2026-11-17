/** The `sheet` worker's wire types and limits (shared by the app and the worker TypeScript projects). */

/** Rows and columns kept per sheet. */
export const MAX_ROWS = 100_000;
export const MAX_COLS = 200;
/** Cells (values) kept across all sheets of one workbook. */
export const MAX_CELLS = 2_000_000;
/**
 * One entry's declared (and verified) uncompressed size, and the total, beyond which we refuse.
 * A sheet is one entry: a 20 MiB numeric workbook inflates its sheet to about 80 MiB (ruling R22).
 */
export const MAX_ENTRY_BYTES = 120 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 150 * 1024 * 1024;

export interface SheetMerge {
  r1: number;
  c1: number;
  r2: number;
  c2: number;
}

export interface SheetData {
  name: string;
  /** A hidden (or very hidden) sheet in the workbook. */
  hidden: boolean;
  rows: string[][];
  merges: SheetMerge[];
  truncatedRows: boolean;
  truncatedCols: boolean;
  /** The workbook-wide cell budget ran out in or before this sheet. */
  truncatedCells: boolean;
}

export interface SheetInput {
  data: ArrayBuffer;
}

export interface SheetOutput {
  sheets: SheetData[];
  /** `invalid`: not a readable .xlsx workbook; `too-large`: its declared uncompressed size is over the
   * limit (refused before parsing). The renderer words the reason. */
  error?: "invalid" | "too-large";
}
