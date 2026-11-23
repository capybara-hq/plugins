import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import {
  type AddressInfo,
  connect,
  createServer as createNetServer,
  type Server as NetServer,
  Socket,
} from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  allowDigest,
  allowHostError,
  controlRequest,
  createControlServer,
  createEgressProxy,
  createEgressState,
  createSocksProxy,
  type EgressState,
  main,
  parseAllowConfig,
  readAllowFile,
} from "../egress-proxy/proxy.mjs";
import { egressAllowDigest } from "../src/provider.js";

/**
 * In-place list changes of the egress proxy (no Docker): the control request and its validation,
 * the swap, the connection registry (a widening keeps open tunnels; a narrowing closes CONNECT,
 * SOCKS and HTTP-forward connections to removed hosts, also those still resolving or connecting,
 * and keeps the others), the denied ranges refreshed by the same request, restart from the config
 * file, and the idempotent digest.
 */

const quiet = () => {};
const A = "a.example.com";
const B = "b.example.com";
const C = "c.example.com";

/** A long-lived upstream: answers each line it receives with `echo:<line>`, never closes on its own. */
let echo: NetServer;
let echoPort: number;
const upstreams = new Set<Socket>();
/** A plain HTTP target whose response body never ends until the client goes away. */
let slowHttp: Server;
let slowHttpPort: number;

beforeAll(async () => {
  echo = createNetServerEcho();
  await new Promise<void>((r) => echo.listen(0, "127.0.0.1", r));
  echoPort = (echo.address() as AddressInfo).port;
  slowHttp = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.write("first-chunk\n");
  });
  await new Promise<void>((r) => slowHttp.listen(0, "127.0.0.1", r));
  slowHttpPort = (slowHttp.address() as AddressInfo).port;
});
afterAll(async () => {
  for (const s of upstreams) s.destroy();
  slowHttp.closeAllConnections();
  await Promise.all([new Promise((r) => echo.close(r)), new Promise((r) => slowHttp.close(r))]);
});

function createNetServerEcho(): NetServer {
  return createNetServer((s) => {
    upstreams.add(s);
    s.on("close", () => upstreams.delete(s));
    s.on("error", () => s.destroy());
    s.setEncoding("utf8");
    let buf = "";
    s.on("data", (c: string) => {
      buf += c;
      for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
        s.write(`echo:${buf.slice(0, nl)}\n`);
        buf = buf.slice(nl + 1);
      }
    });
  });
}

const servers: (Server | NetServer)[] = [];
const accepted = new Set<Socket>();
afterEach(async () => {
  for (const s of accepted) s.destroy();
  accepted.clear();
  for (const s of servers.splice(0)) await new Promise((r) => s.close(r));
});

const listen = async <T extends Server | NetServer>(s: T): Promise<number> => {
  servers.push(s);
  s.on("connection", (c: Socket) => {
    accepted.add(c);
    c.once("close", () => accepted.delete(c));
  });
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  return (s.address() as AddressInfo).port;
};

/** The three test names, pinned to the local upstreams (pinned names skip the address checks). */
const testHosts = { [A]: "127.0.0.1", [B]: "127.0.0.1", [C]: "127.0.0.1" };

const newState = (hosts: string[], extra: { deniedCidrs?: string[]; configFile?: string } = {}) =>
  createEgressState({ mode: "allowlist", allowHosts: hosts, testHosts, log: quiet, ...extra });

const cfgOf = (hosts: string[], deniedCidrs: string[] = []) => ({
  mode: "allowlist" as const,
  hosts,
  deniedCidrs,
});

/** Starts both listeners on one state; returns their ports. */
const start = async (
  state: EgressState,
  connectFn?: Parameters<typeof createEgressProxy>[0]["connect"],
) => {
  const seams = { state, log: quiet, ...(connectFn && { connect: connectFn }) };
  const http = await listen(createEgressProxy(seams));
  const socks = await listen(createSocksProxy(seams));
  return { http, socks };
};

/** A line-oriented client on an open tunnel: `say` sends a line and waits for its echo. */
interface Tunnel {
  socket: Socket;
  say(line: string): Promise<string>;
  closed: Promise<void>;
  /** Everything received before the tunnel was up (CONNECT status line, SOCKS reply). */
  preamble: Buffer;
}

const wrap = (socket: Socket, preamble: Buffer, rest: string): Tunnel => {
  let buf = rest;
  let waiter: ((line: string) => void) | null = null;
  socket.setEncoding("utf8");
  socket.on("data", (c: string) => {
    buf += c;
    const nl = buf.indexOf("\n");
    if (nl >= 0 && waiter) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      const w = waiter;
      waiter = null;
      w(line);
    }
  });
  const closed = new Promise<void>((r) => socket.once("close", () => r()));
  return {
    socket,
    preamble,
    closed,
    say: (line) =>
      new Promise((resolve, reject) => {
        waiter = resolve;
        socket.once("close", () => reject(new Error("tunnel closed")));
        socket.write(`${line}\n`);
      }),
  };
};

/** Opens a CONNECT tunnel to `host` at the echo upstream. */
const connectTunnel = (port: number, host: string) =>
  new Promise<Tunnel>((resolve, reject) => {
    const s = connect(port, "127.0.0.1");
    let got = Buffer.alloc(0);
    const onData = (c: Buffer) => {
      got = Buffer.concat([got, c]);
      const end = got.indexOf("\r\n\r\n");
      if (end < 0) return;
      s.off("data", onData);
      const head = got.subarray(0, end + 4);
      if (!head.toString().startsWith("HTTP/1.1 200")) {
        reject(new Error(head.toString()));
        return;
      }
      resolve(wrap(s, head, got.subarray(end + 4).toString()));
    };
    s.on("data", onData);
    s.on("error", reject);
    s.on("close", () => reject(new Error("closed")));
    s.write(`CONNECT ${host}:${echoPort} HTTP/1.1\r\nHost: ${host}\r\n\r\n`);
  });

const socksRequest = (host: string, port: number) => {
  const h = Buffer.from(host, "latin1");
  const p = Buffer.alloc(2);
  p.writeUInt16BE(port);
  return Buffer.concat([Buffer.from([5, 1, 0, 3, h.length]), h, p]);
};

/** Opens a SOCKS5 tunnel to `host` at the echo upstream. */
const socksTunnel = (port: number, host: string) =>
  new Promise<Tunnel>((resolve, reject) => {
    const s = connect(port, "127.0.0.1");
    let got = Buffer.alloc(0);
    let requested = false;
    const onData = (c: Buffer) => {
      got = Buffer.concat([got, c]);
      if (!requested && got.length >= 2) {
        requested = true;
        got = got.subarray(2);
        s.write(socksRequest(host, echoPort));
      }
      if (requested && got.length >= 10) {
        s.off("data", onData);
        if (got[1] !== 0) {
          reject(new Error(`SOCKS reply ${got[1]}`));
          return;
        }
        resolve(wrap(s, got.subarray(0, 10), got.subarray(10).toString()));
      }
    };
    s.on("data", onData);
    s.on("error", reject);
    s.on("close", () => reject(new Error("closed")));
    s.write(Buffer.from([5, 1, 0]));
  });

/** Sends an absolute-URL GET to `host` at the slow HTTP target; resolves once the first chunk arrived. */
const httpForward = (port: number, host: string) =>
  new Promise<{ socket: Socket; head: string; closed: Promise<void> }>((resolve, reject) => {
    const s = connect(port, "127.0.0.1");
    let got = "";
    const closed = new Promise<void>((r) => s.once("close", () => r()));
    s.setEncoding("utf8");
    s.on("data", (c: string) => {
      got += c;
      if (got.includes("first-chunk") || got.startsWith("HTTP/1.1 4")) {
        resolve({ socket: s, head: got, closed });
      }
    });
    s.on("error", reject);
    s.write(`GET http://${host}:${slowHttpPort}/ HTTP/1.1\r\nHost: ${host}\r\n\r\n`);
  });

describe("control request validation", () => {
  it("accepts an allowlist of valid hosts and denied CIDRs", () => {
    expect(parseAllowConfig(cfgOf([A, "*.example.org"], ["203.0.113.0/24"]))).toEqual(
      cfgOf([A, "*.example.org"], ["203.0.113.0/24"]),
    );
    expect(parseAllowConfig({ mode: "allowlist", hosts: [A] })).toEqual(cfgOf([A]));
  });

  it("refuses the whole list on one bad entry, another mode or an empty list", () => {
    for (const bad of [
      null,
      [],
      "x",
      { mode: "open-public", hosts: [A] },
      { mode: "allowlist", hosts: [] },
      { mode: "allowlist" },
      cfgOf([A, "10.0.0.1"]),
      cfgOf([A, "localhost"]),
      cfgOf([A, "printer.local"]),
      cfgOf([A, "Upper.Example.com"]),
      cfgOf([A, "*."]),
      cfgOf([A, "a.example.com/x"]),
      cfgOf([A, 7 as unknown as string]),
      cfgOf([A], ["not-a-cidr"]),
    ]) {
      expect(() => parseAllowConfig(bad), JSON.stringify(bad)).toThrow();
    }
  });

  it("host rules follow validateAllowHost", () => {
    expect(allowHostError("registry.npmjs.org")).toBeNull();
    expect(allowHostError("*.example.com")).toBeNull();
    expect(allowHostError("example")).toMatch(/single-label/);
    expect(allowHostError("1.2.3.4")).not.toBeNull();
    expect(allowHostError("x.internal")).toMatch(/internal-only/);
  });

  it("the provider computes the same digest as the proxy (order and duplicates do not count)", () => {
    const one = cfgOf([B, A, A], ["203.0.113.0/24", "2001:db8::/32"]);
    const two = cfgOf([A, B], ["2001:db8::/32", "203.0.113.0/24"]);
    expect(allowDigest(one)).toBe(allowDigest(two));
    expect(egressAllowDigest(one)).toBe(allowDigest(one));
    expect(allowDigest(cfgOf([A]))).not.toBe(allowDigest(cfgOf([A, B])));
    expect(allowDigest(cfgOf([A]))).not.toBe(allowDigest(cfgOf([A], ["203.0.113.0/24"])));
  });
});

describe("apply", () => {
  it("swaps the list: a removed host is refused, an added one reachable; idempotent by digest", async () => {
    const state = newState([A]);
    const { http } = await start(state);
    await expect(connectTunnel(http, B)).rejects.toThrow(/403/);
    const digest = await state.apply(cfgOf([A, B]));
    expect(digest).toBe(allowDigest(cfgOf([A, B])));
    expect(state.policy.digest).toBe(digest);
    const t = await connectTunnel(http, B);
    expect(await t.say("hi")).toBe("echo:hi");
    t.socket.destroy();
    // the same list again answers at once with the same digest and closes nothing
    const open = await connectTunnel(http, A);
    expect(await state.apply(cfgOf([B, A]))).toBe(digest);
    expect(await open.say("still")).toBe("echo:still");
    open.socket.destroy();
    await state.apply(cfgOf([B]));
    await expect(connectTunnel(http, A)).rejects.toThrow(/403/);
  });

  it("compare and swap: an apply that read an older list is refused, the current one applies", async () => {
    const state = newState([A, B]);
    const read = state.policy.digest;
    // another caller narrows first
    await state.apply(cfgOf([A]), read);
    // the stale caller's wider list never lands after it
    await expect(state.apply(cfgOf([A, B]), read)).rejects.toThrow(/changed since it was read/);
    expect(state.policy.allowHosts).toEqual([A]);
    // the list already in force is acknowledged whatever was read
    expect(await state.apply(cfgOf([A]), read)).toBe(state.policy.digest);
    expect(await state.apply(cfgOf([A, C]), state.policy.digest)).toBe(allowDigest(cfgOf([A, C])));
  });

  it("a refused request leaves the list in force", async () => {
    const state = newState([A]);
    const before = state.policy;
    await expect(state.apply(cfgOf([A, "10.0.0.1"]))).rejects.toThrow(/Invalid allowlist host/);
    await expect(state.apply({ mode: "allowlist", hosts: [] })).rejects.toThrow(/at least one/);
    expect(state.policy).toBe(before);
  });

  it("an open-public proxy takes no list in place", async () => {
    const state = createEgressState({ mode: "open-public", log: quiet });
    await expect(state.apply(cfgOf([A]))).rejects.toThrow(/open-public/);
    expect(state.policy.mode).toBe("open-public");
  });

  it("a widening keeps every open tunnel (CONNECT, SOCKS, HTTP forward)", async () => {
    const state = newState([A]);
    const { http, socks } = await start(state);
    const c = await connectTunnel(http, A);
    const s = await socksTunnel(socks, A);
    const f = await httpForward(http, A);
    expect(f.head).toMatch(/^HTTP\/1\.1 200/);
    await state.apply(cfgOf([A, B]));
    expect(await c.say("one")).toBe("echo:one");
    expect(await s.say("two")).toBe("echo:two");
    expect(f.socket.destroyed).toBe(false);
    for (const t of [c.socket, s.socket, f.socket]) t.destroy();
  });

  it("a narrowing closes CONNECT, SOCKS and HTTP-forward connections to removed hosts and keeps the others", async () => {
    const state = newState([A, B, "*.wild.example.com"]);
    const { http, socks } = await start(state);
    const gone = [
      await connectTunnel(http, B),
      await socksTunnel(socks, B),
      await connectTunnel(http, "x.wild.example.com").catch(() => null),
    ];
    const forwardGone = await httpForward(http, B);
    const kept = [await connectTunnel(http, A), await socksTunnel(socks, A)];
    const forwardKept = await httpForward(http, A);
    expect(state.connections).toBeGreaterThanOrEqual(6);

    await state.apply(cfgOf([A]));
    // closed before apply resolved: the closes were issued synchronously with the swap
    for (const t of gone) if (t) await t.closed;
    await forwardGone.closed;
    expect(await kept[0]?.say("a")).toBe("echo:a");
    expect(await kept[1]?.say("b")).toBe("echo:b");
    expect(forwardKept.socket.destroyed).toBe(false);
    // and no new connection to a removed host opens
    await expect(connectTunnel(http, B)).rejects.toThrow(/403/);
    await expect(socksTunnel(socks, B)).rejects.toThrow(/SOCKS reply 2/);
    for (const t of [...kept.map((k) => k?.socket), forwardKept.socket]) t?.destroy();
  });

  it("wildcards are judged by hostAllowed, not by equality with the old entries", async () => {
    const state = newState(["*.example.com"]);
    const { http } = await start(state);
    const t = await connectTunnel(http, A);
    // a list that still covers a.example.com through another entry keeps the tunnel
    await state.apply(cfgOf([A, "z.example.org"]));
    expect(await t.say("x")).toBe("echo:x");
    await state.apply(cfgOf(["z.example.org"]));
    await t.closed;
    expect(t.socket.destroyed).toBe(true);
  });

  it("drops a connection still connecting to a removed host when the narrowing lands", async () => {
    // the transport holds every dial until released
    const held: (() => void)[] = [];
    const dials: Socket[] = [];
    const slowConnect = (o: { host: string; port: number; allowHalfOpen: boolean }) => {
      const s = new Socket({ allowHalfOpen: o.allowHalfOpen });
      dials.push(s);
      held.push(() => s.connect(o.port, o.host));
      return s;
    };
    const state = newState([A, B]);
    const { http, socks } = await start(state, slowConnect);
    const results = [B, A].map((h) =>
      connectTunnel(http, h).then(
        (t) => ({ ok: true as const, t }),
        (e: Error) => ({ ok: false as const, e }),
      ),
    );
    const socksB = socksTunnel(socks, B).then(
      () => "open",
      (e: Error) => e.message,
    );
    await expect.poll(() => held.length).toBe(3);
    await state.apply(cfgOf([A]));
    // the clients of B are closed at once, before their dials complete
    for (const f of held.splice(0)) f();
    const [b, a] = await Promise.all(results);
    expect(b?.ok).toBe(false);
    expect(await socksB).not.toBe("open");
    expect(a?.ok).toBe(true);
    if (a?.ok) {
      expect(await a.t.say("ok")).toBe("echo:ok");
      a.t.socket.destroy();
    }
    // the upstream dials of B were dropped once they connected
    await expect.poll(() => dials.filter((d) => !d.destroyed).length).toBeLessThanOrEqual(1);
  });

  it("drops a connection still resolving a removed host when the narrowing lands (never dialled)", async () => {
    let release: ((v: { address: string }[]) => void) | undefined;
    const lookup = (_h: string) =>
      new Promise<{ address: string }[]>((r) => {
        release = r;
      });
    let dialled = 0;
    const state = createEgressState({
      mode: "allowlist",
      allowHosts: ["slow.example.com", A],
      testHosts,
      log: quiet,
    });
    const http = await listen(
      createEgressProxy({
        state,
        lookup,
        log: quiet,
        connect: (o) => {
          dialled++;
          return connect(o.port, o.host);
        },
      }),
    );
    const pending = connectTunnel(http, "slow.example.com").then(
      () => "open",
      () => "closed",
    );
    await expect.poll(() => release !== undefined).toBe(true);
    expect(state.connections).toBe(1);
    await state.apply(cfgOf([A]));
    expect(await pending).toBe("closed");
    release?.([{ address: "8.8.8.8" }]);
    await expect.poll(() => state.connections).toBe(0);
    expect(dialled).toBe(0);
  });

  it("refreshes the denied ranges: an open connection into a newly denied range closes", async () => {
    const state = createEgressState({ mode: "allowlist", allowHosts: [A], log: quiet });
    // not through a listener: a resolved public address is recorded by keep()
    const client = new EventEmitter() as unknown as Socket & EventEmitter;
    let destroyed = 0;
    (client as unknown as { destroy(): void }).destroy = () => {
      destroyed++;
    };
    const up = Object.assign(new EventEmitter(), {
      remoteAddress: "::ffff:203.0.114.9",
      destroy: () => {
        destroyed++;
      },
    }) as unknown as Socket;
    const entry = state.admit(A, client);
    expect(state.keep(entry, up)).toBe(true);
    await state.apply(cfgOf([A], ["203.0.114.0/24"]));
    expect(destroyed).toBe(2);
    expect(state.connections).toBe(0);
    // and one still connecting when the ranges change is refused once it connects
    const late = state.admit(A, client);
    await state.apply(cfgOf([A, B], ["203.0.114.0/24"]));
    expect(state.keep(late, up)).toBe(false);
  });
});

describe("config file and control socket", () => {
  const dir = () => mkdtempSync(join(tmpdir(), "egress-control-"));

  it("apply writes the config file; restart reads it over the environment and adds the env's denied ranges", async () => {
    const d = dir();
    const configFile = join(d, "allow.json");
    const state = newState([A, B], { configFile });
    const digest = await state.apply(cfgOf([A], ["203.0.113.0/24"]));
    expect(JSON.parse(readFileSync(configFile, "utf8"))).toEqual({
      ...cfgOf([A], ["203.0.113.0/24"]),
      digest,
    });
    expect(readAllowFile(configFile)).toEqual(cfgOf([A], ["203.0.113.0/24"]));

    const started = main({
      MODE: "allowlist",
      // the create-time list, wider than the one applied: the file wins
      ALLOW_HOSTS: JSON.stringify([A, B]),
      DENIED_CIDRS: '["198.51.100.0/24"]',
      PORT: "0",
      SOCKS_PORT: "0",
      CONFIG_FILE: configFile,
      CONTROL_SOCKET: join(d, "control.sock"),
    });
    try {
      expect(started.state.policy.allowHosts).toEqual([A]);
      expect([...started.state.policy.deniedCidrs].sort()).toEqual([
        "198.51.100.0/24",
        "203.0.113.0/24",
      ]);
    } finally {
      started.control.close();
      started.socks.close();
      started.http.close();
    }
  });

  it("without a usable control location the proxy still serves (no in-place changes)", async () => {
    const d = dir();
    const started = main({
      MODE: "allowlist",
      ALLOW_HOSTS: JSON.stringify([A]),
      PORT: "0",
      SOCKS_PORT: "0",
      CONFIG_FILE: join(d, "allow.json"),
      CONTROL_SOCKET: join(d, "missing-dir", "control.sock"),
    });
    try {
      if (!started.http.listening) await new Promise((r) => started.http.once("listening", r));
      expect(started.http.listening).toBe(true);
    } finally {
      started.socks.close();
      started.http.close();
    }
  });

  it("an unreadable or invalid config file stops the proxy instead of falling back to the environment", () => {
    const d = dir();
    const configFile = join(d, "allow.json");
    writeFileSync(configFile, '{"mode":"allowlist","hosts":["10.0.0.1"]}');
    const env = {
      MODE: "allowlist",
      ALLOW_HOSTS: JSON.stringify([A, B]),
      PORT: "0",
      SOCKS_PORT: "0",
      CONFIG_FILE: configFile,
      CONTROL_SOCKET: join(d, "control.sock"),
    };
    expect(() => main(env)).toThrow(/is invalid/);
    writeFileSync(configFile, "{");
    expect(() => main(env)).toThrow(/is invalid/);
    expect(readAllowFile(join(d, "missing.json"))).toBeNull();
  });

  it("the control socket applies and reports; errors come back as ok:false", async () => {
    const d = dir();
    const path = join(d, "control.sock");
    const state = newState([A], { configFile: join(d, "allow.json") });
    const control = createControlServer(state);
    servers.push(control);
    await new Promise<void>((r) => control.listen(path, r));
    const applied = await controlRequest(path, { op: "apply", config: cfgOf([A, B]) });
    expect(applied).toEqual({ ok: true, digest: allowDigest(cfgOf([A, B])) });
    expect(await controlRequest(path, { op: "status" })).toEqual({
      ok: true,
      mode: "allowlist",
      hosts: [A, B],
      digest: allowDigest(cfgOf([A, B])),
      connections: 0,
    });
    const bad = await controlRequest(path, { op: "apply", config: cfgOf(["bad host"]) });
    expect(bad.ok).toBe(false);
    expect(String(bad.error)).toMatch(/Invalid allowlist host/);
    expect((await controlRequest(path, { op: "drop" })).ok).toBe(false);
    expect(state.policy.allowHosts).toEqual([A, B]);
  });

  it("main listens on the control socket with mode 0600 before the proxy ports", async () => {
    const d = dir();
    const controlPath = join(d, "control.sock");
    const started = main({
      MODE: "allowlist",
      ALLOW_HOSTS: JSON.stringify([A]),
      PORT: "0",
      SOCKS_PORT: "0",
      CONFIG_FILE: join(d, "allow.json"),
      CONTROL_SOCKET: controlPath,
    });
    try {
      if (!started.http.listening) await new Promise((r) => started.http.once("listening", r));
      const { statSync } = await import("node:fs");
      expect(statSync(controlPath).mode & 0o777).toBe(0o600);
      const r = await controlRequest(controlPath, { op: "apply", config: cfgOf([A, C]) });
      expect(r.ok).toBe(true);
      expect(JSON.parse(readFileSync(join(d, "allow.json"), "utf8")).hosts).toEqual([A, C]);
    } finally {
      started.control.close();
      started.socks.close();
      started.http.close();
    }
  });
});
