import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildDaemon } from "../../daemon/build.js";
import { removeDir, request, startFixtureServer, TEST_BROWSERS } from "./helpers.js";

let out: string;
let stateDir: string;
let child: ChildProcess | undefined;
let fx: Awaited<ReturnType<typeof startFixtureServer>>;

beforeAll(async () => {
  out = mkdtempSync(join(tmpdir(), "cbd-build-"));
  stateDir = mkdtempSync(join(tmpdir(), "cbd-"));
  fx = await startFixtureServer({ "/": "<!doctype html><title>Bundled</title><h1>hello</h1>" });
  await buildDaemon(out);
  // the shared download stands in for <state>/browsers
  mkdirSync(TEST_BROWSERS, { recursive: true });
  symlinkSync(TEST_BROWSERS, join(stateDir, "browsers"));
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
});
