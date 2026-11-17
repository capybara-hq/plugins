/** The `sheet` worker's wire types (shared by the app and the worker TypeScript projects). */

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
