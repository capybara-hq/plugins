/**
 * Worker side of the zip previewer, kept free of worker globals so node tests can call it.
 *
 * Zip-bomb safety: the declared sizes in a hostile archive are only claims. The central directory
 * is read with an entry cap (reading stops at the cap, whatever the end record says), an entry is
 * refused by its declared size before any byte is inflated, and inflating runs in small input
 * chunks with a byte cap (the declared size, and the archive budget): output past either aborts
 * at once.
 *
 * `verifyArchive` is the stricter gate the sheet and docx workers run before exceljs / mammoth
 * (both on JSZip, which reads non-canonical archives differently and checks sizes only at the end).
 */
import { Inflate } from "fflate";
import type {
  ZipEntry,
  ZipErrorCode,
  ZipExtractInput,
  ZipListInput,
  ZipListOutput,
} from "../shared/zip.js";

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

export interface Raw {
  index: number;
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

export class Invalid extends Error {}

/** An error whose message is a `ZipErrorCode`: the renderer words it in the person's language. */
function fail(code: ZipErrorCode): Error {
  return new Error(code);
}

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
export function readDirectory(data: ArrayBuffer, max: number): { entries: Raw[]; more: boolean } {
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
      index: entries.length,
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
  // an end record that counts more records than the directory yields (up to the cap) is corrupt
  const claimed = view.getUint16(eocd + 10, true);
  if (claimed > 0 && claimed !== 0xffff && entries.length < Math.min(claimed, max)) {
    throw new Invalid("corrupt central directory");
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
    index: r.index,
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

export function extractEntry(input: Pick<ZipExtractInput, "data" | "index" | "budget">): {
  data: ArrayBuffer;
} {
  let dir: { entries: Raw[]; more: boolean };
  try {
    dir = readDirectory(input.data, MAX_ENTRIES);
  } catch (e) {
    if (e instanceof Invalid) throw fail("invalid");
    throw e;
  }
  const entry = dir.entries[input.index];
  if (entry === undefined || entry.dir) throw fail("not-found");
  if (entry.encrypted) throw fail("encrypted");
  // refuse by the declared size before anything is inflated
  if (entry.size > ENTRY_LIMIT) throw fail("entry-too-large");
  if (entry.size > input.budget) throw fail("limit");
  if (entry.method !== 0 && entry.method !== 8) throw fail("unsupported-method");
  const view = new DataView(input.data);
  if (entry.offset + 30 > view.byteLength || view.getUint32(entry.offset, true) !== LOCAL_SIG) {
    throw fail("corrupt");
  }
  const start =
    entry.offset +
    30 +
    view.getUint16(entry.offset + 26, true) +
    view.getUint16(entry.offset + 28, true);
  const end = start + entry.compressed;
  if (end > view.byteLength) throw fail("corrupt");
  const src = new Uint8Array(input.data, start, entry.compressed);

  let out: Uint8Array;
  if (entry.method === 0) {
    if (entry.compressed !== entry.size) throw fail("corrupt");
    out = src.slice();
  } else {
    // the declared size is the cap: a larger actual output aborts the inflate mid-stream
    try {
      out = inflateCapped(src, entry.size, () => fail("corrupt"));
    } catch (e) {
      if (e instanceof Error && e.message === "corrupt") throw e;
      throw fail("corrupt");
    }
    if (out.length !== entry.size) throw fail("corrupt");
  }
  return { data: out.buffer as ArrayBuffer };
}

/** What `verifyArchive` allows before exceljs / mammoth (both on JSZip) see an archive. */
export interface ArchiveLimits {
  /** Largest declared uncompressed size of one entry. */
  entryMax: number;
  /** Largest declared uncompressed total of all entries. */
  totalMax: number;
  /** Most central directory records. */
  maxEntries: number;
}

export type ArchiveVerdict = { ok: true } | { ok: false; reason: "too-large" | "invalid" };

const ZIP64_LOCATOR_SIG = 0x07064b50;
const DESCRIPTOR_SIG = 0x08074b50;
const MAX16 = 0xffff;
const MAX32 = 0xffffffff;
/** Encrypted (bit 0), strong encryption (bit 6), masked local headers (bit 13). */
const ENCRYPTION_FLAGS = 0x0001 | 0x0040 | 0x2000;
const DESCRIPTOR_FLAG = 0x0008;

class TooLarge extends Error {}

interface Checked {
  method: number;
  size: number;
  /** The compressed bytes JSZip reads for this entry (from the local header, by the CD size). */
  start: number;
  compressed: number;
}

/**
 * The central directory of an archive in the one canonical shape where our reading and JSZip's
 * (`lib/zipEntries.js`, `lib/zipEntry.js` in jszip 3.10) provably agree; throws `Invalid` for
 * anything else and `TooLarge` past `maxEntries`.
 */
function canonicalEntries(data: Uint8Array, maxEntries: number): Checked[] {
  const len = data.byteLength;
  const view = new DataView(data.buffer, data.byteOffset, len);
  if (len < EOCD_MIN) throw new Invalid("too short");
  // JSZip takes the LAST end record signature in the whole file (`lastIndexOfSignature`); the
  // record there must end exactly at the end of the file, so no second one hides in the comment
  let eocd = -1;
  for (let i = len - 4; i >= 0; i--) {
    if (view.getUint32(i, true) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0 || eocd + EOCD_MIN > len) throw new Invalid("no end record");
  if (eocd + EOCD_MIN + view.getUint16(eocd + 20, true) !== len) {
    throw new Invalid("bytes after the end record");
  }
  const disk = view.getUint16(eocd + 4, true);
  const cdDisk = view.getUint16(eocd + 6, true);
  const onDisk = view.getUint16(eocd + 8, true);
  const records = view.getUint16(eocd + 10, true);
  const cdSize = view.getUint32(eocd + 12, true);
  const cdOffset = view.getUint32(eocd + 16, true);
  // any 0xFFFF / 0xFFFFFFFF here switches JSZip to zip64 records we do not read
  if (disk !== 0 || cdDisk !== 0 || onDisk !== records || records === MAX16) {
    throw new Invalid("multi-disk or zip64 end record");
  }
  if (cdSize === MAX32 || cdOffset === MAX32) throw new Invalid("zip64 end record");
  if (eocd >= 20 && view.getUint32(eocd - 20, true) === ZIP64_LOCATOR_SIG) {
    throw new Invalid("zip64 locator");
  }
  // anything else makes JSZip shift every offset ("prepended bytes") or fail
  if (cdOffset + cdSize !== eocd) throw new Invalid("directory does not end at the end record");
  if (records > maxEntries) throw new TooLarge("too many entries");

  const entries: Checked[] = [];
  /** [start, end) of each entry's local header, data and descriptor. */
  const spans: [number, number][] = [];
  let at = cdOffset;
  for (let n = 0; n < records; n++) {
    if (at + CD_FIXED > eocd || view.getUint32(at, true) !== CD_SIG) {
      throw new Invalid("fewer records than counted");
    }
    const flags = view.getUint16(at + 8, true);
    const method = view.getUint16(at + 10, true);
    const crc = view.getUint32(at + 16, true);
    const compressed = view.getUint32(at + 20, true);
    const size = view.getUint32(at + 24, true);
    const nameLen = view.getUint16(at + 28, true);
    const next =
      at + CD_FIXED + nameLen + view.getUint16(at + 30, true) + view.getUint16(at + 32, true);
    const startDisk = view.getUint16(at + 34, true);
    const offset = view.getUint32(at + 42, true);
    if (next > eocd) throw new Invalid("truncated record");
    if (compressed === MAX32 || size === MAX32 || offset === MAX32 || startDisk !== 0) {
      throw new Invalid("zip64 or multi-disk record");
    }
    if ((flags & ENCRYPTION_FLAGS) !== 0) throw new Invalid("encrypted");
    if (method !== 0 && method !== 8) throw new Invalid("unsupported method");

    // the local header JSZip reads: signature, then name and extra lengths at +26 / +28
    if (offset + 30 > cdOffset || view.getUint32(offset, true) !== LOCAL_SIG) {
      throw new Invalid("no local header");
    }
    if (view.getUint16(offset + 8, true) !== method) throw new Invalid("local method differs");
    if (view.getUint16(offset + 26, true) !== nameLen) throw new Invalid("local name differs");
    for (let i = 0; i < nameLen; i++) {
      if (data[offset + 30 + i] !== data[at + CD_FIXED + i])
        throw new Invalid("local name differs");
    }
    const start = offset + 30 + nameLen + view.getUint16(offset + 28, true);
    let end = start + compressed;
    if (end > cdOffset) throw new Invalid("entry data out of bounds");
    const localCompressed = view.getUint32(offset + 18, true);
    if ((flags & DESCRIPTOR_FLAG) === 0) {
      if (localCompressed !== compressed) throw new Invalid("local size differs");
    } else {
      // sizes follow the data (streaming writers: Java / POI, .NET, fflate's Zip, JSZip
      // streamFiles); the local fields are zero or already right, the descriptor must repeat the
      // directory's sizes (with or without its optional signature)
      if (localCompressed !== 0 && localCompressed !== compressed) {
        throw new Invalid("local size differs");
      }
      const matches = (d: number) =>
        d + 12 <= cdOffset &&
        view.getUint32(d, true) === crc &&
        view.getUint32(d + 4, true) === compressed &&
        view.getUint32(d + 8, true) === size;
      if (end + 4 <= cdOffset && view.getUint32(end, true) === DESCRIPTOR_SIG && matches(end + 4)) {
        end += 16;
      } else if (matches(end)) {
        end += 12;
      } else {
        throw new Invalid("data descriptor differs");
      }
    }
    spans.push([offset, end]);
    entries.push({ method, size, start, compressed });
    at = next;
  }
  // JSZip reads records while the signature repeats: the next one must be the end record
  if (at !== eocd) throw new Invalid("more records than counted");
  spans.sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < spans.length; i++) {
    if ((spans[i] as [number, number])[0] < (spans[i - 1] as [number, number])[1]) {
      throw new Invalid("entries overlap");
    }
  }
  return entries;
}

/**
 * Inflates `src` in `CHUNK` input slices only to count the output, which is discarded: memory is
 * one push's output. More than `cap` bytes throws `TooLarge` at once.
 */
function inflatedSize(src: Uint8Array, cap: number): number {
  let total = 0;
  const inflater = new Inflate((chunk) => {
    total += chunk.length;
    if (total > cap) throw new TooLarge("entry inflates past its declared size");
  });
  if (src.length === 0) inflater.push(new Uint8Array(0), true);
  for (let i = 0; i < src.length; i += CHUNK) {
    inflater.push(src.subarray(i, i + CHUNK), i + CHUNK >= src.length);
  }
  return total;
}

/**
 * Proves an xlsx / docx archive safe for JSZip before exceljs / mammoth load it (ruling R21).
 * JSZip inflates a whole entry before it compares the declared size and parses a different
 * directory than a naive reader for non-canonical archives, so: (a) the structure must be the
 * canonical one both readers agree on (`canonicalEntries`), (b) the declared sizes must fit the
 * limits, and (c) every entry is inflated once here, counted against its declared size.
 */
export function verifyArchive(data: Uint8Array, limits: ArchiveLimits): ArchiveVerdict {
  try {
    const entries = canonicalEntries(data, limits.maxEntries);
    let total = 0;
    for (const e of entries) {
      total += e.size;
      if (e.size > limits.entryMax || total > limits.totalMax) throw new TooLarge("declared size");
    }
    for (const e of entries) {
      const src = data.subarray(e.start, e.start + e.compressed);
      if (e.method === 0) {
        if (e.compressed !== e.size) throw new Invalid("stored size differs");
        continue;
      }
      let actual: number;
      try {
        actual = inflatedSize(src, e.size);
      } catch (err) {
        if (err instanceof TooLarge) throw err;
        throw new Invalid("corrupt deflate stream");
      }
      if (actual !== e.size) throw new Invalid("inflated size differs");
    }
    return { ok: true };
  } catch (err) {
    if (err instanceof TooLarge) return { ok: false, reason: "too-large" };
    if (err instanceof Invalid) return { ok: false, reason: "invalid" };
    throw err;
  }
}
