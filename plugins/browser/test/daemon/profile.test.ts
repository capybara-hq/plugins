import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { removeDir, request, startFixtureServer, startTestDaemon } from "./helpers.js";

let fx: Awaited<ReturnType<typeof startFixtureServer>>;
const dirs: string[] = [];

beforeAll(async () => {
  fx = await startFixtureServer({
    "/set": (_req, res) => {
      res.writeHead(200, {
        "content-type": "text/html",
        "set-cookie": "kept=v1; Max-Age=3600; Path=/",
      });
      res.end("<!doctype html><title>Set</title><p>set</p>");
    },
    "/get": (req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`<!doctype html><title>Get</title><p>cookie: ${req.headers.cookie ?? "none"}</p>`);
    },
  });
});

afterAll(async () => {
  await fx?.close();
  for (const dir of dirs) removeDir(dir);
});

describe("browser daemon profile", () => {
  // grace 1 ms: the stop gives up (and kills Chromium) before Chromium has written its Cookies
  // file, as a loaded service stop does at the supervisor's 2 s SIGKILL
  it.each([60_000, 1])(
    "profile persists across daemon restarts (close grace %i ms)",
    async (grace) => {
      const first = await startTestDaemon({ browserCloseGraceMs: grace });
      dirs.push(first.stateDir);
      await request(first.socketPath, { op: "navigate", url: `${fx.url}/set` });
      await first.stop();
      const second = await startTestDaemon({ stateDir: first.stateDir });
      try {
        await request(second.socketPath, { op: "navigate", url: `${fx.url}/get` });
        const snap = await request(second.socketPath, { op: "snapshot" });
        if (!snap.ok) throw new Error(snap.message);
        expect(snap.text).toContain("kept=v1");
      } finally {
        await second.stop();
      }
    },
  );
});
