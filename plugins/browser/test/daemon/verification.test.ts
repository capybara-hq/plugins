import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { looksLikeVerification, VERIFICATION_NOTE } from "../../daemon/verification.js";
import {
  openViewer,
  removeDir,
  request,
  startFixtureServer,
  startTestDaemon,
  type TestDaemon,
  type ViewerMsg,
} from "./helpers.js";

let fx: Awaited<ReturnType<typeof startFixtureServer>>;
let d: TestDaemon;

beforeAll(async () => {
  fx = await startFixtureServer({
    "/check": "<!doctype html><title>安全验证</title><p>请完成下方验证后继续操作</p>",
    "/widget":
      '<!doctype html><title>Search</title><div class="geetest_captcha_box" style="width:300px;height:200px">slide</div>',
    "/plain": "<!doctype html><title>Results</title><p>ten results</p>",
    "/teapot": (_req, res) => {
      res.writeHead(418, { "content-type": "text/html" }).end("<title>Error</title>anomaly");
    },
  });
  d = await startTestDaemon();
});

afterAll(async () => {
  await d?.stop();
  await fx?.close();
  if (d) removeDir(d.stateDir);
});

const blockerOf = (m: ViewerMsg) =>
  m.t === "state" ? m.tabs.find((t) => t.active)?.blocker : undefined;

describe("verification pages", () => {
  it("are recognised by URL and title", () => {
    expect(looksLikeVerification("https://www.google.com/sorry/index?continue=x", "")).toBe(true);
    expect(looksLikeVerification("https://wappass.baidu.com/static/captcha/tuxing.html", "")).toBe(
      true,
    );
    expect(looksLikeVerification("https://example.com/", "Just a moment...")).toBe(true);
    expect(looksLikeVerification("https://example.com/news", "今日新闻")).toBe(false);
  });

  it("a tool result says to hand off and the panel's tab state carries the blocker until the page changes", async () => {
    const viewer = await openViewer(d.socketPath, { maxWidth: 480, maxHeight: 300 });
    try {
      const nav = await request(d.socketPath, { op: "navigate", url: `${fx.url}/check` });
      expect(nav.ok).toBe(true);
      if (!nav.ok) return;
      expect(nav.text?.startsWith(VERIFICATION_NOTE)).toBe(true);
      expect(blockerOf(await viewer.next((m) => blockerOf(m) !== undefined))).toEqual({
        kind: "verification",
        url: `${fx.url}/check`,
      });
      const snap = await request(d.socketPath, { op: "snapshot" });
      expect(snap.ok && snap.text?.startsWith(VERIFICATION_NOTE)).toBe(true);
      // the person (or the agent) moves on: cleared
      const plain = await request(d.socketPath, { op: "navigate", url: `${fx.url}/plain` });
      expect(plain.ok && (plain.text ?? "").includes(VERIFICATION_NOTE)).toBe(false);
      await viewer.next(
        (m) =>
          m.t === "state" &&
          m.tabs.some((t) => t.active && t.url.endsWith("/plain") && t.blocker === undefined),
      );
    } finally {
      await viewer.close();
    }
  });

  it("a CAPTCHA widget or a 418 answer counts as well", async () => {
    for (const path of ["/widget", "/teapot"]) {
      const r = await request(d.socketPath, { op: "navigate", url: `${fx.url}${path}` });
      expect(r.ok && r.text?.startsWith(VERIFICATION_NOTE)).toBe(true);
    }
  });
});
