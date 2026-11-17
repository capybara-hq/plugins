/**
 * The deterministic build of the embed app (`pnpm build:ui`, writes `plugins/file-preview/ui/`).
 *
 * - `ui-src/app/main.ts` is the entry (`app.js`, ESM, code splitting: dynamic imports become
 *   `chunk-<hash>.js`);
 * - every `ui-src/workers/*.worker.ts` is bundled as an IIFE and shipped as `<id>.worker.js`, an ES
 *   module whose default export is that IIFE's source text. The embed loads it with `import()`
 *   (`script-src 'self'`) and starts the worker from a `blob:` URL of the text: in WebKit an
 *   opaque-origin embed cannot `fetch` its own assets under `connect-src 'self'`;
 * - `pdfjs.worker.ts` bundles pdf.js's own worker; its JPEG 2000 / JBIG2 JS decoders, which pdf.js
 *   would `import()` from a URL at run time, are bundled in (`inlinePdfjsNoWasm`);
 * - pdf.js's cmaps and standard fonts ship as `pdfjs-cmap-<file>.js` / `pdfjs-font-<file>.js`, ES
 *   modules whose default export is the file's base64: the pdf renderer `import()`s the one pdf.js
 *   asks for, again without `fetch`; their licenses ship beside them;
 * - `ui-src/index.html` is the shell, `ui-src/static/*` is copied verbatim when present (flat: a
 *   subdirectory fails the build, since served names have no `/`);
 * - `manifest.json` lists every other file with its content type and sha256, sorted by name.
 *
 * Output names are flat (`[A-Za-z0-9][A-Za-z0-9.-]*`; esbuild's chunk hashes have capitals), the
 * server serves only manifest-listed files.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type BuildOptions, build, type Plugin } from "esbuild";

export interface UiManifest {
  files: Record<string, { contentType: string; sha256: string }>;
}

const SRC = import.meta.dirname;
/** The installed pdfjs-dist package directory. */
const PDFJS_DIR = dirname(
  createRequire(join(SRC, "../package.json")).resolve("pdfjs-dist/package.json"),
);
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9.-]*$/;

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

const COMMON: BuildOptions = {
  bundle: true,
  minify: true,
  target: "es2022",
  legalComments: "none",
  charset: "utf8",
  sourcemap: false,
  write: false,
  logLevel: "silent",
  platform: "browser",
};

type Output = { name: string; bytes: Uint8Array };

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Every file below `dir` as `[relative posix path, absolute path]`, sorted. */
async function walk(dir: string, prefix = ""): Promise<Array<[string, string]>> {
  const out: Array<[string, string]> = [];
  const entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );
  for (const entry of entries) {
    const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) out.push(...(await walk(join(dir, entry.name), rel)));
    else if (entry.isFile()) out.push([rel, join(dir, entry.name)]);
  }
  return out;
}

async function bundleApp(): Promise<Output[]> {
  const result = await build({
    ...COMMON,
    entryPoints: { app: join(SRC, "app/main.ts") },
    outdir: "out",
    format: "esm",
    splitting: true,
    entryNames: "[name]",
    chunkNames: "chunk-[hash]",
    tsconfig: join(SRC, "tsconfig.json"),
  });
  return (result.outputFiles ?? []).map((f) => ({ name: basename(f.path), bytes: f.contents }));
}

/**
 * pdf.js decodes JPEG 2000 and JBIG2 images with WebAssembly, or, with `useWasm: false`, with a JS
 * decoder it loads by `import(wasmUrl + "<name>_nowasm_fallback.js")`. The embed has no
 * WebAssembly, and a worker started from a `blob:` URL has no reliable way to import a plugin
 * asset, so this plugin rewrites that one dynamic import into a lookup of the two decoders bundled
 * into the worker. The pattern must occur exactly once: a pdfjs-dist upgrade that changes it fails
 * the build instead of silently losing those images.
 */
const PDFJS_NOWASM_IMPORT =
  /await import\(\s*\/\*webpackIgnore: true\*\/\s*\/\*@vite-ignore\*\/\s*`\$\{WasmImage\.#wasmUrl\}\$\{this\._noWasmFilename\}`\)/g;

const inlinePdfjsNoWasm: Plugin = {
  name: "inline-pdfjs-nowasm",
  setup(b) {
    b.onLoad({ filter: /[\\/]pdfjs-dist[\\/].*pdf\.worker\.mjs$/ }, async (args) => {
      const source = await readFile(args.path, "utf8");
      const hits = source.match(PDFJS_NOWASM_IMPORT)?.length ?? 0;
      if (hits !== 1) {
        throw new Error(`ui build: pdf.js nowasm import found ${hits} times in ${args.path}`);
      }
      const wasmDir = join(PDFJS_DIR, "wasm");
      const prelude = [
        `import __capOpenjpeg from ${JSON.stringify(join(wasmDir, "openjpeg_nowasm_fallback.js"))};`,
        `import __capJbig2 from ${JSON.stringify(join(wasmDir, "jbig2_nowasm_fallback.js"))};`,
        "const __capNoWasm = { __proto__: null,",
        '  "openjpeg_nowasm_fallback.js": __capOpenjpeg,',
        '  "jbig2_nowasm_fallback.js": __capJbig2 };',
        "",
      ].join("\n");
      const contents =
        prelude +
        source.replace(
          PDFJS_NOWASM_IMPORT,
          "await Promise.resolve({ default: __capNoWasm[this._noWasmFilename] })",
        );
      return { contents, loader: "js" };
    });
  },
};

/** pdf.js's binary data (cmaps, standard fonts) as base64 modules, plus their licenses. */
async function pdfjsData(): Promise<Output[]> {
  const out: Output[] = [];
  const asModule = (bytes: Uint8Array) =>
    new TextEncoder().encode(
      `export default ${JSON.stringify(Buffer.from(bytes).toString("base64"))};\n`,
    );
  const sources: Array<[dir: string, kind: string, keep: RegExp]> = [
    ["cmaps", "cmap", /\.bcmap$/],
    ["standard_fonts", "font", /\.(pfb|ttf)$/],
  ];
  for (const [dir, kind, keep] of sources) {
    for (const [rel, abs] of await walk(join(PDFJS_DIR, dir))) {
      if (keep.test(rel))
        out.push({ name: `pdfjs-${kind}-${rel}.js`, bytes: asModule(await readFile(abs)) });
    }
  }
  const licenses: Array<[from: string, name: string]> = [
    ["cmaps/LICENSE", "pdfjs-cmaps-LICENSE.txt"],
    ["standard_fonts/LICENSE_FOXIT", "pdfjs-fonts-LICENSE-FOXIT.txt"],
    ["standard_fonts/LICENSE_LIBERATION", "pdfjs-fonts-LICENSE-LIBERATION.txt"],
    ["LICENSE", "pdfjs-LICENSE.txt"],
  ];
  for (const [from, name] of licenses)
    out.push({ name, bytes: await readFile(join(PDFJS_DIR, from)) });
  return out;
}

async function bundleWorkers(dir: string): Promise<Output[]> {
  if (!existsSync(dir)) return [];
  const ids = (await readdir(dir))
    .filter((f) => f.endsWith(".worker.ts"))
    .map((f) => f.slice(0, -".worker.ts".length))
    .sort();
  const out: Output[] = [];
  for (const id of ids) {
    const result = await build({
      ...COMMON,
      entryPoints: { [`${id}.worker`]: join(dir, `${id}.worker.ts`) },
      outdir: "out",
      format: "iife",
      entryNames: "[name]",
      tsconfig: join(SRC, "tsconfig.json"),
      plugins: [inlinePdfjsNoWasm],
    });
    for (const f of result.outputFiles ?? []) {
      const module = `export default ${JSON.stringify(f.text)};\n`;
      out.push({ name: basename(f.path), bytes: new TextEncoder().encode(module) });
    }
  }
  return out;
}

async function staticFiles(dir: string): Promise<Output[]> {
  if (!existsSync(dir)) return [];
  const out: Output[] = [];
  for (const [rel, abs] of await walk(dir)) {
    if (rel.includes("/")) throw new Error(`ui build: static "${rel}" is not flat`);
    out.push({ name: rel, bytes: await readFile(abs) });
  }
  return out;
}

export interface BuildUiOptions {
  /** The directory of the `*.worker.ts` entries (tests pass their own); default `ui-src/workers`. */
  workersDir?: string;
  /** The directory copied verbatim (flat); default `ui-src/static`. */
  staticDir?: string;
}

/** Builds the embed app into `outDir` (replaced) and returns the manifest it wrote. */
export async function buildUi(outDir: string, opts: BuildUiOptions = {}): Promise<UiManifest> {
  const outputs: Output[] = [
    { name: "index.html", bytes: await readFile(join(SRC, "index.html")) },
    ...(await bundleApp()),
    ...(await bundleWorkers(opts.workersDir ?? join(SRC, "workers"))),
    ...(await pdfjsData()),
    ...(await staticFiles(opts.staticDir ?? join(SRC, "static"))),
  ];
  outputs.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  const files: UiManifest["files"] = {};
  for (const { name, bytes } of outputs) {
    if (!NAME_RE.test(name)) throw new Error(`ui build: "${name}" is not a flat allowlisted name`);
    if (name === "manifest.json") throw new Error("ui build: manifest.json is reserved");
    if (files[name] !== undefined) throw new Error(`ui build: duplicate output "${name}"`);
    const contentType = CONTENT_TYPES[extname(name)];
    if (contentType === undefined) throw new Error(`ui build: no content type for "${name}"`);
    files[name] = { contentType, sha256: sha256(bytes) };
  }
  const manifest: UiManifest = { files };

  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  for (const { name, bytes } of outputs) await writeFile(join(outDir, name), bytes);
  await writeFile(join(outDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  const manifest = await buildUi(join(SRC, "../ui"));
  console.log(`file-preview: built ${Object.keys(manifest.files).length} ui files`);
}
