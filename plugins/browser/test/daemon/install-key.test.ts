import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { browserInstallKey, INSTALL_KEY_RE } from "../../daemon/install-key.js";
import {
  downloadedBytes,
  installingMessage,
  progressLineTotal,
} from "../../daemon/install-progress.js";

describe("the browser install key (plugins#311)", () => {
  it("names both Chromium builds' revisions of the playwright-core in use", () => {
    const pkg = createRequire(import.meta.url).resolve("playwright-core/package.json");
    const json = readFileSync(join(dirname(pkg), "browsers.json"), "utf8");
    const key = browserInstallKey(json);
    expect(key).toMatch(/^chromium-\d+\+chromium-headless-shell-\d+$/);
    expect(INSTALL_KEY_RE.test(key)).toBe(true);
  });

  it("changes with a revision and only with one", () => {
    const of = (a: string, b: string, extra = "") =>
      browserInstallKey(
        JSON.stringify({
          comment: extra,
          browsers: [
            { name: "chromium", revision: a, browserVersion: extra },
            { name: "chromium-headless-shell", revision: b },
            { name: "firefox", revision: extra || "1" },
          ],
        }),
      );
    expect(of("1255", "1255")).toBe("chromium-1255+chromium-headless-shell-1255");
    expect(of("1255", "1255", "9")).toBe(of("1255", "1255"));
    expect(of("1256", "1255")).not.toBe(of("1255", "1255"));
    expect(() => browserInstallKey(JSON.stringify({ browsers: [] }))).toThrow(/no revision/);
  });
});

describe("the installing reply's progress", () => {
  it("reads Playwright's progress line and the zip in the temporary directory", () => {
    expect(progressLineTotal("|■■■■■■■■                | 10% of 180.3 MiB")).toBe(
      Math.round(180.3 * 1024 * 1024),
    );
    expect(progressLineTotal("Downloading Chromium 159.0 from https://x")).toBeUndefined();
    expect(downloadedBytes("/nonexistent/dir")).toBeUndefined();
  });

  it("says how far the download got", () => {
    expect(installingMessage({})).toContain("(starting the download)");
    expect(installingMessage({ downloaded: 50 * 1048576 })).toContain("(50 MB downloaded)");
    expect(installingMessage({ downloaded: 50 * 1048576, total: 180 * 1048576 })).toContain(
      "(50 of 180 MB downloaded)",
    );
    expect(installingMessage({ downloaded: 180 * 1048576, total: 180 * 1048576 })).toContain(
      "180 MB downloaded, unpacking it",
    );
    expect(installingMessage({ total: 180 * 1048576 })).toContain("unpacking");
    expect(installingMessage({})).toMatch(/Call the tool again in a moment\.$/);
  });
});
