/**
 * Worker side of the zip previewer, kept free of worker globals so node tests can call it.
 *
 * Zip-bomb safety: the declared sizes in a hostile archive are only claims. The central directory
 * is read with an entry cap (reading stops at the cap, whatever the end record says), an entry is
 * refused by its declared size before any byte is inflated, and inflating runs in small input
 * chunks with a byte cap (the declared size, and the archive budget): output past either aborts
 * at once.
 */
import { Inflate } from "fflate";
import type { ZipEntry, ZipExtractInput, ZipListInput, ZipListOutput } from "../shared/zip.js";

export const MAX_ENTRIES = 10_000;
/** The largest entry the previewer inflates, by its declared size. */
export const ENTRY_LIMIT = 20 * 1024 * 1024;
/** Decompressed bytes per opened archive. */
export const ARCHIVE_LIMIT = 100 * 1024 * 1024;

const EOCD_SIG = 0x06054b50;
const CD_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;
const EOCD_MIN = 22;
const CD_FIXED = 46;
/** Input fed to the inflater at a time: bounds the output of one push (about 1000:1). */
const CHUNK = 4096;

interface Raw {
  path: string;
  size: number;
  compressed: number;
  modified: string;
  encrypted: boolean;
  dir: boolean;
  method: number;
  offset: number;
}

const pad = (n: number) => String(n).padStart(2, "0");

function dosDate(date: number, time: number): string {
  if (date === 0) return "";
  const month = (date >> 5) & 15;
  const day = date & 31;
  if (month < 1 || month > 12 || day < 1) return "";
  return `${1980 + (date >> 9)}-${pad(month)}-${pad(day)} ${pad((time >> 11) & 31)}:${pad((time >> 5) & 63)}`;
}

class Invalid extends Error {}

function findEocd(view: DataView): number {
  const min = Math.max(0, view.byteLength - EOCD_MIN - 0xffff);
  for (let i = view.byteLength - EOCD_MIN; i >= min; i--) {
    if (view.getUint32(i, true) === EOCD_SIG) return i;
  }
  return -1;
}

/**
 * Reads the central directory, at most `max` entries. `more` is true when the directory holds
 * another record after the cap. Throws `Invalid` for bytes that are not a zip archive.
 */
function readDirectory(data: ArrayBuffer, max: number): { entries: Raw[]; more: boolean } {
  const view = new DataView(data);
  const eocd = data.byteLength >= EOCD_MIN ? findEocd(view) : -1;
  if (eocd < 0) throw new Invalid("no end of central directory");
  const cdSize = view.getUint32(eocd + 12, true);
  const cdOffset = view.getUint32(eocd + 16, true);
  if (cdOffset === 0xffffffff || cdSize === 0xffffffff) throw new Invalid("zip64 is not supported");
  const cdEnd = Math.min(eocd, cdOffset + cdSize);
  if (cdOffset > eocd) throw new Invalid("bad central directory offset");
  const decoder = new TextDecoder("utf-8");
  const entries: Raw[] = [];
  let at = cdOffset;
  while (at + CD_FIXED <= cdEnd && view.getUint32(at, true) === CD_SIG) {
    if (entries.length >= max) return { entries, more: true };
    const flags = view.getUint16(at + 8, true);
    const nameLen = view.getUint16(at + 28, true);
    const extraLen = view.getUint16(at + 30, true);
    const commentLen = view.getUint16(at + 32, true);
    const next = at + CD_FIXED + nameLen + extraLen + commentLen;
    if (next > cdEnd) throw new Invalid("truncated central directory");
    const path = decoder.decode(new Uint8Array(data, at + CD_FIXED, nameLen));
    entries.push({
      path,
      size: view.getUint32(at + 24, true),
      compressed: view.getUint32(at + 20, true),
      modified: dosDate(view.getUint16(at + 14, true), view.getUint16(at + 12, true)),
      encrypted: (flags & 1) !== 0,
      dir: path.endsWith("/"),
      method: view.getUint16(at + 10, true),
      offset: view.getUint32(at + 42, true),
    });
    at = next;
  }
  return { entries, more: false };
}

/** Folders before files at every level of the path, then by name. */
function compare(a: ZipEntry, b: ZipEntry): number {
  const pa = a.path.split("/").filter((s) => s !== "");
  const pb = b.path.split("/").filter((s) => s !== "");
  for (let i = 0; i < Math.min(pa.length, pb.length); i++) {
    const sa = pa[i] as string;
    const sb = pb[i] as string;
    if (sa === sb) continue;
    const fa = i < pa.length - 1 || a.dir;
    const fb = i < pb.length - 1 || b.dir;
    if (fa !== fb) return fa ? -1 : 1;
    return sa < sb ? -1 : 1;
  }
  return pa.length - pb.length;
}

export function listEntries(input: Pick<ZipListInput, "data">): ZipListOutput {
  let dir: { entries: Raw[]; more: boolean };
  try {
    dir = readDirectory(input.data, MAX_ENTRIES);
  } catch (e) {
    if (e instanceof Invalid) return { entries: [], truncated: false, error: "invalid" };
    throw e;
  }
  const entries: ZipEntry[] = dir.entries.map((r) => ({
    path: r.path,
    size: r.size,
    compressed: r.compressed,
    modified: r.modified,
    encrypted: r.encrypted,
    dir: r.dir,
  }));
  entries.sort(compare);
  return { entries, truncated: dir.more };
}

/** Inflates `src` into at most `cap` bytes; throws with `over` as soon as the output exceeds it. */
function inflateCapped(src: Uint8Array, cap: number, over: () => Error): Uint8Array {
  const chunks: Uint8Array[] = [];
  let total = 0;
  const inflater = new Inflate((chunk) => {
    total += chunk.length;
    if (total > cap) throw over();
    chunks.push(chunk);
  });
  if (src.length === 0) inflater.push(new Uint8Array(0), true);
  for (let i = 0; i < src.length; i += CHUNK) {
    inflater.push(src.subarray(i, i + CHUNK), i + CHUNK >= src.length);
  }
  const out = new Uint8Array(total);
  let pos = 0;
  for (const c of chunks) {
    out.set(c, pos);
    pos += c.length;
  }
  return out;
}

export function extractEntry(input: Pick<ZipExtractInput, "data" | "path" | "budget">): {
  data: ArrayBuffer;
} {
  let dir: { entries: Raw[]; more: boolean };
  try {
    dir = readDirectory(input.data, MAX_ENTRIES);
  } catch (e) {
    if (e instanceof Invalid) throw new Error("This is not a valid zip archive");
    throw e;
  }
  const entry = dir.entries.find((r) => r.path === input.path && !r.dir);
  if (entry === undefined) throw new Error("entry not found");
  if (entry.encrypted) throw new Error("entry is encrypted");
  // refuse by the declared size before anything is inflated
  if (entry.size > ENTRY_LIMIT) throw new Error("entry too large");
  if (entry.size > input.budget) throw new Error("archive limit reached");
  if (entry.method !== 0 && entry.method !== 8) {
    throw new Error(`unsupported compression method ${entry.method}`);
  }
  const view = new DataView(input.data);
  if (entry.offset + 30 > view.byteLength || view.getUint32(entry.offset, true) !== LOCAL_SIG) {
    throw new Error("corrupt entry header");
  }
  const start =
    entry.offset +
    30 +
    view.getUint16(entry.offset + 26, true) +
    view.getUint16(entry.offset + 28, true);
  const end = start + entry.compressed;
  if (end > view.byteLength) throw new Error("entry data is truncated");
  const src = new Uint8Array(input.data, start, entry.compressed);

  let out: Uint8Array;
  if (entry.method === 0) {
    if (entry.compressed !== entry.size) throw new Error("entry size does not match its header");
    out = src.slice();
  } else {
    // the declared size is the cap: a larger actual output aborts the inflate mid-stream
    const cap = Math.min(entry.size, input.budget);
    try {
      out = inflateCapped(src, cap, () =>
        entry.size <= input.budget
          ? new Error("entry is larger than declared")
          : new Error("archive limit reached"),
      );
    } catch (e) {
      if (e instanceof Error && /declared|limit reached/.test(e.message)) throw e;
      throw new Error("entry data is corrupt");
    }
    if (out.length !== entry.size) throw new Error("entry size does not match its header");
  }
  return { data: out.buffer as ArrayBuffer };
}
