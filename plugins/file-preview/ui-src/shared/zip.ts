/** The `zip` worker's wire types (shared by the app and the worker TypeScript projects). */

/** Why a worker refused: the renderer words each code (zh / en). */
export type ZipErrorCode =
  | "invalid"
  | "entry-too-large"
  | "limit"
  | "corrupt"
  | "unsupported-method"
  | "encrypted"
  | "not-found";

export interface ZipEntry {
  /** The record's position in the central directory: extraction is by index, names can repeat. */
  index: number;
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
  /** The entry's `ZipEntry.index`. */
  index: number;
  /**
   * The decompressed bytes the renderer reserved for this entry. A worker lives for one request,
   * so the renderer keeps the archive's running total and reserves before it asks.
   */
  budget: number;
}

export interface ZipExtractOutput {
  data: ArrayBuffer;
}

export type ZipInput = ZipListInput | ZipExtractInput;
export type ZipOutput = ZipListOutput | ZipExtractOutput;
