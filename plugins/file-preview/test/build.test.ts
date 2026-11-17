import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import vm from "node:vm";
import { gzipSync } from "node:zlib";
import { afterAll, describe, expect, it } from "vitest";
import { PREVIEWERS } from "../src/previewers.js";
import { buildUi } from "../ui-src/build.js";

const dirs: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "file-preview-ui-"));
  dirs.push(dir);
  return dir;
}

/** The installed pdfjs-dist package directory (its cmaps and standard fonts are shipped). */
const PDFJS_DIR = dirname(
  createRequire(join(import.meta.dirname, "../package.json")).resolve("pdfjs-dist/package.json"),
);

/** One real build shared by the tests that only read it. */
let shared: Promise<{ dir: string; manifest: Awaited<ReturnType<typeof buildUi>> }> | undefined;
function sharedBuild() {
  shared ??= (async () => {
    const dir = await tempDir();
    return { dir, manifest: await buildUi(dir) };
  })();
  return shared;
}

/**
 * A call that evaluates a string as code: `Function(…)`, `new Function(…)`, `eval(…)`, and the
 * indirect forms `x.eval(…)`, `x.Function(…)`, `(0,eval)(…)`, `(0, eval)(…)`. A bare name is not
 * part of a longer one, and nothing is followed by `?`: `Function(?` can only be text inside a
 * regex source (shiki's grammars), never a call.
 */
const EVAL_RE =
  /(?<![\w$.])(?:new\s+)?(?:Function|eval)\s*\((?!\?)|\.(?:eval|Function)\s*\((?!\?)|\(\s*0\s*,\s*eval\s*\)\s*\(/g;
/**
 * The only eval-like calls the shipped code may contain, each unreachable in the embed (the CSP
 * has no 'unsafe-eval', so reaching one would throw, never run code):
 */
const EVAL_ALLOWED: ReadonlyArray<{ file?: RegExp; re: RegExp; why: string }> = [
  {
    // core-js (pdf.js legacy build), lodash and regenerator-runtime (exceljs): the global object
    re: /^Function\(["']return this["']\)\(\)/,
    why: "last fallback after the globalThis / self / window checks, which every browser passes",
  },
  {
    // regenerator-runtime (exceljs): `try { regeneratorRuntime = r } catch { globalThis ? … : this }`
    re: /^Function\("r","regeneratorRuntime = r"\)/,
    why: "only when globalThis is missing",
  },
  {
    // the setImmediate polyfill bundled with exceljs and mammoth: `typeof f != "function"`
    file: /^(sheet|docx)\.worker\.js$/,
    re: /^new Function\(""\+(\w+)\)/,
    why: "only for a string callback; the bundles pass functions",
  },
  {
    // underscore's _.template compiler, bundled whole into the docx worker by mammoth
    file: /^docx\.worker\.js$/,
    re: /^new Function\(\w+,"_",\w+\)/,
    why: "mammoth never calls _.template (no `.template(` in mammoth/lib)",
  },
];

/** Every script the embed runs: page modules as written, worker modules as their source text. */
async function shippedScripts(
  dir: string,
  names: string[],
): Promise<Array<[name: string, source: string]>> {
  const out: Array<[string, string]> = [];
  for (const name of names.filter((n) => n.endsWith(".js"))) {
    const text = await readFile(join(dir, name), "utf8");
    if (/^pdfjs-(cmap|font)-/.test(name)) {
      // data, not code: a base64 string and nothing else
      expect(text, name).toMatch(/^export default "[A-Za-z0-9+/=]*";\n$/);
      continue;
    }
    if (name.endsWith(".worker.js")) {
      // a string export and nothing else: what runs is the source text
      expect(text, name).toMatch(/^export default "(?:[^"\\]|\\.)*";\n$/s);
      out.push([name, (await importDefault(join(dir, name))) as string]);
    } else out.push([name, text]);
  }
  return out;
}

async function importDefault(file: string): Promise<unknown> {
  return ((await import(pathToFileURL(file).href)) as { default: unknown }).default;
}

afterAll(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

describe("buildUi", () => {
  it("builds the same bytes twice", async () => {
    const a = await tempDir();
    const b = await tempDir();
    const first = await buildUi(a);
    const second = await buildUi(b);
    expect(second).toEqual(first);
    expect(JSON.parse(await readFile(join(b, "manifest.json"), "utf8"))).toEqual(
      JSON.parse(await readFile(join(a, "manifest.json"), "utf8")),
    );
    for (const name of Object.keys(first.files)) {
      expect((await readFile(join(b, name))).equals(await readFile(join(a, name)))).toBe(true);
    }
  });

  it("emits only flat, allowlisted names", async () => {
    const manifest = await buildUi(await tempDir());
    const names = Object.keys(manifest.files);
    for (const name of names) expect(name).toMatch(/^[A-Za-z0-9][A-Za-z0-9.-]*$/);
    expect(names).toContain("index.html");
    expect(names).toContain("app.js");
    expect(names).toEqual([...names].sort());
  });

  it("code-splits the renderers: app.js lazily imports a chunk that the manifest lists", async () => {
    const dir = await tempDir();
    const manifest = await buildUi(dir);
    const app = await readFile(join(dir, "app.js"), "utf8");
    const chunk = /import\(["']\.\/(chunk-[A-Za-z0-9]+\.js)["']\)/.exec(app)?.[1];
    expect(chunk).toBeDefined();
    expect(Object.keys(manifest.files)).toContain(chunk);
  });

  it("emits one lazily loaded chunk per renderer", async () => {
    const dir = await tempDir();
    const manifest = await buildUi(dir);
    const app = await readFile(join(dir, "app.js"), "utf8");
    const chunks = new Set(
      [...app.matchAll(/import\(["']\.\/(chunk-[A-Za-z0-9]+\.js)["']\)/g)].map((m) => m[1]),
    );
    expect(chunks.size).toBe(PREVIEWERS.length);
    for (const chunk of chunks) expect(Object.keys(manifest.files)).toContain(chunk);
  });

  it("ships each worker as an ES module whose default export is the worker's IIFE source", async () => {
    const workers = await tempDir();
    await writeFile(
      join(workers, "hello.worker.ts"),
      'const greet = (n: string): string => "hi " + n;\nself.postMessage(greet("there"));\n',
    );
    // not a worker entry: shared modules are bundled into the workers that import them
    await writeFile(join(workers, "protocol.ts"), "export type X = number;\n");
    const dir = await tempDir();
    const manifest = await buildUi(dir, { workersDir: workers });
    expect(manifest.files["hello.worker.js"]?.contentType).toBe("text/javascript; charset=utf-8");
    expect(Object.keys(manifest.files).filter((n) => n.includes("worker"))).toEqual([
      "hello.worker.js",
    ]);
    const mod = (await import(pathToFileURL(join(dir, "hello.worker.js")).href)) as {
      default: unknown;
    };
    expect(typeof mod.default).toBe("string");
    const source = mod.default as string;
    // the source is a classic script (IIFE, no import/export) that runs as written
    expect(source).not.toMatch(/\bexport\b|\bimport\b/);
    const posted: unknown[] = [];
    new Function("self", source)({ postMessage: (m: unknown) => posted.push(m) });
    expect(posted).toEqual(["hi there"]);
    // deterministic
    const again = await buildUi(await tempDir(), { workersDir: workers });
    expect(again).toEqual(manifest);
  });

  it("ships exactly one module per ui-src/workers/*.worker.ts and no test-only worker", async () => {
    const workersDir = join(import.meta.dirname, "../ui-src/workers");
    const stems = (await readdir(workersDir))
      .filter((f) => f.endsWith(".worker.ts"))
      .map((f) => f.slice(0, -".worker.ts".length))
      .sort();
    const manifest = await buildUi(await tempDir());
    const shipped = Object.keys(manifest.files)
      .filter((n) => n.endsWith(".worker.js"))
      .map((n) => n.slice(0, -".worker.js".length));
    expect(shipped).toEqual(stems);
    for (const testOnly of ["echo", "hello"]) expect(shipped).not.toContain(testOnly);
  });

  it("writes every listed file with the manifest's sha256 and the content type of its extension", async () => {
    const dir = await tempDir();
    const manifest = await buildUi(dir);
    const types: Record<string, string> = {
      ".html": "text/html; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".txt": "text/plain; charset=utf-8",
    };
    const written = (await readdir(dir)).filter((n) => n !== "manifest.json").sort();
    expect(Object.keys(manifest.files)).toEqual(written);
    for (const [name, { contentType, sha256 }] of Object.entries(manifest.files)) {
      const bytes = await readFile(join(dir, name));
      expect(createHash("sha256").update(bytes).digest("hex"), name).toBe(sha256);
      expect(contentType, name).toBe(types[name.slice(name.lastIndexOf("."))]);
    }
  });

  it("copies ui-src/static files verbatim and lists them; nested directories are refused", async () => {
    const staticDir = await tempDir();
    await writeFile(join(staticDir, "notice.txt"), "hello\n");
    const dir = await tempDir();
    const manifest = await buildUi(dir, { staticDir });
    expect(await readFile(join(dir, "notice.txt"), "utf8")).toBe("hello\n");
    expect(manifest.files["notice.txt"]).toEqual({
      contentType: "text/plain; charset=utf-8",
      sha256: createHash("sha256").update("hello\n").digest("hex"),
    });

    await mkdir(join(staticDir, "fonts"));
    await writeFile(join(staticDir, "fonts", "a.txt"), "x");
    await expect(buildUi(await tempDir(), { staticDir })).rejects.toThrow(/flat/);
  });

  it("ships the pdf.js worker as a classic script with no runtime import", async () => {
    const { dir, manifest } = await sharedBuild();
    expect(manifest.files["pdfjs.worker.js"]?.contentType).toBe("text/javascript; charset=utf-8");
    const source = await importDefault(join(dir, "pdfjs.worker.js"));
    expect(typeof source).toBe("string");
    const text = source as string;
    expect(text).toContain("WorkerMessageHandler");
    // the JPEG 2000 / JBIG2 JS decoders are bundled in, not imported from a URL at run time
    expect(text).not.toMatch(/\bimport\s*\(/);
    expect(text).toContain("openjpeg_nowasm_fallback.js");
    expect(text).toContain("jbig2_nowasm_fallback.js");
  });

  it("the zip readers ship JSZip 3.10.x, the versions verifyArchive's rules were checked against", async () => {
    const { dir } = await sharedBuild();
    const versions: Record<string, string | undefined> = {};
    for (const worker of ["sheet", "docx"]) {
      const source = (await importDefault(join(dir, `${worker}.worker.js`))) as string;
      versions[worker] = /\.defaults=\w+\("\.\/defaults"\),\w+\.version="([^"]+)"/.exec(
        source,
      )?.[1];
    }
    expect(versions.sheet).toMatch(/^3\.10\.\d+$/);
    expect(versions.docx).toMatch(/^3\.10\.\d+$/);
  });

  it("mammoth's lib never calls _.template (pairs with the docx worker's eval allowlist entry)", async () => {
    const mammothLib = join(
      dirname(
        createRequire(join(import.meta.dirname, "../package.json")).resolve("mammoth/package.json"),
      ),
      "lib",
    );
    const walkJs = async (dir: string): Promise<string[]> => {
      const out: string[] = [];
      for (const e of await readdir(dir, { withFileTypes: true })) {
        const full = join(dir, e.name);
        if (e.isDirectory()) out.push(...(await walkJs(full)));
        else if (e.name.endsWith(".js")) out.push(full);
      }
      return out;
    };
    const files = await walkJs(mammothLib);
    expect(files.length).toBeGreaterThan(10);
    const callers: string[] = [];
    for (const f of files) if (/\.template\s*\(/.test(await readFile(f, "utf8"))) callers.push(f);
    expect(callers).toEqual([]);
  });

  it("the eval scan catches the direct and the indirect forms, not regex text", () => {
    for (const hit of [
      'eval("1")',
      'new Function("a","return a")',
      'x=Function("return this")()',
      'self.eval("1")',
      'globalThis.Function("a")',
      '(0,eval)("1")',
      '(0, eval)("1")',
      '( 0 , eval ) ("1")',
    ]) {
      expect([...hit.matchAll(EVAL_RE)], hit).not.toHaveLength(0);
    }
    for (const miss of ["/Function(?:a)/", "myeval(1)", "evaluate(1)", "x.evalue(1)"]) {
      expect([...miss.matchAll(EVAL_RE)], miss).toHaveLength(0);
    }
  });

  it("the setImmediate polyfill is allowed only in the workers that bundle it", () => {
    const entry = EVAL_ALLOWED.find((a) => a.re.test('new Function(""+t)'));
    expect(entry?.file?.test("sheet.worker.js")).toBe(true);
    expect(entry?.file?.test("docx.worker.js")).toBe(true);
    for (const other of ["app.js", "code.worker.js", "pdfjs.worker.js", "zip.worker.js"]) {
      expect(entry?.file?.test(other), other).toBe(false);
    }
  });

  it("no shipped script evaluates strings as code, beyond the commented allowlist", async () => {
    const { dir, manifest } = await sharedBuild();
    const scripts = await shippedScripts(dir, Object.keys(manifest.files));
    // the pdf renderer's chunk (pdf.js's main thread) and the worker are among them
    expect(scripts.some(([, src]) => src.includes("PasswordException"))).toBe(true);
    expect(scripts.map(([n]) => n)).toContain("pdfjs.worker.js");
    const offenders: string[] = [];
    for (const [name, src] of scripts) {
      for (const m of src.matchAll(EVAL_RE)) {
        const at = src.slice(m.index, m.index + 60);
        const allowed = EVAL_ALLOWED.some((a) => (a.file?.test(name) ?? true) && a.re.test(at));
        if (!allowed) offenders.push(`${name}: ${at}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the built worker decodes JPEG 2000 and CCITT fax images with no WebAssembly or fetch", async () => {
    // WebAssembly call sites stay in pdf.js's worker (behind useWasm), so this is checked at run
    // time: the built worker runs in-process with WebAssembly and fetch trapped, and decodes a
    // JPX image and a CCITT G4 image (the JBIG2 module's decoder) through the rewritten lookup
    const { dir } = await sharedBuild();
    const source = (await importDefault(join(dir, "pdfjs.worker.js"))) as string;
    const g = globalThis as Record<string, unknown>;
    const saved = { WebAssembly: g.WebAssembly, fetch: g.fetch };
    const hits: string[] = [];
    g.WebAssembly = new Proxy(
      {},
      {
        get(_, key) {
          hits.push(`WebAssembly.${String(key)}`);
          throw new Error("WebAssembly is not allowed");
        },
      },
    );
    g.fetch = (url: unknown) => {
      hits.push(`fetch ${String(url)}`);
      throw new Error("fetch is not allowed");
    };
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    let destroy: (() => Promise<void>) | undefined;
    try {
      // the bundle sets globalThis.pdfjsWorker; pdf.js in Node then uses it as its in-process worker
      vm.runInThisContext(source, { filename: "pdfjs.worker.js" });
      expect(
        typeof (g.pdfjsWorker as { WorkerMessageHandler?: unknown })?.WorkerMessageHandler,
      ).toBe("function");
      const data = new Uint8Array(
        await readFile(join(import.meta.dirname, "fixtures/pdf/images.pdf")),
      );
      const task = pdfjs.getDocument({ data, useWasm: false, useWorkerFetch: false, verbosity: 0 });
      destroy = () => task.destroy();
      const page = await (await task.promise).getPage(1);
      const ops = await page.getOperatorList();
      type Img = { width: number; height: number; data: Uint8ClampedArray };
      const ids = ops.fnArray
        .map((fn, k) =>
          fn === pdfjs.OPS.paintImageXObject ? (ops.argsArray[k] as [string])[0] : "",
        )
        .filter((id) => id !== "");
      const images = await Promise.all(
        ids.map((id) => new Promise<Img>((resolve) => page.objs.get(id, resolve))),
      );
      expect(images.map((im) => [im.width, im.height])).toEqual([
        [8, 8],
        [16, 8],
      ]);
      // JPX: solid red, RGBA
      const [jpx, fax] = images as [(typeof images)[0], (typeof images)[0]];
      expect([...jpx.data.slice(0, 4)]).toEqual([255, 0, 0, 255]);
      // CCITT: one bit per pixel, 2 bytes a row: one half black, the other white
      expect(fax.data).toHaveLength(16);
      const rows = [...fax.data];
      expect(new Set(rows.filter((_, i) => i % 2 === 0))).toEqual(new Set([rows[0]]));
      expect(rows[0] !== rows[1] && [rows[0], rows[1]].sort()).toEqual([0, 255]);
    } finally {
      await destroy?.();
      Object.assign(g, saved);
      delete g.pdfjsWorker;
    }
    expect(hits).toEqual([]);
  });

  it("ships every pdf.js cmap and standard font as a module whose default export is its base64", async () => {
    const dir = await tempDir();
    const manifest = await buildUi(dir);
    const names = Object.keys(manifest.files);
    const cmaps = (await readdir(join(PDFJS_DIR, "cmaps"))).filter((f) => f.endsWith(".bcmap"));
    const fonts = (await readdir(join(PDFJS_DIR, "standard_fonts"))).filter((f) =>
      /\.(pfb|ttf)$/.test(f),
    );
    expect(cmaps).toContain("UniGB-UCS2-H.bcmap");
    expect(fonts).toContain("FoxitSerif.pfb");
    for (const f of cmaps) expect(names).toContain(`pdfjs-cmap-${f}.js`);
    for (const f of fonts) expect(names).toContain(`pdfjs-font-${f}.js`);
    expect(names.filter((n) => n.startsWith("pdfjs-cmap-") && n.endsWith(".js"))).toHaveLength(
      cmaps.length,
    );
    for (const sample of ["cmaps/UniGB-UCS2-H.bcmap", "standard_fonts/FoxitSerif.pfb"]) {
      const file = sample.split("/")[1] as string;
      const kind = sample.startsWith("cmaps") ? "cmap" : "font";
      const b64 = await importDefault(join(dir, `pdfjs-${kind}-${file}.js`));
      expect(typeof b64).toBe("string");
      const original = await readFile(join(PDFJS_DIR, sample));
      expect(Buffer.from(b64 as string, "base64").equals(original)).toBe(true);
    }
    // the licenses travel with the data
    for (const n of ["pdfjs-cmaps-LICENSE.txt", "pdfjs-fonts-LICENSE-FOXIT.txt"]) {
      expect(names).toContain(n);
    }
    expect(names).toContain("pdfjs-fonts-LICENSE-LIBERATION.txt");
  });

  it("stays far below the plugin size limits (50 MiB, 5 000 entries)", async () => {
    // The packed tgz is ui/ (this build) plus a handful of package files (dist/index.mjs,
    // package.json, plugin.json, icon, README, CHANGELOG); ui/ is nearly all of its bytes and
    // entries. Packing here would need the tsc build and the toolchain, so the tgz is bounded from
    // the build: gzip of every file's bytes, plus a 512-byte tar header per entry, plus 1 MiB and
    // 16 entries for the package files. (Measured at Task 11: 2.88 MiB, 208 entries.)
    const { dir, manifest } = await sharedBuild();
    const names = [...Object.keys(manifest.files), "manifest.json"];
    const contents = await Promise.all(names.map((n) => readFile(join(dir, n))));
    const gz = gzipSync(Buffer.concat(contents), { level: 9 }).length;
    const tgzBound = gz + 512 * names.length + 1024 * 1024;
    const entries = names.length + 16;
    expect(tgzBound).toBeLessThan(50 * 1024 * 1024);
    expect(entries).toBeLessThan(5000);
    // and with room to spare: a regression that ships, say, every pdfjs-dist file shows up here
    expect(tgzBound).toBeLessThan(10 * 1024 * 1024);
    expect(entries).toBeLessThan(500);
  });
});
