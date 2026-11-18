import { fileURLToPath } from "node:url";
import {
  createDb,
  createLocalAccount,
  createOrg,
  kernelDb,
  login,
  startTestKernel,
  startTestPostgres,
  startTestRedis,
  type TestContainer,
  type TestKernel,
  testKernelConfig,
} from "@capybara-hq/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildUi } from "../ui-src/build.js";

/**
 * file-preview through a real kernel: the provider passes the kernel's `file-preview@1` checks at
 * setup, the org lists the six previewers in table order, and the shell and the built app are
 * served on the public `/ui/` routes (an encoded `..` is 404). The embed itself is tested in jsdom.
 */

const PLUGIN_DIR = fileURLToPath(new URL("../", import.meta.url));
const FILE_PREVIEW = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const UI_DIR = fileURLToPath(new URL("../ui/", import.meta.url));

let pgc: TestContainer;
let rd: TestContainer;
let k: TestKernel;
let raw: ReturnType<typeof createDb>;

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis(), buildUi(UI_DIR)]);
  k = await startTestKernel(
    testKernelConfig(
      { pg: pgc.url, redis: rd.url },
      { extensions: [FILE_PREVIEW], roles: ["api", "worker"] },
    ),
    { resolveFrom: PLUGIN_DIR },
  );
  raw = createDb(pgc.url, 3);
});

afterAll(async () => {
  await k?.close();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

describe("file-preview in a kernel", () => {
  it("lists the six previewers and serves the shell and the app", async () => {
    await createLocalAccount(kernelDb(raw), "owner");
    const owner = await login(k, "owner");
    const orgId = await createOrg(owner);
    const enabled = await owner({
      method: "PUT",
      url: `/api/v1/orgs/${orgId}/extensions/file-preview`,
      payload: { enabled: true },
    });
    expect(enabled.statusCode, enabled.body).toBe(200);

    const list = await owner({ method: "GET", url: `/api/v1/orgs/${orgId}/file-previewers` });
    expect(list.statusCode, list.body).toBe(200);
    const items = (list.json() as { items: { plugin: string; id: string }[] }).items.filter(
      (i) => i.plugin === "file-preview",
    );
    expect(items.map((i) => i.id)).toEqual(["code", "zip", "sheet", "docx", "pdf", "svg"]);

    const shell = await k.http.inject({ method: "GET", url: "/plugins/file-preview/ui/code" });
    expect(shell.statusCode, shell.body).toBe(200);
    expect(shell.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(shell.body).toContain('<meta name="previewer" content="code">');

    const app = await k.http.inject({
      method: "GET",
      url: "/plugins/file-preview/ui/assets/app.js",
    });
    expect(app.statusCode).toBe(200);
    expect(app.headers["content-type"]).toBe("text/javascript; charset=utf-8");

    const escaped = await k.http.inject({
      method: "GET",
      url: "/plugins/file-preview/ui/assets/%2e%2e%2fpackage.json",
    });
    expect(escaped.statusCode).toBe(404);
  });
});
