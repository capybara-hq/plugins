// @vitest-environment jsdom
import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { translator } from "../ui-src/app/frame.js";
import type { PreviewFile, RenderContext } from "../ui-src/app/types.js";
import { render } from "../ui-src/renderers/sheet.js";
import {
  parseWorkbook,
  type SheetInput,
  type SheetOutput,
} from "../ui-src/workers/sheet.worker.js";

async function toBuffer(wb: ExcelJS.Workbook): Promise<ArrayBuffer> {
  const buf = (await wb.xlsx.writeBuffer()) as ArrayBuffer;
  return buf.slice(0);
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
  const ctx: RenderContext = {
    root,
    locale: "en",
    signal: new AbortController().signal,
    t: translator("en"),
    runInWorker: (async <I, O>(_w: string, input: I) =>
      (await parseWorkbook(input as SheetInput)) as unknown as O) as RenderContext["runInWorker"],
    showError: (r) => errors.push(r),
  };
  return { ctx, root, errors, file };
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
    const sales = out.sheets[0]!;
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
    const s = out.sheets[0]!;
    expect(s.rows).toHaveLength(100_000);
    expect(s.truncatedRows).toBe(true);
    expect(s.truncatedCols).toBe(false);
  });

  it("caps columns at 200 and flags it", async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Wide");
    ws.addRow(Array.from({ length: 201 }, (_, i) => i));
    const s = (await parseWorkbook({ data: await toBuffer(wb) })).sheets[0]!;
    expect(s.rows[0]).toHaveLength(200);
    expect(s.truncatedCols).toBe(true);
    expect(s.truncatedRows).toBe(false);
  });

  it("rejects CSV text renamed .xlsx with a reason", async () => {
    const data = new TextEncoder().encode("a,b\n1,2\n").buffer as ArrayBuffer;
    await expect(parseWorkbook({ data })).rejects.toThrow(/not a valid \.xlsx/);
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
    const sc = root.querySelector<HTMLElement>(".cap-sheet-scroll")!;
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
    expect(errors[0]).toMatch(/not a valid \.xlsx/);
  });

  it("shows the empty state for 0 bytes", async () => {
    const f = fileOf(new ArrayBuffer(0));
    const { ctx, root, errors } = makeCtx(f);
    await render(f, ctx);
    expect(errors).toEqual([]);
    expect(root.querySelector(".cap-empty")?.textContent).toBe("Empty file");
  });
});
