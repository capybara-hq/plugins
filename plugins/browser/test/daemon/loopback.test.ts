import { createServer, request as httpRequest, type Server } from "node:http";
import { connect } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { canonicalHost, loopbackGrantHostOf } from "../../daemon/loopback.js";
import type { RequestConversation } from "../../daemon/protocol.js";
import {
  conv,
  openViewer,
  removeDir,
  request,
  startFixtureServer,
  startTestDaemon,
  type TestDaemon,
} from "./helpers.js";

/**
 * An egress proxy like a device's sandbox proxy, with credentials (as on a device, so Playwright
 * proxies loopback too): forwards a loopback port in `open` (the ports the device applied),
 * refuses every other loopback port as the device's proxy does ("address is loopback" for a
 * CONNECT, a 403 for a plain request), matching hosts after canonicalization as the device's proxy
 * does (`localhost.` is localhost), sends a plain request for a host in `sites` to that local port
 * (a page that is not on loopback), forwards everything else.
 */
async function startLoopbackProxy(
  open: Set<number>,
  sites: Map<string, number> = new Map(),
): Promise<{ url: string; server: Server }> {
  const closed = (host: string, port: number) =>
    loopbackGrantHostOf(host) !== undefined && !open.has(port);
  const server = createServer((req, res) => {
    if (req.headers["proxy-authorization"] === undefined) {
      res.writeHead(407, { "proxy-authenticate": 'Basic realm="t"' }).end();
      return;
    }
    const url = new URL(req.url ?? "");
    if (closed(url.hostname, Number(url.port || 80))) {
      res.writeHead(403, "address is loopback", { connection: "close" }).end();
      return;
    }
    const site = sites.get(url.hostname);
    const up = httpRequest(
      {
        host: site === undefined ? url.hostname : "127.0.0.1",
        port: site ?? url.port,
        path: url.pathname + url.search,
        headers: req.headers,
      },
      (r) => {
        res.writeHead(r.statusCode ?? 502, r.headers);
        r.pipe(res);
      },
    );
    up.on("error", () => res.writeHead(502).end());
    req.pipe(up);
  });
  server.on("connect", (req, sock) => {
    if (req.headers["proxy-authorization"] === undefined) {
      sock.end(
        'HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="t"\r\n\r\n',
      );
      return;
    }
    const target = req.url ?? "";
    const at = target.lastIndexOf(":");
    const host = target.slice(0, at);
    const port = Number(target.slice(at + 1));
    if (closed(host, port)) {
      sock.end("HTTP/1.1 403 address is loopback\r\nConnection: close\r\n\r\n");
      return;
    }
    const up = connect(port, host.replace(/^\[|\]$/g, ""), () =>
      sock.write("HTTP/1.1 200 OK\r\n\r\n"),
    );
    up.pipe(sock).pipe(up);
    up.on("error", () => sock.destroy());
    sock.on("error", () => up.destroy());
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  if (addr === null || typeof addr === "string") throw new Error("no address");
  return { url: `http://user:secret@127.0.0.1:${addr.port}`, server };
}

const portOf = (url: string) => Number(new URL(url).port);
const holding = (of: RequestConversation, ports: number[]): RequestConversation => ({
  ...of,
  loopbackPorts: ports,
});

const open = new Set<number>();
let proxy: Awaited<ReturnType<typeof startLoopbackProxy>>;
let app: Awaited<ReturnType<typeof startFixtureServer>>;
let other: Awaited<ReturnType<typeof startFixtureServer>>;
let third: Awaited<ReturnType<typeof startFixtureServer>>;
let site: Awaited<ReturnType<typeof startFixtureServer>>;
const sites = new Map<string, number>();
let d: TestDaemon;

beforeAll(async () => {
  app = await startFixtureServer({ "/": "<!doctype html><title>App</title><p>local app</p>" });
  other = await startFixtureServer({ "/a.js": "1" });
  third = await startFixtureServer({ "/b.js": "2" });
  open.add(portOf(app.url));
  site = await startFixtureServer({
    "/": `<!doctype html><title>Site</title><script src="${other.url}/a.js"></script>`,
  });
  sites.set("site.test", portOf(site.url));
  proxy = await startLoopbackProxy(open, sites);
  d = await startTestDaemon({ env: { HTTPS_PROXY: proxy.url, HTTP_PROXY: proxy.url } });
});

afterAll(async () => {
  await d?.stop();
  proxy?.server.closeAllConnections();
  proxy?.server.close();
  await app?.close();
  await other?.close();
  await third?.close();
  await site?.close();
  if (d) removeDir(d.stateDir);
});

describe("browser daemon loopback ports", () => {
  it("reports the port and the loopback class", async () => {
    // the root holds the port, the device has not applied it yet: the proxy refuses it
    const A = conv("lb-proxy");
    const port = portOf(other.url);
    const r = await request(
      d.socketPath,
      { op: "navigate", url: `${other.url}/a.js` },
      holding(A, [port]),
    );
    expect(r).toMatchObject({
      ok: false,
      error: "blocked",
      blockedHosts: [{ host: "127.0.0.1", port, layer: "address", class: "loopback" }],
    });
    expect(r.ok ? "" : r.message).toBe(
      `127.0.0.1:${port} is a local port on the device, which the browser reaches only after the port is approved for this conversation.`,
    );
  });

  it("keys two ports of one host apart", async () => {
    const page = await startFixtureServer({
      "/": `<!doctype html><title>Two</title>
<script src="${other.url}/a.js"></script><script src="${third.url}/b.js"></script>`,
    });
    open.add(portOf(page.url));
    try {
      const A = conv("lb-two");
      const r = await request(
        d.socketPath,
        { op: "navigate", url: `${page.url}/` },
        holding(A, [portOf(page.url)]),
      );
      expect(r.ok).toBe(true);
      expect(r.blockedHosts).toEqual(
        expect.arrayContaining([
          { host: "127.0.0.1", port: portOf(other.url), layer: "address", class: "loopback" },
          { host: "127.0.0.1", port: portOf(third.url), layer: "address", class: "loopback" },
        ]),
      );
      expect(r.blockedHosts).toHaveLength(2);
    } finally {
      open.delete(portOf(page.url));
      await page.close();
    }
  });

  it("emits a loopback blocked event for the panel", async () => {
    const A = conv("lb-viewer");
    const v = await openViewer(d.socketPath, { maxWidth: 480, maxHeight: 300 }, A);
    await v.next((m) => m.t === "state");
    const blocked = v.after((m) => m.t === "blocked");
    await request(d.socketPath, { op: "navigate", url: `${app.url}/` }, holding(A, []));
    expect(await blocked).toEqual({
      t: "blocked",
      host: "127.0.0.1",
      url: `${app.url}/`,
      port: portOf(app.url),
      kind: "loopback",
    });
    await v.close();
  });

  it("refuses a granted port for another root's tab", async () => {
    // the device's proxy lets the port through (root A holds it); root B does not hold it
    const port = portOf(app.url);
    const A = conv("lb-a");
    const B = conv("lb-b");
    const a = await request(
      d.socketPath,
      { op: "navigate", url: `${app.url}/` },
      holding(A, [port]),
    );
    expect(a).toMatchObject({ ok: true, page: { title: "App" }, blockedHosts: [] });
    const b = await request(d.socketPath, { op: "navigate", url: `${app.url}/` }, holding(B, []));
    expect(b).toMatchObject({
      ok: false,
      error: "blocked",
      blockedHosts: [{ host: "127.0.0.1", port, layer: "address", class: "loopback" }],
    });
    // a sub-agent of A (same root) reaches it
    const sub = await request(
      d.socketPath,
      { op: "navigate", url: `${app.url}/` },
      holding(conv("lb-a-sub", "lb-a"), [port]),
    );
    expect(sub).toMatchObject({ ok: true, page: { title: "App" } });
  });

  it("follows the root's set from each request", async () => {
    const port = portOf(app.url);
    const A = conv("lb-follow");
    expect(
      await request(d.socketPath, { op: "navigate", url: `${app.url}/` }, holding(A, [port])),
    ).toMatchObject({ ok: true, page: { title: "App" } });
    // absent: the set stays as it was
    expect(
      await request(d.socketPath, { op: "navigate", url: `${app.url}/?again` }, A),
    ).toMatchObject({ ok: true, page: { title: "App" } });
    // the grant ended: the next navigation is refused
    expect(
      await request(d.socketPath, { op: "navigate", url: `${app.url}/?gone` }, holding(A, [])),
    ).toMatchObject({
      ok: false,
      error: "blocked",
      blockedHosts: [{ host: "127.0.0.1", port, layer: "address", class: "loopback" }],
    });
  });

  it("refuses a request whose set is not a set of ports", async () => {
    const r = await request(
      d.socketPath,
      { op: "snapshot" },
      { ...conv("lb-bad"), loopbackPorts: [70000] },
    );
    expect(r).toMatchObject({ ok: false, error: "failed" });
  });

  it("refuses localhost. for another root's tab as the proxy's localhost", async () => {
    const port = portOf(app.url);
    const B = conv("lb-dot-b");
    const r = await request(
      d.socketPath,
      { op: "navigate", url: `http://localhost.:${port}/` },
      holding(B, []),
    );
    expect(r).toMatchObject({
      ok: false,
      error: "blocked",
      blockedHosts: [{ host: "localhost", port, layer: "address", class: "loopback" }],
    });
    for (const host of ["LOCALHOST", "127.1", "[::ffff:127.0.0.1]"]) {
      const x = await request(
        d.socketPath,
        { op: "navigate", url: `http://${host}:${port}/` },
        holding(B, []),
      );
      expect(x, host).toMatchObject({ ok: false, error: "blocked" });
      expect(x.blockedHosts[0]).toMatchObject({ port, class: "loopback" });
    }
  });

  it("only notes a local port a page elsewhere requests, and names the page in the panel", async () => {
    const A = conv("lb-probe");
    const v = await openViewer(d.socketPath, { maxWidth: 480, maxHeight: 300 }, A);
    await v.next((m) => m.t === "state");
    const r = await request(
      d.socketPath,
      { op: "navigate", url: "http://site.test/" },
      holding(A, []),
    );
    expect(r).toMatchObject({ ok: true, page: { title: "Site" }, blockedHosts: [] });
    expect(r.ok ? r.text : "").toContain(
      `127.0.0.1:${portOf(other.url)}: local port on the device requested by the page on site.test, refused. A local port is offered for approval only when the browser navigates to it or a page on the device itself requests it.`,
    );
    // a page on the device asking for another local port is offered, naming the page's host
    const page = await startFixtureServer({
      "/": `<!doctype html><title>Local</title><script src="${third.url}/b.js"></script>`,
    });
    open.add(portOf(page.url));
    try {
      const blocked = v.after((m) => m.t === "blocked");
      await request(
        d.socketPath,
        { op: "navigate", url: `${page.url}/` },
        holding(A, [portOf(page.url)]),
      );
      expect(await blocked).toMatchObject({
        t: "blocked",
        port: portOf(third.url),
        kind: "loopback",
        origin: "127.0.0.1",
      });
      expect(v.messages.some((m) => m.t === "blocked" && m.port === portOf(other.url))).toBe(false);
    } finally {
      open.delete(portOf(page.url));
      await page.close();
      await v.close();
    }
  });

  it("applies the panel's refresh to the root the daemon knows for the conversation", async () => {
    const port = portOf(app.url);
    const sub = conv("lb-r-sub", "lb-r");
    // the daemon learns the sub-agent's root from its request
    await request(d.socketPath, { op: "snapshot" }, holding(sub, []));
    expect(
      await request(
        d.socketPath,
        { op: "loopback_ports" },
        holding(conv("lb-r-sub", "lb-r-sub"), [port]),
      ),
    ).toMatchObject({ ok: true });
    // the sub-agent's next call (no set of its own) reaches the port through its root's set
    expect(await request(d.socketPath, { op: "navigate", url: `${app.url}/` }, sub)).toMatchObject({
      ok: true,
      page: { title: "App" },
    });
  });
});

describe("loopback hosts as the device's proxy canonicalizes them", () => {
  it("maps every spelling of a loopback grant host to it, and nothing else", () => {
    expect(loopbackGrantHostOf("localhost.")).toBe("localhost");
    expect(loopbackGrantHostOf("LocalHost")).toBe("localhost");
    expect(loopbackGrantHostOf("127.1")).toBe("127.0.0.1");
    expect(loopbackGrantHostOf("[::ffff:127.0.0.1]")).toBe("127.0.0.1");
    expect(loopbackGrantHostOf("[::ffff:7f00:1]")).toBe("127.0.0.1");
    expect(loopbackGrantHostOf("[::1]")).toBe("[::1]");
    expect(loopbackGrantHostOf("::1")).toBe("[::1]");
    for (const h of ["127.0.0.2", "a.localhost", "localhost..", "example.com", "10.0.0.1"])
      expect(loopbackGrantHostOf(h), h).toBeUndefined();
    expect(canonicalHost("Example.COM.")).toBe("example.com");
  });
});

describe("browser daemon loopback ports across a restart", () => {
  it("keeps the tree's ports when the service restarts", async () => {
    const port = portOf(app.url);
    const env = { HTTPS_PROXY: proxy.url, HTTP_PROXY: proxy.url };
    const first = await startTestDaemon({ env });
    try {
      const A = conv("lb-restart");
      await request(first.socketPath, { op: "snapshot" }, holding(A, [port]));
      await first.stop();
      const second = await startTestDaemon({ env, stateDir: first.stateDir });
      try {
        expect(
          await request(second.socketPath, { op: "navigate", url: `${app.url}/` }, A),
        ).toMatchObject({ ok: true, page: { title: "App" } });
      } finally {
        await second.stop();
      }
    } finally {
      removeDir(first.stateDir);
    }
  });
});
