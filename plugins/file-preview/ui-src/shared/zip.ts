/** The `zip` worker's wire types (shared by the app and the worker TypeScript projects). */

export interface ZipEntry {
  /** The path inside the archive, `/`-separated; a folder ends in `/`. */
  path: string;
  /** The uncompressed size the archive declares (never trusted when inflating). */
  size: number;
  compressed: number;
  /** `YYYY-MM-DD HH:MM` from the entry's DOS time, or "" when the archive has none. */
  modified: string;
  encrypted: boolean;
  dir: boolean;
}

export interface ZipListInput {
  op: "list";
  data: ArrayBuffer;
}

export interface ZipListOutput {
  /** Folders first at every level. */
  entries: ZipEntry[];
  /** The archive has more entries than the listing cap. */
  truncated: boolean;
  /** `invalid`: not a readable zip archive (the renderer words the reason). */
  error?: "invalid";
}

export interface ZipExtractInput {
  op: "extract";
  data: ArrayBuffer;
  path: string;
  /**
   * What is left of the per-archive decompressed budget. A worker lives for one request, so the
   * renderer keeps the running counter and hands the remainder in.
   */
  budget: number;
}

export interface ZipExtractOutput {
  data: ArrayBuffer;
}

export type ZipInput = ZipListInput | ZipExtractInput;
export type ZipOutput = ZipListOutput | ZipExtractOutput;
