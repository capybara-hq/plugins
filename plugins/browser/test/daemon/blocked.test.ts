import { createServer, type Server } from "node:http";
import { connect } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  openViewer,
  removeDir,
  request,
  startFixtureServer,
  startTestDaemon,
  type TestDaemon,
} from "./helpers.js";

/** An egress proxy like the device's: refuses blocked.test (403), tunnels everything else. */
async function startRefusingProxy(): Promise<{ url: string; server: Server }> {
  const refused = (host: string) => host.split(":")[0] === "blocked.test";
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "");
    if (refused(url.host)) {
      res.writeHead(403, { "content-type": "text/plain", connection: "close" });
      res.end(`Outbound access to ${url.hostname} is blocked by the sandbox egress allowlist.\n`);
      return;
    }
    res.writeHead(502).end("fixture proxy forwards nothing over plain HTTP\n");
  });
  server.on("connect", (req, sock) => {
    const target = req.url ?? "";
    if (refused(target)) {
      sock.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      return;
    }
    const [host, port] = target.split(":");
    const up = connect(Number(port), host, () => sock.write("HTTP/1.1 200 OK\r\n\r\n"));
    up.pipe(sock).pipe(up);
    up.on("error", () => sock.destroy());
    sock.on("error", () => up.destroy());
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  if (addr === null || typeof addr === "string") throw new Error("no address");
  return { url: `http://127.0.0.1:${addr.port}`, server };
}

let proxy: Awaited<ReturnType<typeof startRefusingProxy>>;
let d: TestDaemon;

beforeAll(async () => {
  proxy = await startRefusingProxy();
  d = await startTestDaemon({ env: { HTTPS_PROXY: proxy.url } });
});

afterAll(async () => {
  await d?.stop();
  proxy?.server.closeAllConnections();
  proxy?.server.close();
  if (d) removeDir(d.stateDir);
});

describe("browser daemon blocked hosts", () => {
  it("blocked navigation is reported with its host", async () => {
    const v = await openViewer(d.socketPath, { maxWidth: 480, maxHeight: 300 });
    const blocked = v.next((m) => m.t === "blocked");
    const r = await request(d.socketPath, { op: "navigate", url: "https://blocked.test/page" });
    expect(r).toMatchObject({ ok: false, error: "blocked", blockedHosts: ["blocked.test"] });
    expect(await blocked).toMatchObject({ t: "blocked", host: "blocked.test" });
    await v.close();
  });

  it("uploads are refused without a workspace", async () => {
    const r = await request(d.socketPath, { op: "upload", ref: "e1", path: "/etc/hosts" });
    expect(r).toMatchObject({
      ok: false,
      error: "failed",
      message: "Uploads are unavailable: the device has no workspace.",
    });
  });

  it("an address-bar navigation the proxy refuses during a takeover reaches the viewer", async () => {
    const v = await openViewer(d.socketPath, { maxWidth: 480, maxHeight: 300 });
    await v.next((m) => m.t === "state");
    const taken = v.after((m) => m.t === "state" && m.control === "user");
    v.send({ t: "takeover" });
    await taken;
    const blocked = v.after((m) => m.t === "blocked");
    v.send({ t: "nav", url: "https://blocked.test/typed" });
    expect(await blocked).toMatchObject({ t: "blocked", host: "blocked.test" });
    const back = v.after((m) => m.t === "state" && m.control === "agent");
    v.send({ t: "handback" });
    await back;
    await v.close();
  });

  it("a refused resource names the page that loaded it, the page to open once allowed", async () => {
    const fx = await startFixtureServer({
      "/page": '<!doctype html><title>P</title><script src="https://blocked.test/a.js"></script>',
    });
    try {
      const v = await openViewer(d.socketPath, { maxWidth: 480, maxHeight: 300 });
      // the daemon is shared by this file: a late note of an earlier test's blocked host may
      // still arrive, so wait for the one this page caused
      const blocked = v.after((m) => m.t === "blocked" && m.url.startsWith(fx.url));
      await request(d.socketPath, { op: "navigate", url: `${fx.url}/page` });
      expect(await blocked).toEqual({ t: "blocked", host: "blocked.test", url: `${fx.url}/page` });
      await v.close();
    } finally {
      await fx.close();
    }
  });

  it("a plain http navigation the proxy refuses is reported too", async () => {
    const r = await request(d.socketPath, { op: "navigate", url: "http://blocked.test/x" });
    expect(r).toMatchObject({ ok: false, error: "blocked", blockedHosts: ["blocked.test"] });
  });
});
