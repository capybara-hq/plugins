/** The `sheet` worker's wire types (shared by the app and the worker TypeScript projects). */

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
