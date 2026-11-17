import ExcelJS from "exceljs";
import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { verifyArchive } from "../ui-src/workers/zip.logic.js";
import { fullDocx } from "./fixtures/docx/make.js";
import {
  cdRecords,
  concat,
  decoyDirectory,
  eocdOf,
  jszip,
  lyingSize,
  prepended,
  streamed,
  u8,
  withEntries,
  zip64Switch,
} from "./fixtures/zip/hostile.js";

const MiB = 1024 * 1024;
const LIMITS = { entryMax: 50 * MiB, totalMax: 150 * MiB, maxEntries: 10_000 };
const ok = { ok: true };
const invalid = { ok: false, reason: "invalid" };
const tooLarge = { ok: false, reason: "too-large" };

const dv = (z: Uint8Array) => new DataView(z.buffer, z.byteOffset, z.byteLength);

function small(): Uint8Array {
  return zipSync({
    "a.txt": strToU8("hello hello hello hello"),
    "dir/": new Uint8Array(0),
    "dir/b.txt": strToU8("b".repeat(1000)),
    "c.bin": new Uint8Array([1, 2, 3]),
  });
}

/** Copy of `z` with `fn` applied to the central directory record `i` and the end record. */
function patch(
  z: Uint8Array,
  fn: (v: DataView, at: { cd: number[]; eocd: number; local: number[] }) => void,
): Uint8Array {
  const copy = z.slice();
  const v = dv(copy);
  const cd = cdRecords(copy);
  const local = cd.map((at) => v.getUint32(at + 42, true));
  fn(v, { cd, eocd: eocdOf(copy).eocd, local });
  return copy;
}

const verify = (z: Uint8Array, limits = LIMITS) => verifyArchive(z, limits);

describe("verifyArchive accepts what real writers produce", () => {
  it("fflate archives, stored and deflated, with a directory entry", () => {
    expect(verify(small())).toEqual(ok);
    expect(verify(zipSync({ "s.txt": strToU8("stored") }, { level: 0 }))).toEqual(ok);
  });

  it("an empty archive", () => {
    expect(verify(zipSync({}))).toEqual(ok);
  });

  it("an exceljs workbook and an fflate docx", async () => {
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet("S").addRow(["a", 1]);
    expect(verify(u8((await wb.xlsx.writeBuffer()) as ArrayBuffer))).toEqual(ok);
    expect(verify(u8(fullDocx()))).toEqual(ok);
  });

  it("data descriptors (bit 3) from fflate's streaming writer and from JSZip", async () => {
    expect(verify(streamed(small()))).toEqual(ok);
    const JSZip = jszip();
    const j = new JSZip();
    j.file("a.txt", "hello ".repeat(100));
    j.file("d/", null, { dir: true });
    const out = await j.generateAsync({
      type: "uint8array",
      compression: "DEFLATE",
      streamFiles: true,
    });
    expect(dv(out).getUint16(6, true) & 8).toBe(8);
    expect(verify(out)).toEqual(ok);
  });

  it("an archive comment and extra fields that differ between local and central records", () => {
    const z = zipSync({
      "a.txt": [strToU8("x".repeat(100)), { extra: { 21589: new Uint8Array([1, 2, 3, 4, 5]) } }],
    });
    expect(verify(z)).toEqual(ok);
    // a different central extra field (as Office's writers do with timestamps) is fine
    const e = eocdOf(z);
    const comment = strToU8("an archive comment");
    const withComment = concat([z, comment]);
    dv(withComment).setUint16(e.eocd + 20, comment.length, true);
    expect(verify(withComment)).toEqual(ok);
  });
});

describe("verifyArchive: canonical structure", () => {
  it("refuses bytes that are not a zip", () => {
    expect(verify(strToU8("PK\u0003\u0004 not really a zip"))).toEqual(invalid);
    expect(verify(new Uint8Array(0))).toEqual(invalid);
  });

  it("refuses bytes after the end record (the comment length must reach the end)", () => {
    expect(verify(concat([small(), new Uint8Array(3)]))).toEqual(invalid);
  });

  it("refuses an end record signature inside the comment (JSZip takes the last one)", () => {
    const z = small();
    const e = eocdOf(z);
    const comment = new Uint8Array(30);
    dv(comment).setUint32(4, 0x06054b50, true);
    const out = concat([z, comment]);
    dv(out).setUint16(e.eocd + 20, comment.length, true);
    expect(verify(out)).toEqual(invalid);
  });

  it("refuses non-zero disk fields and a disk count unequal to the total", () => {
    expect(verify(patch(small(), (v, a) => v.setUint16(a.eocd + 4, 1, true)))).toEqual(invalid);
    expect(verify(patch(small(), (v, a) => v.setUint16(a.eocd + 6, 1, true)))).toEqual(invalid);
    expect(verify(patch(small(), (v, a) => v.setUint16(a.eocd + 8, 3, true)))).toEqual(invalid);
  });

  it("refuses 0xFFFF / 0xFFFFFFFF end record fields (JSZip's zip64 switch)", () => {
    const z = small();
    for (const [off, w] of [
      [8, 2],
      [10, 2],
      [12, 4],
      [16, 4],
    ] as const) {
      const p = patch(z, (v, a) =>
        w === 2
          ? v.setUint16(a.eocd + off, 0xffff, true)
          : v.setUint32(a.eocd + off, -1 >>> 0, true),
      );
      expect(verify(p)).toEqual(invalid);
    }
  });

  it("accepts a directory comment that ends in a zip64 locator signature (fields decide, not bytes)", () => {
    // the last record's comment ends in the 20 bytes a zip64 locator would occupy; JSZip switches
    // to zip64 only on 0xFFFF / 0xFFFFFFFF end record fields, which are refused above
    const tail = `PK\u0006\u0007${"\u0000".repeat(16)}`;
    const z = zipSync({ "a.txt": [strToU8("a"), { comment: tail }] });
    expect(dv(z).getUint32(eocdOf(z).eocd - 20, true)).toBe(0x07064b50);
    expect(verify(z)).toEqual(ok);
  });

  it("refuses a directory that does not end exactly at the end record", () => {
    expect(verify(prepended(small()))).toEqual(invalid);
    expect(
      verify(
        patch(small(), (v, a) =>
          v.setUint32(a.eocd + 12, v.getUint32(a.eocd + 12, true) - 1, true),
        ),
      ),
    ).toEqual(invalid);
    expect(
      verify(
        patch(small(), (v, a) =>
          v.setUint32(a.eocd + 16, v.getUint32(a.eocd + 16, true) + 1, true),
        ),
      ),
    ).toEqual(invalid);
  });

  it("refuses a record count unequal to the records read", () => {
    const more = patch(small(), (v, a) => {
      v.setUint16(a.eocd + 8, 5, true);
      v.setUint16(a.eocd + 10, 5, true);
    });
    const fewer = patch(small(), (v, a) => {
      v.setUint16(a.eocd + 8, 3, true);
      v.setUint16(a.eocd + 10, 3, true);
    });
    expect(verify(more)).toEqual(invalid);
    expect(verify(fewer)).toEqual(invalid);
  });

  it("refuses a truncated directory record", () => {
    const p = patch(small(), (v, a) => v.setUint16((a.cd.at(-1) as number) + 28, 200, true));
    expect(verify(p)).toEqual(invalid);
  });

  it("refuses 0xFFFFFFFF sizes or offsets and a non-zero start disk in a record", () => {
    for (const off of [20, 24, 42]) {
      expect(
        verify(patch(small(), (v, a) => v.setUint32((a.cd[0] as number) + off, -1 >>> 0, true))),
      ).toEqual(invalid);
    }
    expect(
      verify(patch(small(), (v, a) => v.setUint16((a.cd[0] as number) + 34, 1, true))),
    ).toEqual(invalid);
  });

  it("refuses a record whose local header is missing or names something else", () => {
    expect(verify(patch(small(), (v, a) => v.setUint32(a.local[0] as number, 0, true)))).toEqual(
      invalid,
    );
    // same length, different name
    expect(verify(patch(small(), (v, a) => v.setUint8((a.local[0] as number) + 30, 0x7a)))).toEqual(
      invalid,
    );
    // different name length
    expect(
      verify(patch(small(), (v, a) => v.setUint16((a.local[0] as number) + 26, 4, true))),
    ).toEqual(invalid);
  });

  it("refuses a local compressed size unequal to the directory's (no data descriptor)", () => {
    const p = patch(small(), (v, a) => {
      const at = (a.local[0] as number) + 18;
      v.setUint32(at, v.getUint32(at, true) + 1, true);
    });
    expect(verify(p)).toEqual(invalid);
  });

  it("refuses a data descriptor that does not repeat the directory's sizes", () => {
    const z = streamed(small());
    const recs = cdRecords(z);
    const v = dv(z);
    const at = recs[0] as number;
    const local = v.getUint32(at + 42, true);
    const end =
      local +
      30 +
      v.getUint16(local + 26, true) +
      v.getUint16(local + 28, true) +
      v.getUint32(at + 20, true);
    const bad = z.slice();
    // descriptor: signature, crc, compressed, uncompressed
    dv(bad).setUint32(end + 12, v.getUint32(end + 12, true) + 1, true);
    expect(verify(bad)).toEqual(invalid);
  });

  it("refuses a local method that differs from the directory's", () => {
    // `small()` deflates a.txt; the local header claims "stored"
    const z = small();
    expect(verify(z)).toEqual(ok);
    expect(verify(patch(z, (v, a) => v.setUint16((a.local[0] as number) + 8, 0, true)))).toEqual(
      invalid,
    );
  });

  it("refuses strong encryption (bit 6) and masked local headers (bit 13)", () => {
    for (const bit of [0x0040, 0x2000]) {
      const p = patch(small(), (v, a) => {
        const at = (a.cd[0] as number) + 8;
        v.setUint16(at, v.getUint16(at, true) | bit, true);
      });
      expect(verify(p), `flag 0x${bit.toString(16)}`).toEqual(invalid);
    }
  });

  it("refuses an unknown method and an encrypted entry", () => {
    expect(
      verify(patch(small(), (v, a) => v.setUint16((a.cd[0] as number) + 10, 12, true))),
    ).toEqual(invalid);
    expect(verify(patch(small(), (v, a) => v.setUint16((a.cd[0] as number) + 8, 1, true)))).toEqual(
      invalid,
    );
  });

  it("refuses a compressed range that runs into the directory", () => {
    const z = zipSync({ "a.txt": strToU8("a".repeat(50)) });
    const p = patch(z, (v, a) => {
      const big = v.getUint32((a.cd[0] as number) + 20, true) + 40;
      v.setUint32((a.cd[0] as number) + 20, big, true);
      v.setUint32((a.local[0] as number) + 18, big, true);
    });
    expect(verify(p)).toEqual(invalid);
  });

  it("refuses two records that share entry bytes", () => {
    const z = zipSync({ "a.txt": strToU8("aaaa"), "b.txt": strToU8("aaaa") });
    // b's record points at a's local header (and takes a's name so the name check passes)
    const p = patch(z, (v, a) => {
      v.setUint32((a.cd[1] as number) + 42, a.local[0] as number, true);
      v.setUint8((a.cd[1] as number) + 46, 0x61);
    });
    expect(verify(p)).toEqual(invalid);
  });
});

describe("verifyArchive: sizes", () => {
  it("refuses more records than maxEntries as too large", () => {
    expect(verify(small(), { ...LIMITS, maxEntries: 3 })).toEqual(tooLarge);
    expect(verify(small(), { ...LIMITS, maxEntries: 4 })).toEqual(ok);
  });

  it("refuses a declared size over entryMax and a declared total over totalMax", () => {
    expect(verify(small(), { ...LIMITS, entryMax: 999 })).toEqual(tooLarge);
    expect(verify(small(), { ...LIMITS, totalMax: 1000 })).toEqual(tooLarge);
    expect(verify(small(), { ...LIMITS, entryMax: 1000, totalMax: 1026 })).toEqual(ok);
  });

  it("refuses an entry that inflates past its declared size as too large", () => {
    expect(verify(lyingSize(small(), "dir/b.txt", 10))).toEqual(tooLarge);
  });

  it("refuses an entry that inflates to less than its declared size as invalid", () => {
    expect(verify(lyingSize(small(), "dir/b.txt", 1001))).toEqual(invalid);
  });

  it("refuses a stored entry whose compressed size is not its size", () => {
    const z = zipSync({ "s.txt": strToU8("stored") }, { level: 0 });
    expect(verify(lyingSize(z, "s.txt", 7))).toEqual(invalid);
  });

  it("refuses a corrupt deflate stream", () => {
    const z = zipSync({ "a.txt": strToU8("a".repeat(5000)) });
    const p = patch(z, (v, a) => {
      const data = (a.local[0] as number) + 30 + 5;
      v.setUint8(data, 0xff);
      v.setUint8(data + 1, 0xff);
    });
    expect(verify(p)).toEqual(invalid);
  });

  it("stops a lying-size bomb as soon as the output passes the claim", () => {
    // 64 MiB of zeros deflate to about 64 KiB; the directory says 1 KiB
    const bomb = lyingSize(
      withEntries(small(), { "z.bin": new Uint8Array(64 * MiB) }),
      "z.bin",
      1024,
    );
    expect(bomb.length).toBeLessThan(MiB);
    expect(verify(bomb)).toEqual(tooLarge);
  });
});

describe("verifyArchive: the reviewer's bypasses", () => {
  it("refuses the decoy directory and the zip64 switch", () => {
    const real = withEntries(small(), { "big.bin": new Uint8Array(60 * MiB) });
    const decoy = small();
    expect(verify(decoyDirectory(decoy, real))).toEqual(invalid);
    expect(verify(zip64Switch(real))).toEqual(invalid);
  });
});
