import { chmodSync, mkdirSync, mkdtempSync, readdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureChromium, HEADLESS_SHELL_NOTE } from "../../daemon/chromium.js";
import { type Daemon, startDaemon } from "../../daemon/main.js";
import { removeDir, request, startFixtureServer, TEST_BROWSERS } from "./helpers.js";

// The browser on macOS without CAPYBARA_SERVICE_MACH (an older capybara-device) runs the headless
// shell, and the next tool result says how to get the full browser; elsewhere no such note.
let cache: string;
let stateDir: string;
let daemon: Daemon | undefined;
let fx: Awaited<ReturnType<typeof startFixtureServer>>;

beforeAll(async () => {
  fx = await startFixtureServer({ "/": "<!doctype html><title>Note</title><p>x</p>" });
  // a read-only cache standing in for a device's shipped browsers: the shared download linked in
  // (installed into it first when missing; playwright-core then knows this directory only)
  cache = mkdtempSync(join(tmpdir(), "cbd-cache-"));
  mkdirSync(TEST_BROWSERS, { recursive: true });
  for (const name of readdirSync(TEST_BROWSERS))
    symlinkSync(join(TEST_BROWSERS, name), join(cache, name));
  await ensureChromium(cache);
  chmodSync(cache, 0o555);
  stateDir = mkdtempSync(join(tmpdir(), "cbd-"));
});

afterAll(async () => {
  await daemon?.close();
  await fx?.close();
  chmodSync(cache, 0o755);
  removeDir(cache);
  removeDir(stateDir);
});

describe("the headless shell note", () => {
  it("comes with the first tool result exactly when the headless shell runs", async () => {
    daemon = await startDaemon({
      socketPath: join(stateDir, "sock"),
      stateDir,
      // no CAPYBARA_SERVICE_MACH: macOS keeps the headless shell
      env: { PLAYWRIGHT_BROWSERS_PATH: cache },
    });
    await daemon.ready;
    const r = await request(join(stateDir, "sock"), { op: "navigate", url: `${fx.url}/` });
    expect(r.ok).toBe(true);
    const text = r.ok ? (r.text ?? "") : "";
    expect(text.includes(HEADLESS_SHELL_NOTE)).toBe(process.platform === "darwin");
  });
});
