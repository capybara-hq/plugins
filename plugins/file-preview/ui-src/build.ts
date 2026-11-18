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
 * - `THIRD-PARTY-LICENSES.txt` holds the license of every npm package bundled into the app or a
 *   worker (found from esbuild's metafile; a package with no license file fails the build), the
 *   production dependency closure of prebuilt `*.min.js` bundles (which embed it), and the legal comments
 *   esbuild kept from the bundled sources; pdf.js's data licenses ship as their own files;
 * - `manifest.json` lists every other file with its content type and sha256, sorted by name.
 *
 * esbuild runs with `absWorkingDir` set to the plugin directory: chunk hashes depend on the paths
 * esbuild sees, so building from another working directory would otherwise change the output.
 *
 * Output names are flat (`[A-Za-z0-9][A-Za-z0-9.-]*`; esbuild's chunk hashes have capitals), the
 * server serves only manifest-listed files.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { type BuildOptions, type BuildResult, build, type Plugin } from "esbuild";

export interface UiManifest {
  files: Record<string, { contentType: string; sha256: string }>;
}

const SRC = import.meta.dirname;
/** The plugin directory: esbuild's working directory, whatever `process.cwd()` is. */
const PLUGIN_DIR = resolve(SRC, "..");
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
  // kept out of the bundles, collected into THIRD-PARTY-LICENSES.txt (`<output>.LEGAL.txt`)
  legalComments: "external",
  charset: "utf8",
  sourcemap: false,
  write: false,
  metafile: true,
  logLevel: "silent",
  platform: "browser",
  absWorkingDir: PLUGIN_DIR,
};

type Output = { name: string; bytes: Uint8Array };

/** What the bundles were made from: metafile inputs (absolute) and the legal comments per output. */
interface Provenance {
  inputs: Set<string>;
  legal: Map<string, string>;
}

const LEGAL_SUFFIX = ".LEGAL.txt";

/** Records `result`'s inputs and legal comments; returns its code outputs. */
function collect(
  result: BuildResult,
  prov: Provenance,
): Array<{ name: string; text: string; bytes: Uint8Array }> {
  for (const input of Object.keys(result.metafile?.inputs ?? {})) {
    prov.inputs.add(resolve(PLUGIN_DIR, input));
  }
  const out: Array<{ name: string; text: string; bytes: Uint8Array }> = [];
  for (const f of result.outputFiles ?? []) {
    const name = basename(f.path);
    if (name.endsWith(LEGAL_SUFFIX)) prov.legal.set(name.slice(0, -LEGAL_SUFFIX.length), f.text);
    else out.push({ name, text: f.text, bytes: f.contents });
  }
  return out;
}

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

async function bundleApp(prov: Provenance): Promise<Output[]> {
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
  return collect(result, prov).map(({ name, bytes }) => ({ name, bytes }));
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

async function bundleWorkers(dir: string, prov: Provenance): Promise<Output[]> {
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
    for (const f of collect(result, prov)) {
      const module = `export default ${JSON.stringify(f.text)};\n`;
      out.push({ name: f.name, bytes: new TextEncoder().encode(module) });
    }
  }
  return out;
}

/** A package's license file names, tried in this order (case-insensitive). */
const LICENSE_FILE_RE = /^(?:LICEN[CS]E|COPYING)(?:[.-][A-Za-z0-9.-]*)?$/i;

interface PackageInfo {
  name: string;
  version: string;
  license: string;
  author: string | undefined;
  dir: string;
}

/** The package directory holding `file` (the last `node_modules/<name>` or `node_modules/@s/<name>`). */
function packageDirOf(file: string): string | undefined {
  const parts = file.split(sep);
  const at = parts.lastIndexOf("node_modules");
  if (at < 0 || at + 1 >= parts.length) return undefined;
  const scoped = parts[at + 1]?.startsWith("@") === true;
  return parts.slice(0, at + (scoped ? 3 : 2)).join(sep);
}

async function packageInfo(dir: string): Promise<PackageInfo> {
  const json = JSON.parse(await readFile(join(dir, "package.json"), "utf8")) as {
    name?: string;
    version?: string;
    license?: string;
    author?: string | { name?: string };
  };
  if (json.name === undefined || json.version === undefined) {
    throw new Error(`ui build: ${dir}/package.json has no name or version`);
  }
  // "Name <mail> (url)" -> "Name"
  const author = (typeof json.author === "string" ? json.author : json.author?.name)
    ?.replace(/\s*[<(].*$/, "")
    .trim();
  return {
    name: json.name,
    version: json.version,
    license: json.license ?? "unknown",
    author,
    dir,
  };
}

/** `name` as Node resolves it from `fromDir` (walking up `node_modules`), symlinks resolved. */
async function findPackage(fromDir: string, name: string): Promise<string> {
  for (let dir = fromDir; ; dir = dirname(dir)) {
    const base = basename(dir) === "node_modules" ? dir : join(dir, "node_modules");
    const candidate = join(base, name);
    if (existsSync(join(candidate, "package.json"))) return realpath(candidate);
    if (dirname(dir) === dir) throw new Error(`ui build: cannot find ${name} from ${fromDir}`);
  }
}

/**
 * Packages that ship no license file. Their entry is the standard text of the license they
 * declare (`declared` is what their package.json says, compared exactly, so a changed declaration
 * fails the build) with the package's author as the copyright holder. Any other package without a
 * license file fails the build.
 */
const NO_LICENSE_FILE: Readonly<
  Record<string, { license: "ISC" | "MIT"; declared: string | undefined }>
> = {
  // inlined in exceljs's browser bundle; only README, package.json and code
  saxes: { license: "ISC", declared: "ISC" },
  // in exceljs's closure (unzipper); the README of isarray carries the MIT text, binary's says MIT
  binary: { license: "MIT", declared: "MIT" },
  isarray: { license: "MIT", declared: "MIT" },
  chainsaw: { license: "MIT", declared: "MIT/X11" },
  // declares no license at all; its npm registry page and repository say MIT
  buffers: { license: "MIT", declared: undefined },
};

const ISC_TEXT = (holder: string) =>
  [
    "ISC License",
    "",
    `Copyright (c) ${holder}`,
    "",
    "Permission to use, copy, modify, and/or distribute this software for any",
    "purpose with or without fee is hereby granted, provided that the above",
    "copyright notice and this permission notice appear in all copies.",
    "",
    'THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES',
    "WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF",
    "MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR",
    "ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES",
    "WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN",
    "ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF",
    "OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.",
  ].join("\n");

const MIT_TEXT = (holder: string) =>
  [
    "MIT License",
    "",
    `Copyright (c) ${holder}`,
    "",
    "Permission is hereby granted, free of charge, to any person obtaining a copy",
    'of this software and associated documentation files (the "Software"), to deal',
    "in the Software without restriction, including without limitation the rights",
    "to use, copy, modify, merge, publish, distribute, sublicense, and/or sell",
    "copies of the Software, and to permit persons to whom the Software is",
    "furnished to do so, subject to the following conditions:",
    "",
    "The above copyright notice and this permission notice shall be included in all",
    "copies or substantial portions of the Software.",
    "",
    'THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR',
    "IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,",
    "FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE",
    "AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER",
    "LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,",
    "OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE",
    "SOFTWARE.",
  ].join("\n");

async function licenseText(pkg: PackageInfo): Promise<{ file: string; text: string }> {
  const files = (await readdir(pkg.dir)).filter((f) => LICENSE_FILE_RE.test(f)).sort();
  if (files.length === 0) {
    const declared = NO_LICENSE_FILE[pkg.name];
    if (
      declared !== undefined &&
      (pkg.license === "unknown" ? undefined : pkg.license) === declared.declared &&
      pkg.author !== undefined
    ) {
      return {
        file: "no license file: standard text, author from package.json",
        text: (declared.license === "ISC" ? ISC_TEXT : MIT_TEXT)(pkg.author),
      };
    }
    throw new Error(`ui build: bundled package ${pkg.name}@${pkg.version} has no license file`);
  }
  const parts = await Promise.all(files.map((f) => readFile(join(pkg.dir, f), "utf8")));
  return { file: files.join(", "), text: parts.map((t) => t.trimEnd()).join("\n\n") };
}

const byKey = (a: PackageInfo, b: PackageInfo) => {
  const ka = `${a.name}@${a.version}`;
  const kb = `${b.name}@${b.version}`;
  return ka < kb ? -1 : ka > kb ? 1 : 0;
};

/**
 * `THIRD-PARTY-LICENSES.txt`: every package an esbuild metafile lists as an input, the production
 * dependency closure of the packages bundled from a prebuilt `*.min.js` (exceljs and JSZip ship
 * browser bundles that embed theirs, and theirs in turn), and the legal comments esbuild kept,
 * per output file.
 */
async function thirdPartyLicenses(prov: Provenance): Promise<Output> {
  const bundled = new Map<string, PackageInfo>();
  const prebuilt = new Set<string>();
  for (const input of [...prov.inputs].sort()) {
    const dir = packageDirOf(input);
    if (dir === undefined) continue;
    const real = await realpath(dir);
    if (!bundled.has(real)) bundled.set(real, await packageInfo(real));
    if (/\.min\.js$/.test(input)) prebuilt.add(real);
  }
  // The prebuilt bundle inlines its dependencies and theirs in turn, and the bundle does not say
  // which: take the whole production closure (`dependencies`, node resolution from each package;
  // one that is not installed is skipped, as npm does for optional ones). Over-listing a package
  // that is not inlined costs nothing; leaving one out would drop a notice that must ship.
  const embedded = new Map<string, { pkg: PackageInfo; in: Set<string> }>();
  for (const real of [...prebuilt].sort()) {
    const host = bundled.get(real) as PackageInfo;
    const visited = new Set<string>([real]);
    const queue = [real];
    for (let dir = queue.shift(); dir !== undefined; dir = queue.shift()) {
      const json = JSON.parse(await readFile(join(dir, "package.json"), "utf8")) as {
        dependencies?: Record<string, string>;
      };
      for (const dep of Object.keys(json.dependencies ?? {}).sort()) {
        let depDir: string;
        try {
          depDir = await findPackage(dir, dep);
        } catch {
          continue;
        }
        if (visited.has(depDir)) continue;
        visited.add(depDir);
        queue.push(depDir);
        if (bundled.has(depDir)) continue;
        const entry = embedded.get(depDir) ?? { pkg: await packageInfo(depDir), in: new Set() };
        entry.in.add(`${host.name}@${host.version}`);
        embedded.set(depDir, entry);
      }
    }
  }

  const bundledList = [...bundled.values()].sort(byKey);
  const embeddedList = [...embedded.values()].sort((a, b) => byKey(a.pkg, b.pkg));
  const rule = "=".repeat(78);
  const lines: string[] = [
    "Third-party software in the file-preview embed (ui/)",
    "",
    "Generated by ui-src/build.ts from the installed packages; do not edit. pdf.js's cmaps and",
    "standard fonts ship with their own licenses: pdfjs-cmaps-LICENSE.txt,",
    "pdfjs-fonts-LICENSE-FOXIT.txt and pdfjs-fonts-LICENSE-LIBERATION.txt.",
    "",
    "Bundled packages:",
    ...bundledList.map((p) => `  ${p.name}@${p.version} (${p.license})`),
    "",
    "Embedded in prebuilt bundles (dependency closure of a bundled *.min.js):",
    ...embeddedList.map(
      ({ pkg, in: hosts }) =>
        `  ${pkg.name}@${pkg.version} (${pkg.license}), in ${[...hosts].sort().join(", ")}`,
    ),
    "",
  ];
  for (const pkg of [...bundledList, ...embeddedList.map((e) => e.pkg)]) {
    const { file, text } = await licenseText(pkg);
    lines.push(
      rule,
      `${pkg.name}@${pkg.version}`,
      `License: ${pkg.license} (${file})`,
      rule,
      "",
      text,
      "",
    );
  }
  for (const output of [...prov.legal.keys()].sort()) {
    lines.push(rule, `Legal comments kept from the sources of ${output}`, rule, "");
    lines.push((prov.legal.get(output) as string).trimEnd(), "");
  }
  return { name: THIRD_PARTY_LICENSES, bytes: new TextEncoder().encode(lines.join("\n")) };
}

export const THIRD_PARTY_LICENSES = "THIRD-PARTY-LICENSES.txt";

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
  const prov: Provenance = { inputs: new Set(), legal: new Map() };
  const outputs: Output[] = [
    { name: "index.html", bytes: await readFile(join(SRC, "index.html")) },
    ...(await bundleApp(prov)),
    ...(await bundleWorkers(opts.workersDir ?? join(SRC, "workers"), prov)),
    ...(await pdfjsData()),
    ...(await staticFiles(opts.staticDir ?? join(SRC, "static"))),
  ];
  outputs.push(await thirdPartyLicenses(prov));
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

// `tsx ui-src/build.ts [outDir]`: outDir (relative to the working directory) defaults to ui/
if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  const outArg = process.argv[2];
  const manifest = await buildUi(outArg === undefined ? join(PLUGIN_DIR, "ui") : resolve(outArg));
  console.log(`file-preview: built ${Object.keys(manifest.files).length} ui files`);
}
