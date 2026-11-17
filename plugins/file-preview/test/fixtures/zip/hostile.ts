/**
 * Hostile archives for the xlsx / docx pre-check (ruling R21), built in the test from real
 * archives. Each one makes JSZip (what exceljs and mammoth parse with) see something other than
 * what a naive central-directory reader sees, or lies about a size JSZip only checks at the end.
 */
import { createRequire } from "node:module";
import { unzipSync, Zip, ZipDeflate, zipSync } from "fflate";

const EOCD_SIG = 0x06054b50;
const CD_SIG = 0x02014b50;

/** JSZip as exceljs and mammoth load it (one instance in the workspace): spy on `loadAsync`. */
export function jszip(): { loadAsync: (...args: unknown[]) => Promise<unknown> } & (new () => {
  file(name: string, data: unknown, opts?: object): unknown;
  generateAsync(opts: object): Promise<Uint8Array>;
}) {
  const fromPlugin = createRequire(import.meta.url);
  return createRequire(fromPlugin.resolve("exceljs"))("jszip");
}

export const u8 = (b: ArrayBuffer | Uint8Array): Uint8Array =>
  b instanceof Uint8Array ? b : new Uint8Array(b);

export const ab = (u: Uint8Array): ArrayBuffer =>
  u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;

export function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

const view = (z: Uint8Array) => new DataView(z.buffer, z.byteOffset, z.byteLength);

/** The end record of an archive without a comment, and the directory it points at. */
export function eocdOf(z: Uint8Array): { eocd: number; cdOffset: number; cdSize: number } {
  const v = view(z);
  let eocd = z.length - 22;
  while (v.getUint32(eocd, true) !== EOCD_SIG) eocd--;
  return { eocd, cdOffset: v.getUint32(eocd + 16, true), cdSize: v.getUint32(eocd + 12, true) };
}

/** Offsets of the central directory records, in directory order. */
export function cdRecords(z: Uint8Array): number[] {
  const v = view(z);
  const out: number[] = [];
  let at = eocdOf(z).cdOffset;
  while (at + 4 <= z.length && v.getUint32(at, true) === CD_SIG) {
    out.push(at);
    at += 46 + v.getUint16(at + 28, true) + v.getUint16(at + 30, true) + v.getUint16(at + 32, true);
  }
  return out;
}

export function nameAt(z: Uint8Array, at: number): string {
  return new TextDecoder().decode(z.subarray(at + 46, at + 46 + view(z).getUint16(at + 28, true)));
}

/** Rewrites one entry's uncompressed size in the central directory: a claim costs nothing. */
export function lyingSize(z: Uint8Array, path: string, declared: number): Uint8Array {
  const copy = z.slice();
  const at = cdRecords(copy).find((r) => nameAt(copy, r) === path);
  if (at === undefined) throw new Error(`no entry ${path}`);
  view(copy).setUint32(at + 24, declared, true);
  return copy;
}

/** Re-zips an archive (fflate) with extra entries. */
export function withEntries(z: Uint8Array, extra: Record<string, Uint8Array>): Uint8Array {
  return zipSync({ ...unzipSync(z), ...extra });
}

/** Re-zips an archive with fflate's streaming writer: every entry has a data descriptor (bit 3). */
export function streamed(z: Uint8Array): Uint8Array {
  const chunks: Uint8Array[] = [];
  const zip = new Zip((err, chunk) => {
    if (err) throw err;
    chunks.push(chunk);
  });
  for (const [name, data] of Object.entries(unzipSync(z))) {
    const f = new ZipDeflate(name, { level: 6 });
    zip.add(f);
    f.push(data, true);
  }
  zip.end();
  return concat(chunks);
}

/**
 * The reviewer's decoy (PoC "diff"): the real archive `real` follows a prefix that holds the decoy
 * archive's entries and, at exactly the offset `real`'s own end record names, the decoy's central
 * directory. A reader that takes the offsets as written validates the decoy; JSZip sees that the
 * directory does not end at the end record, treats the gap as prepended bytes and parses `real`.
 */
export function decoyDirectory(decoy: Uint8Array, real: Uint8Array): Uint8Array {
  const a = eocdOf(decoy);
  const b = eocdOf(real);
  if (a.cdOffset > b.cdOffset)
    throw new Error("the decoy's entries must fit before real's directory");
  const gap = b.cdOffset + b.cdSize;
  const out = new Uint8Array(gap + real.length);
  out.set(decoy.subarray(0, a.cdOffset), 0);
  out.set(decoy.subarray(a.cdOffset, a.cdOffset + a.cdSize), b.cdOffset);
  out.set(real, gap);
  return out;
}

/**
 * The zip64 switch: the end record counts 0xFFFF records, so JSZip follows the zip64 locator to a
 * zip64 end record that names the real directory, while the 32-bit end record names a decoy copy
 * of it whose records declare 1 byte each.
 */
export function zip64Switch(real: Uint8Array): Uint8Array {
  const { cdOffset, cdSize } = eocdOf(real);
  const entries = real.subarray(0, cdOffset);
  const cd = real.subarray(cdOffset, cdOffset + cdSize);
  const decoy = cd.slice();
  const dv = view(decoy);
  for (let at = 0; at < decoy.length; ) {
    dv.setUint32(at + 24, 1, true);
    at +=
      46 + dv.getUint16(at + 28, true) + dv.getUint16(at + 30, true) + dv.getUint16(at + 32, true);
  }
  const decoyAt = cdOffset;
  const realAt = cdOffset + decoy.length;
  const z64At = realAt + cd.length;
  const count = cdRecords(real).length;
  const z64 = new Uint8Array(56);
  const zv = view(z64);
  zv.setUint32(0, 0x06064b50, true);
  zv.setBigUint64(4, 44n, true);
  zv.setUint16(12, 45, true);
  zv.setUint16(14, 45, true);
  zv.setBigUint64(24, BigInt(count), true);
  zv.setBigUint64(32, BigInt(count), true);
  zv.setBigUint64(40, BigInt(cd.length), true);
  zv.setBigUint64(48, BigInt(realAt), true);
  const locator = new Uint8Array(20);
  const lv = view(locator);
  lv.setUint32(0, 0x07064b50, true);
  lv.setBigUint64(8, BigInt(z64At), true);
  lv.setUint32(16, 1, true);
  const eocd = new Uint8Array(22);
  const ev = view(eocd);
  ev.setUint32(0, EOCD_SIG, true);
  ev.setUint16(8, 0xffff, true);
  ev.setUint16(10, 0xffff, true);
  ev.setUint32(12, decoy.length, true);
  ev.setUint32(16, decoyAt, true);
  return concat([entries, decoy, cd, z64, locator, eocd]);
}

/** `n` bytes before an archive whose offsets were not adjusted (JSZip shifts them by `n`). */
export function prepended(real: Uint8Array, n = 1024): Uint8Array {
  return concat([new Uint8Array(n).fill(0x20), real]);
}
