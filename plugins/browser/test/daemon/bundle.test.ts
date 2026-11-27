import { type ChildProcess, spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildDaemon } from "../../daemon/build.js";
import { ensureChromium } from "../../daemon/chromium.js";
import { removeDir, request, startFixtureServer, TEST_BROWSERS } from "./helpers.js";

let out: string;
let stateDir: string;
let cache: string;
let child: ChildProcess | undefined;
let fx: Awaited<ReturnType<typeof startFixtureServer>>;

beforeAll(async () => {
  out = mkdtempSync(join(tmpdir(), "cbd-build-"));
  stateDir = mkdtempSync(join(tmpdir(), "cbd-"));
  fx = await startFixtureServer({ "/": "<!doctype html><title>Bundled</title><h1>hello</h1>" });
  await buildDaemon(out);
  // the shared download stands in for a device's read-only browsers cache: a directory the daemon
  // cannot write, linking the downloaded revisions
  mkdirSync(TEST_BROWSERS, { recursive: true });
  await ensureChromium(TEST_BROWSERS);
  cache = mkdtempSync(join(tmpdir(), "cbd-cache-"));
  for (const name of readdirSync(TEST_BROWSERS))
    symlinkSync(join(TEST_BROWSERS, name), join(cache, name));
  chmodSync(cache, 0o555);
});

afterAll(async () => {
  if (child && child.exitCode === null) {
    const exited = new Promise((r) => child?.once("exit", r));
    child.kill("SIGTERM");
    await exited;
  }
  await fx?.close();
  removeDir(out);
  removeDir(stateDir);
  chmodSync(cache, 0o755);
  removeDir(cache);
});

describe("bundled daemon", () => {
  it("runs as a service from its built files alone", async () => {
    const socketPath = join(stateDir, "sock");
    child = spawn(process.execPath, [join(out, "daemon.mjs")], {
      cwd: stateDir,
      env: {
        PATH: process.env.PATH ?? "",
        CAPYBARA_SERVICE_SOCKET: socketPath,
        CAPYBARA_SERVICE_STATE: stateDir,
        PLAYWRIGHT_BROWSERS_PATH: cache,
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let log = "";
    await new Promise<void>((resolve, reject) => {
      child?.stderr?.on("data", (c: Buffer) => {
        log += c.toString();
        if (log.includes("listening on")) resolve();
      });
      child?.once("exit", (code) => reject(new Error(`daemon exited ${code}: ${log}`)));
    });
    const nav = await request(socketPath, { op: "navigate", url: `${fx.url}/` });
    expect(nav).toMatchObject({ ok: true, page: { title: "Bundled" } });
    const exited = new Promise<number | null>((r) => child?.once("exit", (code) => r(code)));
    child.kill("SIGTERM");
    expect(await exited).toBe(0);
  });

  it("ships the patched playwright-core (a site challenge nobody answers is cancelled)", () => {
    const core = readFileSync(
      join(out, "vendor", "playwright-core", "lib", "coreBundle.js"),
      "utf8",
    );
    expect(core).toContain("capybara patch (plugins#292)");
  });
});
