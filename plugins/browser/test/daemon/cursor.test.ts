import { chromium } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureChromium } from "../../daemon/chromium.js";
import { CursorResolver } from "../../daemon/cursor.js";
import { startFixtureServer, TEST_BROWSERS } from "./helpers.js";

// Out-of-process frames: every frame is its own site (a.test, b.test, c.test all map to the local
// fixture server), and site isolation puts each in its own renderer, reached through its own CDP
// session (the daemon's macOS single-process mode keeps frames in process; Linux devices do not).
let fx: Awaited<ReturnType<typeof startFixtureServer>>;
let port = 0;
const at = (site: string, path: string) => `http://${site}.test:${port}${path}`;
const html = (body: string) => (_req: unknown, res: import("node:http").ServerResponse) =>
  res
    .writeHead(200, { "content-type": "text/html" })
    .end(`<!doctype html><body style="margin:0">${body}`);

beforeAll(async () => {
  // the pages name the other sites with the port, known once the server listens
  fx = await startFixtureServer({
    "/top": (req, res) =>
      html(
        `<iframe src="${at("b", "/middle")}" style="position:absolute;left:100px;top:200px;width:600px;height:400px;border:3px solid"></iframe>`,
      )(req, res),
    "/middle": (req, res) =>
      html(
        `<iframe src="${at("c", "/leaf")}" style="position:absolute;left:50px;top:40px;width:400px;height:300px;border:0"></iframe>`,
      )(req, res),
    "/leaf": html(`<a href="#x" style="display:block;height:300px">leaf</a>`),
  });
  port = Number(new URL(fx.url).port);
});

afterAll(async () => {
  await fx?.close();
});

describe("cursor resolution across out-of-process frames", () => {
  it("finds the cursor in a cross-site frame nested in another, and detaches their sessions", async () => {
    const exe = await ensureChromium(TEST_BROWSERS);
    const browser = await chromium.launch({
      executablePath: exe,
      args: ["--site-per-process", "--host-resolver-rules=MAP *.test 127.0.0.1"],
    });
    try {
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
      const page = await ctx.newPage();
      await page.goto(at("a", "/top"));
      await expect.poll(() => page.frames().length).toBe(3);
      await page.frames()[2]?.waitForLoadState("load");
      const cdp = await ctx.newCDPSession(page);
      const r = new CursorResolver(ctx, page, cdp);
      // the leaf's link: top frame offset (103, 203) + middle (50, 40) = (153, 243) onwards
      expect(await r.at(200, 300)).toBe("pointer");
      // the middle frame outside the leaf: nothing
      expect(await r.at(650, 550)).toBe("default");
      expect(r.openSessions).toBeGreaterThan(0);
      // a frame that goes away takes its session with it
      await page.evaluate(`document.querySelector("iframe")?.remove()`);
      await expect.poll(() => r.openSessions).toBe(0);
      r.dispose();
    } finally {
      await browser.close();
    }
  });
});
