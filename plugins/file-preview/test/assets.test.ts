import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cacheControl, createUiAssets, type UiAssets } from "../src/assets.js";
import { buildUi } from "../ui-src/build.js";

let root: string;
let assets: UiAssets;

const get = (path: string) => assets.asset(new Request(`http://kernel${path}`));
const base = "/plugins/file-preview/ui/assets/";

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "file-preview-assets-"));
  const ui = join(root, "ui");
  await buildUi(ui);
  // a file next to ui/ that must never be reachable, and one inside ui/ the manifest does not list
  await writeFile(join(root, "package.json"), '{"secret":true}\n');
  await writeFile(join(ui, "stray.js"), "secret()\n");
  assets = createUiAssets(pathToFileURL(`${ui}/`));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("ui assets", () => {
  it("serves a manifest-listed file with its content type and cache policy", async () => {
    const res = await get(`${base}app.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("no-cache");
    expect((await res.text()).length).toBeGreaterThan(0);
  });

  it("refuses every name that escapes or is not in the manifest", async () => {
    for (const path of [
      `${base}../package.json`,
      `${base}%2e%2e%2fpackage.json`,
      `${base}..%2fpackage.json`,
      `${base}%2E%2E%2Fpackage.json`,
      `${base}..%5cpackage.json`,
      `${base}manifest.json`,
      `${base}stray.js`,
      `${base}constructor`,
      `${base}__proto__`,
      `${base}`,
      `${base}app.js%00`,
      `${base}sub/app.js`,
    ]) {
      const res = await get(path);
      expect(res.status, path).toBe(404);
      expect(await res.text(), path).not.toContain("secret");
    }
  });

  it("the shell names its previewer and loads the app from assets/", async () => {
    const res = await assets.shell("pdf");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("no-cache");
    const html = await res.text();
    expect(html).toContain('<meta name="previewer" content="pdf">');
    expect(html).toContain('src="assets/app.js"');
  });

  it("hashed chunks are immutable", () => {
    expect(cacheControl("chunk-ABC123.js")).toBe("private, max-age=31536000, immutable");
    for (const name of ["index.html", "app.js", "pdf.worker.js", "font.woff2"])
      expect(cacheControl(name), name).toBe("no-cache");
  });
});
