import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";
import { afterAll, describe, expect, it } from "vitest";
import { buildUi } from "../ui-src/build.js";
import { fullDocx } from "./fixtures/docx/make.js";

/**
 * The built `docx.worker.js` must run where a real WebWorker runs: no `process`, `Buffer` or
 * `require`, only `self`, `MessageChannel`, `importScripts` and `postMessage`.
 */
const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

describe("docx.worker.js in a worker-like context", () => {
  it("converts a docx and posts html with the image inlined", async () => {
    const out = await mkdtemp(join(tmpdir(), "docx-worker-"));
    dirs.push(out);
    await buildUi(out);
    const module = await readFile(join(out, "docx.worker.js"), "utf8");
    const source = JSON.parse(
      module.replace(/^export default /, "").replace(/;\s*$/, ""),
    ) as string;
    const data = fullDocx();

    const posted: Promise<{ id: number; ok: boolean; output?: { html: string; error?: string } }> =
      new Promise((resolve) => {
        // like a real worker, `self` and the global object are one and the same
        const context = vm.createContext({
          importScripts: () => undefined,
          MessageChannel,
          TextEncoder,
          TextDecoder,
          postMessage: (message: unknown) => resolve(message as never),
          console,
          setTimeout,
          clearTimeout,
          queueMicrotask,
          URL,
          atob,
          btoa,
          Intl,
          // the docx bytes come from this realm: share the typed array classes so `instanceof` agrees
          ArrayBuffer,
          Uint8Array,
          Uint16Array,
          Uint32Array,
          Int32Array,
          Float64Array,
          DataView,
        });
        context.self = context;
        context.globalThis = context;
        expect(vm.runInContext("typeof process + typeof Buffer + typeof require", context)).toBe(
          "undefinedundefinedundefined",
        );
        vm.runInContext(source, context);
        (context.self as { onmessage: (e: unknown) => void }).onmessage({
          data: { id: 7, input: { data } },
        });
      });

    const answer = await posted;
    expect(answer.ok).toBe(true);
    expect(answer.output?.error).toBeUndefined();
    expect(answer.output?.html).toContain("<h1>Quarterly Report</h1>");
    expect(answer.output?.html).toMatch(/src="data:image\/png;base64,/);
  });
});
