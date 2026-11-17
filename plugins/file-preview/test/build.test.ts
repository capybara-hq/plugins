import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
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

  it("ships the pdf.js worker as a classic script with no eval and no runtime import", async () => {
    const dir = await tempDir();
    const manifest = await buildUi(dir);
    expect(manifest.files["pdfjs.worker.js"]?.contentType).toBe("text/javascript; charset=utf-8");
    const source = await importDefault(join(dir, "pdfjs.worker.js"));
    expect(typeof source).toBe("string");
    const text = source as string;
    expect(text).toContain("WorkerMessageHandler");
    // the JPEG 2000 / JBIG2 JS decoders are bundled in, not imported from a URL at run time
    expect(text).not.toMatch(/\bimport\s*\(/);
    expect(text).toContain("nowasm");
    // no eval-like code paths in what pdf.js runs (CSP has no 'unsafe-eval')
    expect(text).not.toMatch(/new Function\(|[^.\w]eval\(/);
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
    const dir = await tempDir();
    const manifest = await buildUi(dir);
    const names = Object.keys(manifest.files);
    expect(names.length).toBeLessThan(1000);
    let bytes = 0;
    for (const n of names) bytes += (await readFile(join(dir, n))).length;
    expect(bytes).toBeLessThan(20 * 1024 * 1024);
  });
});
