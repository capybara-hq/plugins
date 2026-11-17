/**
 * The deterministic build of the embed app (`pnpm build:ui`, writes `plugins/file-preview/ui/`).
 *
 * - `ui-src/app/main.ts` is the entry (`app.js`, ESM, code splitting: dynamic imports become
 *   `chunk-<hash>.js`);
 * - every `ui-src/workers/*.worker.ts` is its own IIFE bundle `<id>.worker.js`;
 * - `ui-src/index.html` is the shell, `ui-src/static/**` is copied verbatim when present;
 * - `manifest.json` lists every other file with its content type and sha256, sorted by name.
 *
 * Output names are flat (`[a-z0-9][a-z0-9.-]*`), the server serves only manifest-listed files.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type BuildOptions, build } from "esbuild";

export interface UiManifest {
  files: Record<string, { contentType: string; sha256: string }>;
}

const SRC = import.meta.dirname;
const NAME_RE = /^[a-z0-9][a-z0-9.-]*$/;

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".wasm": "application/wasm",
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

async function bundleWorkers(): Promise<Output[]> {
  const dir = join(SRC, "workers");
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
    });
    for (const f of result.outputFiles ?? [])
      out.push({ name: basename(f.path), bytes: f.contents });
  }
  return out;
}

async function staticFiles(): Promise<Output[]> {
  const dir = join(SRC, "static");
  if (!existsSync(dir)) return [];
  const out: Output[] = [];
  for (const [rel, abs] of await walk(dir)) {
    out.push({ name: rel, bytes: await readFile(abs) });
  }
  return out;
}

/** Builds the embed app into `outDir` (replaced) and returns the manifest it wrote. */
export async function buildUi(outDir: string): Promise<UiManifest> {
  const outputs: Output[] = [
    { name: "index.html", bytes: await readFile(join(SRC, "index.html")) },
    ...(await bundleApp()),
    ...(await bundleWorkers()),
    ...(await staticFiles()),
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
