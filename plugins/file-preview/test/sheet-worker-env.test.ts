import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";
import ExcelJS from "exceljs";
import { afterAll, describe, expect, it } from "vitest";
import { buildUi } from "../ui-src/build.js";

/**
 * The built `sheet.worker.js` must run where a real WebWorker runs: no `process`, `Buffer` or
 * `require`, only `self`, `MessageChannel`, `importScripts` and `postMessage`.
 */
const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

describe("sheet.worker.js in a worker-like context", () => {
  it("parses a tiny xlsx and posts the sheet back", async () => {
    const out = await mkdtemp(join(tmpdir(), "sheet-worker-"));
    dirs.push(out);
    await buildUi(out);
    // the shipped file is `export default "<worker source>";`
    const module = await readFile(join(out, "sheet.worker.js"), "utf8");
    const source = JSON.parse(
      module.replace(/^export default /, "").replace(/;\s*$/, ""),
    ) as string;

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Tiny");
    ws.addRow(["a", 1]);
    ws.getCell("C1").value = { formula: "1+1", result: 2 };
    const buf = (await wb.xlsx.writeBuffer()) as Uint8Array;
    const data = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);

    const posted: Promise<unknown> = new Promise((resolve) => {
      const scope: Record<string, unknown> = {
        importScripts: () => undefined,
        MessageChannel,
        TextEncoder,
        TextDecoder,
        postMessage: (message: unknown) => resolve(message),
      };
      scope.self = scope;
      scope.globalThis = scope;
      const context = vm.createContext({
        ...scope,
        console,
        setTimeout,
        clearTimeout,
        queueMicrotask,
        URL,
        atob,
        btoa,
        Intl,
        // the xlsx bytes come from this realm: share the typed array classes so `instanceof` agrees
        ArrayBuffer,
        Uint8Array,
        Uint16Array,
        Uint32Array,
        Int32Array,
        Float64Array,
        DataView,
      });
      expect(vm.runInContext("typeof process + typeof Buffer + typeof require", context)).toBe(
        "undefinedundefinedundefined",
      );
      vm.runInContext(source, context);
      (context.self as { onmessage: (e: unknown) => void }).onmessage({
        data: { id: 7, input: { data } },
      });
    });

    expect(await posted).toEqual({
      id: 7,
      ok: true,
      output: {
        sheets: [
          {
            name: "Tiny",
            hidden: false,
            rows: [["a", "1", "2"]],
            merges: [],
            truncatedRows: false,
            truncatedCols: false,
            truncatedCells: false,
          },
        ],
      },
    });
  });
});
