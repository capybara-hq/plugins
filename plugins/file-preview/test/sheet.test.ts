// @vitest-environment jsdom
import ExcelJS from "exceljs";
import { describe, expect, it, vi } from "vitest";
import { translator } from "../ui-src/app/frame.js";
import type { PreviewFile, RenderContext } from "../ui-src/app/types.js";
import { render } from "../ui-src/renderers/sheet.js";
import type { SheetInput, SheetOutput } from "../ui-src/shared/sheet.js";
import { MAX_ENTRY_BYTES, MAX_TOTAL_BYTES } from "../ui-src/shared/sheet.js";
import { formatDate, parseWorkbook } from "../ui-src/workers/sheet.worker.js";
import {
  ab,
  decoyDirectory,
  jszip,
  lyingSize,
  prepended,
  streamed,
  u8,
  withEntries,
  zip64Switch,
} from "./fixtures/zip/hostile.js";

function must<T>(value: T | null | undefined): T {
  if (value === undefined || value === null) throw new Error("expected a value");
  return value;
}

async function toBuffer(wb: ExcelJS.Workbook): Promise<ArrayBuffer> {
  const buf = (await wb.xlsx.writeBuffer()) as unknown as Uint8Array;
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

async function basic(): Promise<ArrayBuffer> {
  const wb = new ExcelJS.Workbook();
  const a = wb.addWorksheet("Sales");
  a.addRow(["Item", "Qty", "Price"]);
  a.addRow(["Pen", 2, 1.5]);
  a.getCell("D2").value = { formula: "B2*C2", result: 3 };
  const d = a.getCell("A3");
  d.value = new Date(Date.UTC(2024, 0, 15));
  d.numFmt = "yyyy-mm-dd";
  a.mergeCells("A5:C5");
  a.getCell("A5").value = "Merged";
  const b = wb.addWorksheet("Notes");
  b.addRow(["hello"]);
  return toBuffer(wb);
}

function makeCtx(file: PreviewFile) {
  const root = document.createElement("div");
  document.body.append(root);
  const errors: string[] = [];
  const life = new AbortController();
  const ctx: RenderContext = {
    root,
    locale: "en",
    signal: new AbortController().signal,
    lifetime: life.signal,
    t: translator("en"),
    runInWorker: (async <I, O>(_w: string, input: I) =>
      (await parseWorkbook(input as SheetInput)) as unknown as O) as RenderContext["runInWorker"],
    showError: (r) => errors.push(r),
  };
  return { ctx, root, errors, file, life };
}

const fileOf = (data: ArrayBuffer): PreviewFile => ({
  name: "a.xlsx",
  contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  size: data.byteLength,
  data,
});

describe("parseWorkbook", () => {
  it("returns the tabs with their names, cached formula results, dates and merges", async () => {
    const out: SheetOutput = await parseWorkbook({ data: await basic() });
    expect(out.sheets.map((s) => s.name)).toEqual(["Sales", "Notes"]);
    const sales = must(out.sheets[0]);
    expect(sales.rows[0]).toEqual(["Item", "Qty", "Price"]);
    expect(sales.rows[1]?.[3]).toBe("3");
    expect(sales.rows[2]?.[0]).toBe("2024-01-15");
    expect(sales.merges).toEqual([{ r1: 4, c1: 0, r2: 4, c2: 2 }]);
  });

  it("caps rows at 100 000 and flags it", async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Big");
    for (let i = 1; i <= 100_001; i++) ws.addRow([i]);
    const out = await parseWorkbook({ data: await toBuffer(wb) });
    const s = must(out.sheets[0]);
    expect(s.rows).toHaveLength(100_000);
    expect(s.truncatedRows).toBe(true);
    expect(s.truncatedCols).toBe(false);
  });

  it("caps columns at 200 and flags it", async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Wide");
    ws.addRow(Array.from({ length: 201 }, (_, i) => i));
    const s = must((await parseWorkbook({ data: await toBuffer(wb) })).sheets[0]);
    expect(s.rows[0]).toHaveLength(200);
    expect(s.truncatedCols).toBe(true);
    expect(s.truncatedRows).toBe(false);
  });

  it("flags CSV text renamed .xlsx as invalid", async () => {
    const data = new TextEncoder().encode("a,b\n1,2\n").buffer as ArrayBuffer;
    expect((await parseWorkbook({ data })).error).toBe("invalid");
  });
});

describe("sheet renderer", () => {
  it("shows a tab per sheet and switches between them", async () => {
    const { ctx, root } = makeCtx(fileOf(await basic()));
    await render(fileOf(await basic()), ctx);
    const tabs = [...root.querySelectorAll<HTMLButtonElement>(".cap-sheet-tab")];
    expect(tabs.map((t) => t.textContent)).toEqual(["Sales", "Notes"]);
    expect(root.querySelector("thead")?.textContent).toContain("A");
    expect(root.textContent).toContain("Pen");
    tabs[1]?.click();
    expect(root.textContent).toContain("hello");
    expect(root.textContent).not.toContain("Pen");
  });

  it("shows merged cells with a colSpan", async () => {
    const f = fileOf(await basic());
    const { ctx, root } = makeCtx(f);
    await render(f, ctx);
    const merged = root.querySelector<HTMLTableCellElement>("td.cap-sheet-merged");
    expect(merged?.colSpan).toBe(3);
    expect(merged?.textContent).toBe("Merged");
  });

  it("virtualizes: 100 000 rows keep under 500 tr in the DOM, with the truncation note", async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Big");
    for (let i = 1; i <= 100_001; i++) ws.addRow([i]);
    const f = fileOf(await toBuffer(wb));
    const { ctx, root } = makeCtx(f);
    await render(f, ctx);
    expect(root.querySelectorAll("tr").length).toBeLessThan(500);
    expect(root.querySelector(".cap-sheet-note")?.textContent).toContain("100,000");
  });

  it("repaints the visible window on scroll", async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Big");
    for (let i = 1; i <= 5000; i++) ws.addRow([`row-${i}`]);
    const f = fileOf(await toBuffer(wb));
    const { ctx, root } = makeCtx(f);
    await render(f, ctx);
    const sc = must(root.querySelector<HTMLElement>(".cap-sheet-scroll"));
    expect(root.textContent).not.toContain("row-3000");
    sc.scrollTop = 3000 * 24;
    sc.dispatchEvent(new Event("scroll"));
    expect(root.textContent).toContain("row-3000");
  });

  it("shows the reason inline for a corrupt file", async () => {
    const data = new TextEncoder().encode("a,b\n1,2\n").buffer as ArrayBuffer;
    const f = fileOf(data);
    const { ctx, errors } = makeCtx(f);
    await render(f, ctx);
    expect(errors[0]).toContain("not a valid .xlsx");
  });

  it("shows the empty state for 0 bytes", async () => {
    const f = fileOf(new ArrayBuffer(0));
    const { ctx, root, errors } = makeCtx(f);
    await render(f, ctx);
    expect(errors).toEqual([]);
    expect(root.querySelector(".cap-empty")?.textContent).toBe("Empty file");
  });
});

describe("formatDate", () => {
  const d = new Date(Date.UTC(2024, 0, 5, 14, 7, 9));
  it("shows nothing derived from an invalid date", () => {
    expect(formatDate(new Date(Number.NaN), "yyyy-mm-dd")).toBe("");
  });
  it("uses English month and weekday names", () => {
    expect(formatDate(d, "d-mmm-yy")).toBe("5-Jan-24");
    expect(formatDate(d, "mmmm d, yyyy")).toBe("January 5, 2024");
    expect(formatDate(d, "dddd")).toBe("Friday");
    expect(formatDate(d, "ddd")).toBe("Fri");
    expect(formatDate(d, "mmm")).toBe("Jan");
    expect(formatDate(d, "mmmmm")).toBe("J");
  });
  it("tells minutes from months", () => {
    expect(formatDate(d, "hh:mm:ss")).toBe("14:07:09");
    expect(formatDate(d, "mm/dd/yy")).toBe("01/05/24");
    expect(formatDate(d, "h:mm AM/PM")).toBe("2:07 PM");
  });
});

describe("parseWorkbook limits and flags", () => {
  it("returns an error code, not a message, for a non-workbook", async () => {
    const data = new TextEncoder().encode("a,b").buffer as ArrayBuffer;
    expect(await parseWorkbook({ data })).toEqual({ sheets: [], error: "invalid" });
  });

  it("marks hidden sheets", async () => {
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet("Shown").addRow([1]);
    wb.addWorksheet("Secret", { state: "hidden" }).addRow([2]);
    const out = await parseWorkbook({ data: await toBuffer(wb) });
    expect(out.sheets.map((s) => s.hidden)).toEqual([false, true]);
  });

  it("does not walk the rows past the row cap", async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Big");
    for (let i = 1; i <= 100_050; i++) ws.addRow([i]);
    const data = await toBuffer(wb);
    const proto = Object.getPrototypeOf(new ExcelJS.Workbook().addWorksheet("p").getRow(1));
    const spy = vi.spyOn(proto, "eachCell");
    try {
      const out = await parseWorkbook({ data });
      expect(must(out.sheets[0]).truncatedRows).toBe(true);
      expect(spy.mock.calls.length).toBeLessThanOrEqual(100_000);
    } finally {
      spy.mockRestore();
    }
  });

  it("clips merges to the rows that were kept when the cell budget runs out", async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("S");
    for (let i = 0; i < 10; i++) ws.addRow([i, i]);
    ws.mergeCells("A1:A5");
    ws.mergeCells("B7:B9");
    const s = must((await parseWorkbook({ data: await toBuffer(wb) }, 6)).sheets[0]);
    expect(s.truncatedCells).toBe(true);
    expect(s.rows).toHaveLength(3);
    expect(s.merges).toEqual([{ r1: 0, c1: 0, r2: 2, c2: 0 }]);
  });

  it("does not flag truncated rows when rows past the limit hold no values", async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("S");
    ws.addRow([1]);
    ws.getRow(100_005).height = 30;
    const s = (await parseWorkbook({ data: await toBuffer(wb) })).sheets[0];
    expect(s?.truncatedRows).toBe(false);
  });

  it("stops at the workbook-wide cell budget and says so", async () => {
    const wb = new ExcelJS.Workbook();
    for (const name of ["One", "Two"]) {
      const ws = wb.addWorksheet(name);
      for (let i = 0; i < 10; i++) ws.addRow([i, i]);
    }
    const out = await parseWorkbook({ data: await toBuffer(wb) }, 25);
    const [one, two] = out.sheets;
    expect(one?.truncatedCells).toBe(false);
    expect(two?.truncatedCells).toBe(true);
    expect(two?.rows.flat().length).toBeLessThan(20);
  });
});

describe("sheet renderer layout", () => {
  const widths = (root: HTMLElement) =>
    [...root.querySelectorAll<HTMLElement>("col")].map((c) => c.style.width);

  it("fixes column widths up front: scrolling to a longer cell does not change them", async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("W");
    for (let i = 1; i <= 3000; i++) ws.addRow([i, i === 2500 ? "x".repeat(200) : "ab"]);
    const f = fileOf(await toBuffer(wb));
    const { ctx, root } = makeCtx(f);
    await render(f, ctx);
    const before = widths(root);
    expect(before.length).toBe(3);
    expect(root.querySelector<HTMLElement>("table")?.style.tableLayout).not.toBe("auto");
    const sc = root.querySelector<HTMLElement>(".cap-sheet-scroll") as HTMLElement;
    sc.scrollTop = 2490 * 24;
    sc.dispatchEvent(new Event("scroll"));
    expect(root.textContent).toContain("x".repeat(200));
    expect(widths(root)).toEqual(before);
  });

  it("marks hidden tabs with a title", async () => {
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet("A").addRow([1]);
    wb.addWorksheet("B", { state: "hidden" }).addRow([1]);
    const f = fileOf(await toBuffer(wb));
    const { ctx, root } = makeCtx(f);
    await render(f, ctx);
    const tabs = root.querySelectorAll<HTMLButtonElement>(".cap-sheet-tab");
    expect(tabs[0]?.title).toBe("");
    expect(tabs[1]?.title).toBe("Hidden sheet");
  });

  it("stops listening when the lifetime aborts, and keeps file.data usable", async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Big");
    for (let i = 1; i <= 2000; i++) ws.addRow([`row-${i}`]);
    const f = fileOf(await toBuffer(wb));
    const size = f.data.byteLength;
    const { ctx, root, life } = makeCtx(f);
    await render(f, ctx);
    expect(f.data.byteLength).toBe(size);
    life.abort();
    const sc = root.querySelector<HTMLElement>(".cap-sheet-scroll") as HTMLElement;
    sc.scrollTop = 1500 * 24;
    sc.dispatchEvent(new Event("scroll"));
    expect(root.textContent).not.toContain("row-1500");
  });
});

describe("oversized workbooks", () => {
  /** A zip whose central directory declares `size` bytes for one entry (the data is a stub). */
  function declared(...sizes: number[]): ArrayBuffer {
    const parts: Uint8Array[] = [];
    const central: Uint8Array[] = [];
    let offset = 0;
    sizes.forEach((size, i) => {
      const name = new TextEncoder().encode(`f${i}.xml`);
      const local = new Uint8Array(30 + name.length);
      new DataView(local.buffer).setUint32(0, 0x04034b50, true);
      new DataView(local.buffer).setUint16(26, name.length, true);
      local.set(name, 30);
      const cd = new Uint8Array(46 + name.length);
      const v = new DataView(cd.buffer);
      v.setUint32(0, 0x02014b50, true);
      v.setUint32(24, size, true);
      v.setUint16(28, name.length, true);
      v.setUint32(42, offset, true);
      cd.set(name, 46);
      parts.push(local);
      central.push(cd);
      offset += local.length;
    });
    const cdSize = central.reduce((n, c) => n + c.length, 0);
    const eocd = new Uint8Array(22);
    const v = new DataView(eocd.buffer);
    v.setUint32(0, 0x06054b50, true);
    v.setUint16(8, sizes.length, true);
    v.setUint16(10, sizes.length, true);
    v.setUint32(12, cdSize, true);
    v.setUint32(16, offset, true);
    const all = [...parts, ...central, eocd];
    const out = new Uint8Array(all.reduce((n, a) => n + a.length, 0));
    let at = 0;
    for (const a of all) {
      out.set(a, at);
      at += a.length;
    }
    return out.buffer as ArrayBuffer;
  }
  const MiB = 1024 * 1024;

  it("refuses a declared total over 150 MiB", async () => {
    const out = await parseWorkbook({ data: declared(40 * MiB, 40 * MiB, 40 * MiB, 40 * MiB) });
    expect(out).toEqual({ sheets: [], error: "too-large" });
  });

  it("has the R22 limits: 120 MiB per entry, 150 MiB in total", () => {
    expect(MAX_ENTRY_BYTES).toBe(120 * MiB);
    expect(MAX_TOTAL_BYTES).toBe(150 * MiB);
  });

  it("refuses a single entry over 120 MiB", async () => {
    expect((await parseWorkbook({ data: declared(121 * MiB) })).error).toBe("too-large");
  });

  it("parses a workbook with a 79 MiB entry (a 20 MiB numeric xlsx inflates its sheet that far)", async () => {
    // zeros keep the archive small and fast; verifyArchive inflates and counts all 79 MiB
    const data = withEntries(u8(await basic()), { "xl/media/big.bin": new Uint8Array(79 * MiB) });
    const out = await parseWorkbook({ data: ab(data) });
    expect(out.error).toBeUndefined();
    expect(out.sheets.map((s) => s.name)).toEqual(["Sales", "Notes"]);
  });

  it("is not 'too-large' for a normal workbook, and the renderer words it", async () => {
    expect((await parseWorkbook({ data: await basic() })).error).toBeUndefined();
    const f = fileOf(declared(121 * MiB));
    const { ctx, errors } = makeCtx(f);
    await render(f, ctx);
    expect(errors[0]).toContain("too large");
  });
});

describe("hostile archives never reach exceljs (ruling R21)", () => {
  const MiB = 1024 * 1024;
  /** exceljs reads every entry, so any entry can carry the payload. */
  const withMedia = async (bytes: number) =>
    withEntries(u8(await basic()), { "xl/media/big.bin": new Uint8Array(bytes) });

  /** Runs the real parseWorkbook path with JSZip (exceljs's unzipper) observed. */
  async function run(data: Uint8Array) {
    const loadAsync = vi.spyOn(jszip(), "loadAsync");
    try {
      const out = await parseWorkbook({ data: ab(data) });
      return { out, jszipCalls: loadAsync.mock.calls.length };
    } finally {
      loadAsync.mockRestore();
    }
  }

  it("refuses a lying-size bomb before JSZip inflates it", async () => {
    const r = await run(lyingSize(await withMedia(8 * MiB), "xl/media/big.bin", 1024));
    expect(r.out).toEqual({ sheets: [], error: "too-large" });
    expect(r.jszipCalls).toBe(0);
  });

  it("refuses the decoy directory (prepended-bytes shift)", async () => {
    const r = await run(decoyDirectory(await withMedia(1), await withMedia(60 * MiB)));
    expect(r.out).toEqual({ sheets: [], error: "invalid" });
    expect(r.jszipCalls).toBe(0);
  });

  it("refuses the zip64 switch (0xFFFF record count)", async () => {
    const r = await run(zip64Switch(await withMedia(60 * MiB)));
    expect(r.out).toEqual({ sheets: [], error: "invalid" });
    expect(r.jszipCalls).toBe(0);
  });

  it("refuses bytes prepended to a workbook", async () => {
    const r = await run(prepended(u8(await basic())));
    expect(r.out).toEqual({ sheets: [], error: "invalid" });
    expect(r.jszipCalls).toBe(0);
  });

  it("still parses workbooks from exceljs, fflate and fflate's streaming writer", async () => {
    const fromExceljs = await run(u8(await basic()));
    expect(fromExceljs.out.sheets.map((s) => s.name)).toEqual(["Sales", "Notes"]);
    expect(fromExceljs.jszipCalls).toBe(1);
    const fromFflate = await run(withEntries(u8(await basic()), {}));
    expect(fromFflate.out.sheets[0]?.rows[1]).toEqual(["Pen", "2", "1.5", "3"]);
    const fromStream = await run(streamed(u8(await basic())));
    expect(fromStream.out.sheets.map((s) => s.name)).toEqual(["Sales", "Notes"]);
  });
});
