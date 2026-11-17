import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
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
});
