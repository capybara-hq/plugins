import { createServer, request as httpRequest, type Server } from "node:http";
import { connect, createServer as createTcpServer, type Server as TcpServer } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CONV,
  holdingPorts,
  removeDir,
  request,
  startFixtureServer,
  startTestDaemon,
  type TestDaemon,
} from "./helpers.js";

const NAV_TIMEOUT_MS = 3_000;

/**
 * An egress proxy like the device's, with credentials (so Playwright answers its challenge, as on
 * a device): tunnels `hang.test` and its subdomains to a listener that accepts and never answers
 * (resolving the waiters of {@link nextConnect} for that host), answers 502 for
 * `down.test` (the proxy could not connect) and forwards everything else.
 */
async function startProxy(hangPort: number): Promise<{ url: string; server: Server }> {
  const server = createServer((req, res) => {
    if (req.headers["proxy-authorization"] === undefined) {
      res.writeHead(407, { "proxy-authenticate": 'Basic realm="t"' }).end();
      return;
    }
    const url = new URL(req.url ?? "");
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
    if (req.headers["proxy-authorization"] === undefined) {
      sock.end(
        'HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="t"\r\n\r\n',
      );
      return;
    }
    const [host, port] = (req.url ?? "").split(":");
    if (host === "down.test") {
      sock.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
      return;
    }
    for (const w of connectWaiters.get(host ?? "")?.splice(0) ?? []) w();
    const target =
      host === "hang.test" || host?.endsWith(".hang.test") === true
        ? { port: hangPort, host: "127.0.0.1" }
        : { port: Number(port), host: host ?? "" };
    const up = connect(target.port, target.host, () => sock.write("HTTP/1.1 200 OK\r\n\r\n"));
    up.pipe(sock).pipe(up);
    up.on("error", () => sock.destroy());
    sock.on("error", () => up.destroy());
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  if (addr === null || typeof addr === "string") throw new Error("no address");
  return { url: `http://user:secret@127.0.0.1:${addr.port}`, server };
}

let hang: TcpServer;
/**
 * Resolved at the proxy's next CONNECT to `host` (a navigation to it in flight). Keyed by host:
 * a connection the browser still holds for another test's host never resolves it.
 */
const connectWaiters = new Map<string, (() => void)[]>();
const nextConnect = (host: string) =>
  new Promise<void>((r) => connectWaiters.set(host, [...(connectWaiters.get(host) ?? []), r]));
let proxy: Awaited<ReturnType<typeof startProxy>>;
let fx: Awaited<ReturnType<typeof startFixtureServer>>;
let d: TestDaemon;

beforeAll(async () => {
  // accepts every connection and never answers (a TLS handshake that never completes)
  hang = createTcpServer(() => undefined);
  await new Promise<void>((r) => hang.listen(0, "127.0.0.1", r));
  const addr = hang.address();
  if (addr === null || typeof addr === "string") throw new Error("no address");
  proxy = await startProxy(addr.port);
  fx = await startFixtureServer({
    "/page": "<!doctype html><title>Before</title><p>before</p>",
    "/empty": (_req, res) => void res.writeHead(204).end(),
  });
  d = await startTestDaemon({
    env: { HTTPS_PROXY: proxy.url, HTTP_PROXY: proxy.url },
    navigationTimeoutMs: NAV_TIMEOUT_MS,
  });
});

afterAll(async () => {
  await d?.stop();
  proxy?.server.closeAllConnections();
  proxy?.server.close();
  hang?.close();
  await fx?.close();
  if (d) removeDir(d.stateDir);
});

describe("browser daemon unreachable pages", () => {
  it("a navigation that gets no answer is stopped at its timeout, and the next requests answer", async () => {
    expect(
      await request(
        d.socketPath,
        { op: "navigate", url: `${fx.url}/page` },
        holdingPorts(CONV, fx.url),
      ),
    ).toMatchObject({
      ok: true,
      page: { title: "Before" },
    });
    const r = await request(d.socketPath, { op: "navigate", url: "https://hang.test/" });
    expect(r).toMatchObject({ ok: false, error: "unreachable" });
    // the tab shows the page before, or the error page of an attempt a network change dropped
    // (Linux runners change interfaces while containers start; the navigation then runs again)
    const shown = new RegExp(
      `^https://hang\\.test/ did not load within 3 s: hang\\.test accepted the connection through the device's network but sent no page in that time\\. The navigation was stopped; the tab shows (${fx.url.replace(/[.]/g, "\\.")}/page|chrome-error://chromewebdata/)\\.$`,
    );
    expect(r.ok ? "" : r.message).toMatch(shown);
    // the navigation no longer holds the page: a snapshot and the tab list answer at once
    const started = Date.now();
    const snap = await request(d.socketPath, { op: "snapshot" });
    expect(snap).toMatchObject({ ok: true });
    if (snap.ok && snap.page?.url === `${fx.url}/page`) expect(snap.text).toContain("before");
    const tabs = await request(d.socketPath, { op: "tabs", action: "list" });
    expect(tabs).toMatchObject({ ok: true });
    expect(Date.now() - started).toBeLessThan(NAV_TIMEOUT_MS);
  });

  it("the tab list answers while a navigation is still in flight", async () => {
    // a host of its own: the browser may still hold the earlier test's connection to hang.test
    const inFlight = nextConnect("inflight.hang.test");
    const order: string[] = [];
    const nav = request(d.socketPath, { op: "navigate", url: "https://inflight.hang.test/" }).then(
      (r) => {
        order.push("navigate");
        return r;
      },
    );
    // the navigation reached the listener that never answers: it runs until its timeout
    await inFlight;
    const tabs = await request(d.socketPath, { op: "tabs", action: "list" });
    order.push("tabs");
    expect(tabs).toMatchObject({ ok: true });
    expect(await nav).toMatchObject({ ok: false, error: "unreachable" });
    expect(order).toEqual(["tabs", "navigate"]);
  });

  it("a host the device's network cannot connect to fails at once, naming it", async () => {
    const started = Date.now();
    const r = await request(d.socketPath, { op: "navigate", url: "https://down.test/x" });
    expect(r).toMatchObject({ ok: false, error: "unreachable", blockedHosts: [] });
    expect(r.ok ? "" : r.message).toBe(
      "https://down.test/x could not be loaded (net::ERR_TUNNEL_CONNECTION_FAILED): the device's network could not connect to down.test:443 (the name did not resolve, or the host refused or did not answer the connection).",
    );
    expect(Date.now() - started).toBeLessThan(NAV_TIMEOUT_MS);
  });

  it("a page answered with 204 says so at once instead of an abort", async () => {
    // right after the failed navigation of the test before: on the Linux build its error page
    // commits late and must not interrupt this navigation
    const before = await request(
      d.socketPath,
      { op: "navigate", url: `${fx.url}/page` },
      holdingPorts(CONV, fx.url),
    );
    expect(before.ok ? "ok" : before.message).toBe("ok");
    const r = await request(d.socketPath, { op: "navigate", url: `${fx.url}/empty` });
    expect(r).toMatchObject({ ok: false, error: "failed" });
    expect(r.ok ? "" : r.message).toBe(
      `${fx.url}/empty answered 204 with no page to show; the tab shows ${fx.url}/page.`,
    );
  });
});

describe("browser daemon with the device's proxy down", () => {
  let down: TestDaemon;
  let closedPort: number;

  beforeAll(async () => {
    // a port nobody listens on: the device's network proxy is not up
    const probe = createTcpServer();
    await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
    const addr = probe.address();
    if (addr === null || typeof addr === "string") throw new Error("no address");
    closedPort = addr.port;
    await new Promise<void>((r) => probe.close(() => r()));
    const url = `http://user:secret@127.0.0.1:${closedPort}`;
    down = await startTestDaemon({
      env: { HTTPS_PROXY: url, HTTP_PROXY: url },
      navigationTimeoutMs: NAV_TIMEOUT_MS,
    });
  });

  afterAll(async () => {
    await down?.stop();
    if (down) removeDir(down.stateDir);
  });

  it("says the device's network proxy is not reachable, not that the address is wrong", async () => {
    const r = await request(down.socketPath, { op: "navigate", url: "https://example.test/" });
    expect(r).toMatchObject({ ok: false, error: "network_unavailable", blockedHosts: [] });
    expect(r.ok ? "" : r.message).toBe(
      "https://example.test/ could not be loaded (net::ERR_PROXY_CONNECTION_FAILED): the device's network proxy is not reachable, so no page loads on the device right now; this is not a problem of the address.",
    );
  });
});
