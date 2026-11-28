import { createServer, request as httpRequest, type Server } from "node:http";
import { connect } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CONV,
  conv,
  holdingPorts,
  openViewer,
  removeDir,
  request,
  startFixtureServer,
  startTestDaemon,
  type TestDaemon,
} from "./helpers.js";

/**
 * An egress proxy like the device's: refuses blocked.test (403), refuses private.test as the
 * device's sandbox proxy refuses a name resolving to a private address (its reason in the 403
 * status phrase), tunnels or forwards everything else.
 */
async function startRefusingProxy(): Promise<{ url: string; server: Server }> {
  const refused = (host: string) => host.split(":")[0] === "blocked.test";
  const privateName = (host: string) => host.split(":")[0] === "private.test";
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "");
    if (refused(url.host)) {
      res.writeHead(403, { "content-type": "text/plain", connection: "close" });
      res.end(`Outbound access to ${url.hostname} is blocked by the sandbox egress allowlist.\n`);
      return;
    }
    // the fixture pages (loopback, which goes through the proxy as on a device)
    const up = httpRequest(
      { host: url.hostname, port: url.port, path: url.pathname + url.search, headers: req.headers },
      (r) => {
        res.writeHead(r.statusCode ?? 502, r.headers);
        r.pipe(res);
      },
    );
    up.on("error", () => res.writeHead(502).end());
    req.pipe(up);
  });
  server.on("connect", (req, sock) => {
    const target = req.url ?? "";
    if (privateName(target)) {
      sock.end(
        "HTTP/1.1 403 resolved to a private address\r\nContent-Type: text/plain\r\n" +
          "X-Proxy-Error: blocked-by-sandbox-runtime\r\nConnection: close\r\n\r\n" +
          "Connection to private.test blocked: resolved to a private address",
      );
      return;
    }
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
    expect(r).toMatchObject({
      ok: false,
      error: "blocked",
      blockedHosts: [{ host: "blocked.test", layer: "device" }],
    });
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
      await request(
        d.socketPath,
        { op: "navigate", url: `${fx.url}/page` },
        holdingPorts(CONV, fx.url),
      );
      expect(await blocked).toEqual({ t: "blocked", host: "blocked.test", url: `${fx.url}/page` });
      await v.close();
    } finally {
      await fx.close();
    }
  });

  it("a refused host and a dialog reach only the page owner's reply and its tree's viewers", async () => {
    const fx = await startFixtureServer({
      "/refusing": `<!doctype html><title>R</title>
<script src="https://blocked.test/owned.js"></script>
<script>setTimeout(() => alert("late from a"), 200)</script>`,
      "/plain": "<!doctype html><title>Plain</title>",
    });
    try {
      const A = conv("own-a");
      const B = conv("own-b");
      await request(
        d.socketPath,
        { op: "navigate", url: `${fx.url}/plain` },
        holdingPorts(B, fx.url),
      );
      const va = await openViewer(d.socketPath, { maxWidth: 320, maxHeight: 200 }, A);
      const vb = await openViewer(d.socketPath, { maxWidth: 320, maxHeight: 200 }, B);
      await va.next((m) => m.t === "state");
      await vb.next((m) => m.t === "state");
      const blocked = va.after((m) => m.t === "blocked" && m.url.startsWith(fx.url));
      const dialog = va.after((m) => m.t === "dialog");
      // B browses at the same time as A's page is refused
      const [a, b] = await Promise.all([
        request(
          d.socketPath,
          { op: "navigate", url: `${fx.url}/refusing` },
          holdingPorts(A, fx.url),
        ),
        request(d.socketPath, { op: "navigate", url: `${fx.url}/plain?again` }, B),
      ]);
      expect(a).toMatchObject({
        ok: true,
        blockedHosts: [{ host: "blocked.test", layer: "device" }],
      });
      expect(b).toMatchObject({ ok: true, blockedHosts: [] });
      await blocked;
      expect(await dialog).toMatchObject({ kind: "alert", message: "late from a" });
      // anything sent to B's viewer before this state would have arrived first
      const marker = vb.after((m) => m.t === "state");
      const b2 = await request(d.socketPath, { op: "snapshot" }, B);
      await marker;
      expect(b2.ok && (b2.text ?? "")).not.toContain("late from a");
      expect(b2.blockedHosts).toEqual([]);
      expect(vb.messages.some((m) => m.t === "blocked" || m.t === "dialog")).toBe(false);
      // A's note rides A's navigate reply or, if the alert came after it, A's next reply
      const a2 = await request(d.socketPath, { op: "snapshot" }, A);
      expect(`${a.ok ? a.text : ""}\n${a2.ok ? a2.text : ""}`).toContain("late from a");
      await va.close();
      await vb.close();
    } finally {
      await fx.close();
    }
  });

  it("a host refused for its private address is reported as the address layer, not offered to viewers", async () => {
    const v = await openViewer(d.socketPath, { maxWidth: 480, maxHeight: 300 });
    await v.next((m) => m.t === "state");
    const r = await request(d.socketPath, { op: "navigate", url: "https://private.test/page" });
    expect(r).toMatchObject({
      ok: false,
      error: "blocked",
      message:
        "private.test resolves to a private or local address on the device, which the browser never reaches from the sandbox.",
      blockedHosts: [{ host: "private.test", layer: "address" }],
    });
    // allowing the name on the device would change nothing: the viewers are not offered it
    const marker = v.after((m) => m.t === "state");
    await request(d.socketPath, { op: "snapshot" });
    await marker;
    expect(v.messages.some((m) => m.t === "blocked" && m.host === "private.test")).toBe(false);
    await v.close();
  });

  it("a plain http navigation the proxy refuses is reported too", async () => {
    const r = await request(d.socketPath, { op: "navigate", url: "http://blocked.test/x" });
    expect(r).toMatchObject({
      ok: false,
      error: "blocked",
      blockedHosts: [{ host: "blocked.test", layer: "device" }],
    });
  });
});
