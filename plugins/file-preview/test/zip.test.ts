// @vitest-environment jsdom
import { strToU8, zipSync } from "fflate";
import { describe, expect, it, vi } from "vitest";
import { PREVIEWERS } from "../src/previewers.js";
import { translator } from "../ui-src/app/frame.js";
import type { PreviewFile, RenderContext } from "../ui-src/app/types.js";
import { EXTENSIONS, render } from "../ui-src/renderers/zip.js";
import type { ZipExtractInput, ZipInput, ZipListOutput } from "../ui-src/shared/zip.js";
import { highlight } from "../ui-src/workers/code.logic.js";
import {
  ARCHIVE_LIMIT,
  ENTRY_LIMIT,
  extractEntry,
  listEntries,
  MAX_ENTRIES,
} from "../ui-src/workers/zip.logic.js";

const MiB = 1024 * 1024;

function normal(): Uint8Array {
  return zipSync({
    "readme.txt": strToU8("hello"),
    "src/": new Uint8Array(0),
    "src/a/b.json": strToU8('{"k": 1}'),
    "src/main.ts": strToU8("export const x = 1;"),
    "z.txt": strToU8("z"),
  });
}

const buf = (u: Uint8Array): ArrayBuffer => u.slice().buffer as ArrayBuffer;

/** Offsets of the central directory records of an archive. */
function cdRecords(z: Uint8Array): number[] {
  const dv = new DataView(z.buffer, z.byteOffset, z.byteLength);
  const out: number[] = [];
  for (let i = 0; i + 46 <= z.length; i++) if (dv.getUint32(i, true) === 0x02014b50) out.push(i);
  return out;
}

function patchCd(z: Uint8Array, index: number, fn: (dv: DataView, at: number) => void): Uint8Array {
  const copy = z.slice();
  const at = cdRecords(copy)[index] as number;
  fn(new DataView(copy.buffer), at);
  return copy;
}

describe("listEntries", () => {
  it("sorts folders first at every level and reports size, compressed, modified, encrypted, dir", () => {
    const out = listEntries({ data: buf(normal()) });
    expect(out.error).toBeUndefined();
    expect(out.entries.map((e) => e.path)).toEqual([
      "src/",
      "src/a/b.json",
      "src/main.ts",
      "readme.txt",
      "z.txt",
    ]);
    const json = out.entries.find((e) => e.path === "src/a/b.json");
    expect(json).toMatchObject({ size: 8, dir: false, encrypted: false });
    expect(json?.modified).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d$/);
    expect(out.entries[0]?.dir).toBe(true);
    expect(out.truncated).toBe(false);
  });

  it("lists 10 000 of 10 001 entries and flags truncated", () => {
    const files: Record<string, Uint8Array> = {};
    for (let i = 0; i < MAX_ENTRIES + 1; i++) files[`f${i}.txt`] = new Uint8Array(0);
    const out = listEntries({ data: buf(zipSync(files, { level: 0 })) });
    expect(out.entries).toHaveLength(10_000);
    expect(out.truncated).toBe(true);
  });

  it("stops reading the central directory at the cap, whatever the end record claims", () => {
    const files: Record<string, Uint8Array> = {};
    for (let i = 0; i < MAX_ENTRIES + 5; i++) files[`f${i}.txt`] = new Uint8Array(0);
    const z = zipSync(files, { level: 0 });
    // claim a tiny entry count in the end record: the directory itself still decides
    const lied = z.slice();
    const dv = new DataView(lied.buffer);
    for (let i = lied.length - 22; i >= 0; i--) {
      if (dv.getUint32(i, true) === 0x06054b50) {
        dv.setUint16(i + 8, 1, true);
        dv.setUint16(i + 10, 1, true);
        break;
      }
    }
    const out = listEntries({ data: buf(lied) });
    expect(out.entries.length).toBeLessThanOrEqual(10_000);
    expect(out.truncated).toBe(true);
  });

  it("marks an encrypted entry", () => {
    const z = patchCd(normal(), 0, (dv, at) =>
      dv.setUint16(at + 8, dv.getUint16(at + 8, true) | 1, true),
    );
    const out = listEntries({ data: buf(z) });
    expect(out.entries.filter((e) => e.encrypted)).toHaveLength(1);
  });

  it("reports bytes that are not a zip as invalid", () => {
    const out = listEntries({ data: buf(strToU8("this is not a zip file at all, just text")) });
    expect(out.error).toBe("invalid");
    expect(out.entries).toEqual([]);
  });

  it("lists a valid empty archive as zero entries", () => {
    const out = listEntries({ data: buf(zipSync({})) });
    expect(out.error).toBeUndefined();
    expect(out.entries).toEqual([]);
  });
});

describe("extractEntry", () => {
  it("returns the inflated bytes", () => {
    const out = extractEntry({ data: buf(normal()), path: "src/a/b.json", budget: ARCHIVE_LIMIT });
    expect(new TextDecoder().decode(out.data)).toBe('{"k": 1}');
  });

  it("refuses a declared size over 20 MiB without inflating anything", () => {
    // the compressed bytes are garbage: inflating them would fail with another message
    const z = zipSync({ "big.bin": strToU8("x".repeat(100)) }, { level: 0 });
    const bomb = patchCd(z, 0, (dv, at) => dv.setUint32(at + 24, ENTRY_LIMIT + 1, true));
    expect(() => extractEntry({ data: buf(bomb), path: "big.bin", budget: ARCHIVE_LIMIT })).toThrow(
      "entry too large",
    );
  });

  it("aborts when the actual size exceeds the declared size", () => {
    const z = zipSync({ "lie.bin": new Uint8Array(2 * MiB) });
    const lied = patchCd(z, 0, (dv, at) => dv.setUint32(at + 24, 10, true));
    expect(() => extractEntry({ data: buf(lied), path: "lie.bin", budget: ARCHIVE_LIMIT })).toThrow(
      /larger than declared/,
    );
  });

  it("fails when the actual size is smaller than the declared size", () => {
    const z = zipSync({ "short.bin": new Uint8Array(100) });
    const lied = patchCd(z, 0, (dv, at) => dv.setUint32(at + 24, 5000, true));
    expect(() =>
      extractEntry({ data: buf(lied), path: "short.bin", budget: ARCHIVE_LIMIT }),
    ).toThrow(/does not match/);
  });

  it("stops at the archive budget, declared or actual", () => {
    const z = zipSync({ "a.bin": new Uint8Array(5000) });
    expect(() => extractEntry({ data: buf(z), path: "a.bin", budget: 1000 })).toThrow(
      "archive limit reached",
    );
    const lied = patchCd(z, 0, (dv, at) => dv.setUint32(at + 24, 10, true));
    expect(() => extractEntry({ data: buf(lied), path: "a.bin", budget: 1000 })).toThrow(
      /larger than declared|archive limit reached/,
    );
  });

  it("refuses an encrypted entry", () => {
    const z = patchCd(normal(), 0, (dv, at) =>
      dv.setUint16(at + 8, dv.getUint16(at + 8, true) | 1, true),
    );
    const name = listEntries({ data: buf(z) }).entries.find((e) => e.encrypted)?.path as string;
    expect(() => extractEntry({ data: buf(z), path: name, budget: ARCHIVE_LIMIT })).toThrow(
      "entry is encrypted",
    );
  });

  it("refuses a path that is not in the listing", () => {
    expect(() =>
      extractEntry({ data: buf(normal()), path: "nope", budget: ARCHIVE_LIMIT }),
    ).toThrow("entry not found");
  });

  it("has the documented limits", () => {
    expect(ENTRY_LIMIT).toBe(20 * MiB);
    expect(ARCHIVE_LIMIT).toBe(100 * MiB);
    expect(MAX_ENTRIES).toBe(10_000);
  });
});

function makeCtx(opts: { onWorker?: (id: string, input: unknown) => void } = {}) {
  const root = document.createElement("div");
  document.body.append(root);
  const errors: string[] = [];
  const life = new AbortController();
  const runInWorker = vi.fn(async (id: string, input: unknown) => {
    opts.onWorker?.(id, input);
    if (id === "code") return highlight(input as never);
    const req = input as ZipInput;
    if (req.op === "list") return listEntries(req);
    const out = extractEntry(req as ZipExtractInput);
    return { data: out.data };
  });
  const ctx: RenderContext = {
    root,
    locale: "en",
    signal: new AbortController().signal,
    lifetime: life.signal,
    t: translator("en"),
    runInWorker: runInWorker as unknown as RenderContext["runInWorker"],
    showError: (r) => errors.push(r),
  };
  return { ctx, root, errors, runInWorker, life };
}

const fileOf = (data: Uint8Array, name = "a.zip"): PreviewFile => ({
  name,
  contentType: "application/zip",
  size: data.byteLength,
  data: buf(data),
});

const row = (root: HTMLElement, text: string): HTMLElement => {
  const found = [...root.querySelectorAll<HTMLElement>(".cap-zip-row")].find(
    (r) => r.querySelector(".cap-zip-name")?.textContent === text,
  );
  if (!found) throw new Error(`no row ${text}`);
  return found;
};

describe("zip renderer", () => {
  it("shows the tree and mounts the code renderer for a selected entry without navigating", async () => {
    const { ctx, root } = makeCtx();
    const before = window.location.href;
    await render(fileOf(normal()), ctx);
    expect(root.querySelector(".cap-zip-tree")).not.toBeNull();
    row(root, "b.json").click();
    await vi.waitFor(() => expect(root.querySelector(".cap-zip-detail .cap-code")).not.toBeNull());
    expect(root.querySelector(".cap-zip-detail")?.textContent).toContain('"k"');
    expect(window.location.href).toBe(before);
  });

  it("shows bitmap entries as a blob image and revokes it on change", async () => {
    const urls: string[] = [];
    const revoked: string[] = [];
    URL.createObjectURL = ((b: Blob) => {
      const u = `blob:test/${urls.length}-${b.size}`;
      urls.push(u);
      return u;
    }) as typeof URL.createObjectURL;
    URL.revokeObjectURL = ((u: string) => {
      revoked.push(u);
    }) as typeof URL.revokeObjectURL;
    const z = zipSync({ "p.png": new Uint8Array([1, 2, 3]), "t.txt": strToU8("t") });
    const { ctx, root } = makeCtx();
    await render(fileOf(z), ctx);
    row(root, "p.png").click();
    await vi.waitFor(() => expect(root.querySelector(".cap-zip-detail img")).not.toBeNull());
    expect(root.querySelector(".cap-zip-detail img")?.getAttribute("src")).toBe(urls[0]);
    row(root, "t.txt").click();
    await vi.waitFor(() => expect(revoked).toContain(urls[0]));
  });

  it("passes the remaining archive budget to each extraction and caches repeats", async () => {
    const seen: number[] = [];
    const { ctx, root, runInWorker } = makeCtx({
      onWorker: (id, input) => {
        const i = input as { op: string; budget?: number };
        if (id === "zip" && i.op === "extract") seen.push(i.budget as number);
      },
    });
    await render(fileOf(normal()), ctx);
    row(root, "readme.txt").click();
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    await vi.waitFor(() => expect(root.querySelector(".cap-zip-detail .cap-code")).not.toBeNull());
    row(root, "z.txt").click();
    await vi.waitFor(() => expect(seen).toHaveLength(2));
    expect(seen[0]).toBe(ARCHIVE_LIMIT);
    expect(seen[1]).toBe(ARCHIVE_LIMIT - 5);
    await vi.waitFor(() =>
      expect(root.querySelector(".cap-zip-detail")?.textContent).toContain("z"),
    );
    row(root, "readme.txt").click();
    await vi.waitFor(() =>
      expect(root.querySelector(".cap-zip-detail")?.textContent).toContain("hello"),
    );
    const extracts = runInWorker.mock.calls.filter(
      (c) => (c[1] as { op: string }).op === "extract",
    );
    expect(extracts).toHaveLength(2);
  });

  it("shows an extraction error in the detail pane, not as a page error", async () => {
    const z = patchCd(normal(), 0, (dv, at) =>
      dv.setUint16(at + 8, dv.getUint16(at + 8, true) | 1, true),
    );
    const { ctx, root, errors } = makeCtx();
    await render(fileOf(z), ctx);
    const locked = root.querySelector<HTMLElement>(".cap-zip-row[data-encrypted='true']");
    expect(locked).not.toBeNull();
    locked?.click();
    await vi.waitFor(() =>
      expect(root.querySelector(".cap-zip-detail .cap-zip-error")).not.toBeNull(),
    );
    expect(errors).toEqual([]);
  });

  it("opens a nested zip one level and shows a zip inside it as not openable", async () => {
    const deep = zipSync({ "d.txt": strToU8("deep") });
    const inner = zipSync({ "deep.zip": deep, "i.txt": strToU8("inner") });
    const outer = zipSync({ "inner.zip": inner });
    const { ctx, root } = makeCtx();
    await render(fileOf(outer), ctx);
    row(root, "inner.zip").click();
    await vi.waitFor(() =>
      expect(root.querySelector(".cap-zip-detail .cap-zip-tree")).not.toBeNull(),
    );
    const detail = root.querySelector<HTMLElement>(".cap-zip-detail") as HTMLElement;
    expect(detail.textContent).toContain("deep.zip");
    row(detail, "deep.zip").click();
    await vi.waitFor(() =>
      expect(detail.querySelector(".cap-zip-detail .cap-zip-note")).not.toBeNull(),
    );
    expect(detail.querySelector(".cap-zip-detail .cap-zip-detail .cap-zip-tree")).toBeNull();
  });

  it("reports bytes that are not a zip as an inline error", async () => {
    const { ctx, errors } = makeCtx();
    await render(fileOf(strToU8("definitely not a zip, only text")), ctx);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/not a valid zip/i);
  });

  it("shows the empty state for a valid empty archive and a 0-byte file", async () => {
    const a = makeCtx();
    await render(fileOf(zipSync({})), a.ctx);
    expect(a.root.querySelector(".cap-empty")).not.toBeNull();
    const b = makeCtx();
    await render(fileOf(new Uint8Array(0)), b.ctx);
    expect(b.root.querySelector(".cap-empty")).not.toBeNull();
    expect(b.runInWorker).not.toHaveBeenCalled();
    expect(b.errors).toEqual([]);
  });

  it("notes a truncated listing", async () => {
    const { ctx, root } = makeCtx();
    ctx.runInWorker = (async () =>
      ({
        entries: [
          { path: "a.txt", size: 1, compressed: 1, modified: "", encrypted: false, dir: false },
        ],
        truncated: true,
      }) satisfies ZipListOutput) as unknown as RenderContext["runInWorker"];
    await render(fileOf(normal()), ctx);
    expect(root.querySelector(".cap-zip-truncated")).not.toBeNull();
  });
});

describe("entry previewer table", () => {
  it("matches the previewers' accepted extensions", () => {
    for (const p of PREVIEWERS)
      expect([...EXTENSIONS[p.id]].sort()).toEqual([...p.accepts.extensions].sort());
  });
});
