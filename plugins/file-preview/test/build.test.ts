import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

  it("ships the real worker directory without test-only workers", async () => {
    const manifest = await buildUi(await tempDir());
    expect(Object.keys(manifest.files).filter((n) => n.endsWith(".worker.js"))).toEqual([]);
  });
});
