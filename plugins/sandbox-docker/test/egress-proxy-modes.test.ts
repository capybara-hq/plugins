import { spawn, spawnSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { type AddressInfo, connect, type Server as NetServer } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  connectAny,
  createEgressProxy,
  createSocksProxy,
  isForbiddenAddress,
  main,
  resolveTarget,
} from "../egress-proxy/proxy.mjs";

/** Egress proxy modes (no Docker): dev / open any-port CONNECT, SOCKS5 / SOCKS4a, strict without SOCKS. */

// Fake DNS: rebind.example.com -> 10.0.0.1 (DNS rebinding), public.example.com -> a public address.
const lookup = async (h: string) => {
  if (h === "rebind.example.com" || h === "rebind.open.org") return [{ address: "10.0.0.1" }];
  if (h === "meta.open.org") return [{ address: "169.254.169.254" }];
  if (h === "public.example.com" || h === "public.open.org") return [{ address: "8.8.8.8" }];
  throw new Error("ENOTFOUND");
};
const quiet = () => {};

let target: Server;
let targetPort: number;

beforeAll(async () => {
  target = createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end(`hello from target ${req.method} ${req.url}`);
  });
  await new Promise<void>((r) => target.listen(0, "127.0.0.1", r));
  targetPort = (target.address() as AddressInfo).port;
});
afterAll(async () => {
  target?.closeAllConnections();
  await new Promise((r) => target?.close(r));
});

const listen = async <T extends Server | NetServer>(s: T): Promise<{ server: T; port: number }> => {
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  return { server: s, port: (s.address() as AddressInfo).port };
};

/** Send CONNECT; once the tunnel is up, send an HTTP request through it; return everything read. */
const tunnel = (proxyPort: number, hostPort: string) =>
  new Promise<string>((resolve, reject) => {
    const s = connect(proxyPort, "127.0.0.1");
    let buf = "";
    let sent = false;
    s.on("data", (c: Buffer) => {
      buf += c.toString();
      if (!sent && buf.startsWith("HTTP/1.1 200")) {
        sent = true;
        s.write(`GET /t HTTP/1.1\r\nHost: ${hostPort}\r\nConnection: close\r\n\r\n`);
      }
    });
    s.on("end", () => resolve(buf));
    s.on("error", reject);
    s.write(`CONNECT ${hostPort} HTTP/1.1\r\nHost: ${hostPort}\r\n\r\n`);
  });

/** Write raw bytes to the SOCKS port and collect what comes back until the server closes. */
const raw = (port: number, chunks: Buffer[], after?: (got: Buffer) => Buffer | null) =>
  new Promise<Buffer>((resolve, reject) => {
    const s = connect(port, "127.0.0.1");
    let got = Buffer.alloc(0);
    let followed = false;
    s.on("data", (c: Buffer) => {
      got = Buffer.concat([got, c]);
      if (!followed && after) {
        const next = after(got);
        if (next !== null) {
          followed = true;
          s.write(next);
        }
      }
    });
    s.on("close", () => resolve(got));
    s.on("error", reject);
    for (const c of chunks) s.write(c);
    // A refusal half-closes; end our side too so the socket closes.
    s.on("end", () => s.end());
  });

const httpGet = Buffer.from("GET /s HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n");
const greeting = Buffer.from([5, 1, 0]);
const domainReq = (host: string, port: number, cmd = 1) => {
  const h = Buffer.from(host, "latin1");
  const p = Buffer.alloc(2);
  p.writeUInt16BE(port);
  return Buffer.concat([Buffer.from([5, cmd, 0, 3, h.length]), h, p]);
};
const ipv4Req = (ip: number[], port: number) => {
  const p = Buffer.alloc(2);
  p.writeUInt16BE(port);
  return Buffer.concat([Buffer.from([5, 1, 0, 1, ...ip]), p]);
};
const ipv6Req = (bytes: number[], port: number) => {
  const p = Buffer.alloc(2);
  p.writeUInt16BE(port);
  return Buffer.concat([Buffer.from([5, 1, 0, 4, ...bytes]), p]);
};
const socks4a = (host: string, port: number, cmd = 1) => {
  const p = Buffer.alloc(2);
  p.writeUInt16BE(port);
  return Buffer.concat([
    Buffer.from([4, cmd]),
    p,
    Buffer.from([0, 0, 0, 1]),
    Buffer.from("u\0"),
    Buffer.from(`${host}\0`, "latin1"),
  ]);
};
const socks4 = (ip: number[], port: number) => {
  const p = Buffer.alloc(2);
  p.writeUInt16BE(port);
  return Buffer.concat([Buffer.from([4, 1]), p, Buffer.from(ip), Buffer.from("u\0")]);
};

/** SOCKS5 CONNECT then an HTTP request through the tunnel (sent after the success reply). */
const socks5Http = (port: number, req: Buffer) =>
  raw(port, [greeting, req], (got) => (got.length >= 12 && got[3] === 0 ? httpGet : null));

describe("strict mode", () => {
  it("refuses CONNECT to port 22 and opens no SOCKS listener", async () => {
    const { server, port } = await listen(
      createEgressProxy({
        allowHosts: ["allowed.example.com"],
        testHosts: { "allowed.example.com": "127.0.0.1" },
        log: quiet,
      }),
    );
    try {
      const out = await tunnel(port, "allowed.example.com:22");
      expect(out).toMatch(/^HTTP\/1\.1 403/);
      expect(out).toContain("port 22 is not allowed");
    } finally {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    }
    const started = main({ MODE: "strict", PORT: "0", ALLOW_HOSTS: "[]" });
    try {
      expect(started.socks).toBeNull();
    } finally {
      await new Promise((r) => started.http.close(r));
    }
  });

  it("refuses an unknown mode", () => {
    expect(() => main({ MODE: "wide", PORT: "0" })).toThrow(/Unknown MODE/);
    expect(() => createEgressProxy({ mode: "wide" as "dev" })).toThrow(/Unknown egress proxy mode/);
  });
});

describe("dev mode", () => {
  let http: Server;
  let httpPort: number;
  let socks: NetServer;
  let socksPort: number;
  const logs: string[] = [];

  beforeAll(async () => {
    const cfg = {
      mode: "dev" as const,
      allowHosts: ["allowed.example.com", "*.example.com"],
      testHosts: { "allowed.example.com": "127.0.0.1" },
      lookup,
      log: (m: string) => logs.push(m),
    };
    ({ server: http, port: httpPort } = await listen(createEgressProxy(cfg)));
    ({ server: socks, port: socksPort } = await listen(createSocksProxy(cfg)));
  });
  afterAll(async () => {
    http?.closeAllConnections();
    await new Promise((r) => http?.close(r));
    await new Promise((r) => socks?.close(r));
  });

  it("tunnels CONNECT to an allowed host on any port", async () => {
    expect(targetPort).not.toBe(443);
    const out = await tunnel(httpPort, `allowed.example.com:${targetPort}`);
    expect(out).toMatch(/^HTTP\/1\.1 200 Connection Established/);
    expect(out).toContain("hello from target GET /t");
  });

  it("refuses unlisted hosts, private resolutions and IP literals", async () => {
    expect(await tunnel(httpPort, "denied.org:22")).toMatch(/^HTTP\/1\.1 403/);
    expect(await tunnel(httpPort, `rebind.example.com:${targetPort}`)).toMatch(/^HTTP\/1\.1 403/);
    expect(await tunnel(httpPort, `127.0.0.1:${targetPort}`)).toMatch(/^HTTP\/1\.1 403/);
    expect(await tunnel(httpPort, "[::1]:22")).toMatch(/^HTTP\/1\.1 403/);
    expect(logs.some((l) => l.includes("blocked by the sandbox egress allowlist"))).toBe(true);
  });

  it("connects through SOCKS5 to an allowed domain", async () => {
    const got = await socks5Http(socksPort, domainReq("allowed.example.com", targetPort));
    expect([...got.subarray(0, 2)]).toEqual([5, 0]);
    expect([...got.subarray(2, 4)]).toEqual([5, 0]);
    expect(got.subarray(12).toString()).toContain("hello from target GET /s");
  });

  it("forwards bytes the client sent right after the request", async () => {
    const got = await raw(socksPort, [
      Buffer.concat([greeting, domainReq("allowed.example.com", targetPort), httpGet]),
    ]);
    expect(got[3]).toBe(0);
    expect(got.subarray(12).toString()).toContain("hello from target GET /s");
  });

  it.each([
    ["an unlisted domain", domainReq("denied.org", 22), 0x02],
    ["a private resolution", domainReq("rebind.example.com", 22), 0x02],
    ["an IPv4 literal", ipv4Req([127, 0, 0, 1], targetPort), 0x02],
    ["a public IPv4 literal", ipv4Req([8, 8, 8, 8], 22), 0x02],
    ["an IPv6 literal", ipv6Req([...Array(15).fill(0), 1], targetPort), 0x02],
    ["a name with control characters", domainReq("allowed.example.com\r\nx", 22), 0x02],
    ["an unresolvable allowed name", domainReq("nx.example.com", 22), 0x04],
    ["port 0", domainReq("allowed.example.com", 0), 0x02],
  ])("refuses SOCKS5 CONNECT to %s", async (_name, req, code) => {
    const got = await raw(socksPort, [greeting, req]);
    expect([...got.subarray(0, 2)]).toEqual([5, 0]);
    expect(got[2]).toBe(5);
    expect(got[3]).toBe(code);
  });

  it.each([
    ["BIND", 2],
    ["UDP ASSOCIATE", 3],
  ])("refuses SOCKS5 %s with 0x07", async (name, cmd) => {
    const got = await raw(socksPort, [greeting, domainReq("allowed.example.com", targetPort, cmd)]);
    expect(got[3]).toBe(0x07);
    expect(logs.some((l) => l.includes(`${name} is not supported`))).toBe(true);
  });

  it("refuses an unknown address type with 0x08", async () => {
    const got = await raw(socksPort, [greeting, Buffer.from([5, 1, 0, 9, 1, 2, 3, 4, 0, 80])]);
    expect(got[3]).toBe(0x08);
  });

  it("answers 0xFF when the client offers no no-auth method", async () => {
    const got = await raw(socksPort, [Buffer.from([5, 1, 2])]);
    expect([...got]).toEqual([5, 0xff]);
  });

  it("closes on a malformed greeting without a reply", async () => {
    const got = await raw(socksPort, [Buffer.from("GET / HTTP/1.1\r\n\r\n")]);
    expect(got.length).toBe(0);
    const bad = await raw(socksPort, [greeting, Buffer.from([4, 1, 0, 3, 0])]);
    expect([...bad]).toEqual([5, 0]);
  });

  it("handles a handshake split into single bytes", async () => {
    const bytes = Buffer.concat([greeting, domainReq("allowed.example.com", targetPort)]);
    const got = await new Promise<Buffer>((resolve, reject) => {
      const s = connect(socksPort, "127.0.0.1");
      let out = Buffer.alloc(0);
      s.on("data", (c: Buffer) => {
        out = Buffer.concat([out, c]);
        if (out.length >= 12) {
          s.destroy();
          resolve(out);
        }
      });
      s.on("error", reject);
      s.setNoDelay(true);
      let i = 0;
      const tick = () => {
        if (i < bytes.length) {
          s.write(bytes.subarray(i, i + 1));
          i++;
          setImmediate(tick);
        }
      };
      tick();
    });
    expect(got[3]).toBe(0);
  });

  it("speaks SOCKS4a for allowed names and refuses SOCKS4 IP literals and BIND", async () => {
    const ok = await raw(socksPort, [socks4a("allowed.example.com", targetPort)], (g) =>
      g.length >= 8 && g[1] === 0x5a ? httpGet : null,
    );
    expect(ok[1]).toBe(0x5a);
    expect(ok.subarray(8).toString()).toContain("hello from target GET /s");
    expect((await raw(socksPort, [socks4([127, 0, 0, 1], targetPort)]))[1]).toBe(0x5b);
    expect((await raw(socksPort, [socks4a("denied.org", 22)]))[1]).toBe(0x5b);
    expect((await raw(socksPort, [socks4a("allowed.example.com", targetPort, 2)]))[1]).toBe(0x5b);
  });

  const hasNc =
    spawnSync("nc", ["-h"], { encoding: "utf8" }).stderr?.includes("-X") ||
    spawnSync("nc", ["-h"], { encoding: "utf8" }).stdout?.includes("-X");
  it.skipIf(!hasNc)("works as an ssh ProxyCommand through nc -X 5", async () => {
    const out = await new Promise<string>((resolve, reject) => {
      const p = spawn("nc", [
        "-X",
        "5",
        "-x",
        `127.0.0.1:${socksPort}`,
        "allowed.example.com",
        `${targetPort}`,
      ]);
      let buf = "";
      p.stdout.on("data", (c) => {
        buf += c;
      });
      p.on("error", reject);
      p.on("close", () => resolve(buf));
      p.stdin.end("GET /nc HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n");
      setTimeout(() => p.kill(), 5000);
    });
    expect(out).toContain("hello from target GET /nc");
  });
});

describe("open mode", () => {
  let http: Server;
  let httpPort: number;
  let socks: NetServer;
  let socksPort: number;

  beforeAll(async () => {
    const cfg = {
      mode: "open" as const,
      // ignored in open mode
      allowHosts: ["only.example.com"],
      testHosts: { "anything.open.org": "127.0.0.1" },
      lookup,
      log: quiet,
    };
    ({ server: http, port: httpPort } = await listen(createEgressProxy(cfg)));
    ({ server: socks, port: socksPort } = await listen(createSocksProxy(cfg)));
  });
  afterAll(async () => {
    http?.closeAllConnections();
    await new Promise((r) => http?.close(r));
    await new Promise((r) => socks?.close(r));
  });

  it("reaches any (pinned) public name on any port over CONNECT and SOCKS5", async () => {
    const out = await tunnel(httpPort, `anything.open.org:${targetPort}`);
    expect(out).toContain("hello from target GET /t");
    const got = await socks5Http(socksPort, domainReq("anything.open.org", targetPort));
    expect(got.subarray(12).toString()).toContain("hello from target GET /s");
  });

  it("refuses names resolving to private or metadata addresses", async () => {
    expect(await tunnel(httpPort, "rebind.open.org:5432")).toMatch(/^HTTP\/1\.1 403/);
    expect(await tunnel(httpPort, "meta.open.org:80")).toMatch(/^HTTP\/1\.1 403/);
    expect((await raw(socksPort, [greeting, domainReq("rebind.open.org", 22)]))[3]).toBe(0x02);
  });

  it("refuses private IP literals", async () => {
    expect(await tunnel(httpPort, `127.0.0.1:${targetPort}`)).toMatch(/^HTTP\/1\.1 403/);
    expect(await tunnel(httpPort, "[::ffff:169.254.169.254]:80")).toMatch(/^HTTP\/1\.1 403/);
    expect((await raw(socksPort, [greeting, ipv4Req([127, 0, 0, 1], targetPort)]))[3]).toBe(0x02);
    expect((await raw(socksPort, [greeting, ipv4Req([10, 1, 2, 3], 22)]))[3]).toBe(0x02);
    const v6loop = ipv6Req([...Array(15).fill(0), 1], targetPort);
    expect((await raw(socksPort, [greeting, v6loop]))[3]).toBe(0x02);
    expect((await raw(socksPort, [socks4([127, 0, 0, 1], targetPort)]))[1]).toBe(0x5b);
  });

  it("refuses internal-only and single-label names", async () => {
    for (const h of ["localhost", "host.docker.internal", "printer.local", "intranet"]) {
      expect(await tunnel(httpPort, `${h}:80`)).toMatch(/^HTTP\/1\.1 403/);
    }
  });
});

describe("resolveTarget", () => {
  const base = { allowHosts: ["a.example.com"], testHosts: {}, lookup };
  it("accepts public IP literals only in open mode", async () => {
    await expect(resolveTarget("8.8.8.8", { ...base, mode: "open" })).resolves.toEqual(["8.8.8.8"]);
    await expect(resolveTarget("[2606:4700::1111]", { ...base, mode: "open" })).resolves.toEqual([
      "2606:4700::1111",
    ]);
    await expect(resolveTarget("8.8.8.8", { ...base, mode: "dev" })).rejects.toThrow(/allowlist/);
    await expect(resolveTarget("public.open.org", { ...base, mode: "open" })).resolves.toEqual([
      "8.8.8.8",
    ]);
  });
  it("refuses control characters and malformed names in every mode", async () => {
    for (const mode of ["strict", "dev", "open"] as const) {
      await expect(resolveTarget("a.example.com\n", { ...base, mode })).rejects.toThrow(
        /Malformed/,
      );
      await expect(resolveTarget("a.example.com\0", { ...base, mode })).rejects.toThrow(
        /Malformed/,
      );
      await expect(resolveTarget("a b.com", { ...base, mode })).rejects.toThrow(/Malformed/);
      await expect(resolveTarget("user@a.example.com", { ...base, mode })).rejects.toThrow(
        /Malformed/,
      );
    }
    await expect(resolveTarget("bad_label.com", { ...base, mode: "open" })).rejects.toThrow(
      /malformed/,
    );
    await expect(resolveTarget("0x7f.1", { ...base, mode: "open" })).rejects.toThrow(/malformed/);
  });
});

describe("hardening", () => {
  it("strict mode limits plain HTTP forwarding to the allowed ports", async () => {
    const { server, port } = await listen(
      createEgressProxy({
        allowHosts: ["allowed.example.com"],
        testHosts: { "allowed.example.com": "127.0.0.1" },
        log: quiet,
      }),
    );
    try {
      const out = await new Promise<string>((resolve, reject) => {
        const s = connect(port, "127.0.0.1");
        let buf = "";
        s.on("data", (c: Buffer) => {
          buf += c.toString();
        });
        s.on("end", () => resolve(buf));
        s.on("error", reject);
        s.write(
          `GET http://allowed.example.com:${targetPort}/ HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`,
        );
      });
      expect(out).toMatch(/^HTTP\/1\.1 403/);
      expect(out).toContain(`Port ${targetPort} is not allowed`);
    } finally {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    }
  });

  it("caps concurrent connections on both listeners", () => {
    expect(createEgressProxy({ log: quiet }).maxConnections).toBe(512);
    expect(createSocksProxy({ mode: "dev", log: quiet }).maxConnections).toBe(512);
  });

  describe("SOCKS deadlines", () => {
    let socks: NetServer;
    let port: number;
    const logs: string[] = [];
    beforeAll(async () => {
      ({ server: socks, port } = await listen(
        createSocksProxy({
          mode: "dev",
          allowHosts: ["allowed.example.com"],
          testHosts: { "allowed.example.com": "127.0.0.1" },
          handshakeMs: 300,
          log: (m) => logs.push(m),
        }),
      ));
    });
    afterAll(async () => {
      await new Promise((r) => socks?.close(r));
    });

    /** Keep writing `chunk` every tick until the server closes; resolve with ms elapsed and bytes read. */
    const flood = (first: Buffer[], chunk: Buffer) =>
      new Promise<{ ms: number; got: Buffer }>((resolve) => {
        const started = Date.now();
        const s = connect(port, "127.0.0.1");
        let got = Buffer.alloc(0);
        let open = true;
        s.on("data", (c: Buffer) => {
          got = Buffer.concat([got, c]);
        });
        s.on("error", () => {});
        s.on("close", () => {
          open = false;
          resolve({ ms: Date.now() - started, got });
        });
        for (const c of first) s.write(c);
        const pump = () => {
          if (!open) return;
          if (s.write(chunk)) setImmediate(pump);
          else s.once("drain", pump);
        };
        pump();
      });

    it("closes a stalled handshake at the deadline", async () => {
      const r = await flood([Buffer.from([5])], Buffer.alloc(0));
      expect(r.ms).toBeGreaterThanOrEqual(250);
      expect(r.ms).toBeLessThan(3000);
      expect(logs.some((l) => l.includes("handshake timed out"))).toBe(true);
    });

    it("discards input after a refusal and still closes at the absolute deadline", async () => {
      const r = await flood([greeting, domainReq("denied.org", 22)], Buffer.alloc(64 * 1024));
      expect([...r.got]).toEqual([5, 0, 5, 2, 0, 1, 0, 0, 0, 0, 0, 0]);
      expect(r.ms).toBeLessThan(3000);
    });

    it("keeps an established tunnel past the deadline", async () => {
      const s = connect(port, "127.0.0.1");
      s.on("error", () => {});
      s.write(Buffer.concat([greeting, domainReq("allowed.example.com", targetPort)]));
      await new Promise((r) => s.once("data", r));
      await new Promise((r) => setTimeout(r, 500));
      expect(s.destroyed).toBe(false);
      const body = await new Promise<string>((resolve) => {
        let buf = "";
        s.on("data", (c: Buffer) => {
          buf += c.toString();
        });
        s.on("close", () => resolve(buf));
        s.write(httpGet);
      });
      expect(body).toContain("hello from target GET /s");
    });
  });

  it("bounds each connect attempt", async () => {
    const started = Date.now();
    // TEST-NET-1: normally unroutable, so the attempt hangs until the deadline (or fails fast).
    await expect(connectAny(["192.0.2.1"], 9, 200)).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it.each([
    "2001::1",
    "2001:0:4136:e378::1",
    "2001:db8::1",
    "3fff::1",
    "5f00::1",
    "64:ff9b:1::808:808",
    "::ffff:0:808:808",
    "fec0::1",
    "100::1",
    "4000::1",
  ])("IPv6 %s is forbidden (default deny outside 2000::/3)", (ip) => {
    expect(isForbiddenAddress(ip)).toBe(true);
  });

  it.each(["2a00:1450:4001::1", "2606:4700::1111", "64:ff9b::808:808", "2002:808:808::1"])(
    "IPv6 %s is allowed",
    (ip) => {
      expect(isForbiddenAddress(ip)).toBe(false);
    },
  );

  it("escapes every non-ASCII character in log lines", async () => {
    const logs: string[] = [];
    const { server, port } = await listen(
      createSocksProxy({ mode: "dev", allowHosts: [], log: (m) => logs.push(m) }),
    );
    try {
      await raw(port, [greeting, domainReq("\u00e9vil\u0085x.com", 22)]);
      const line = logs.find((l) => l.includes("vil")) ?? "";
      expect(line).toMatch(/^[\x20-\x7e]+$/);
      expect(line).toContain("\\u00e9vil\\u0085x.com");
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it("checks the public name shape in strict and dev too", async () => {
    const opts = { allowHosts: ["*.example.com"], testHosts: {}, lookup };
    for (const mode of ["strict", "dev"] as const) {
      await expect(resolveTarget("a_b.example.com", { ...opts, mode })).rejects.toThrow(
        /malformed/,
      );
      await expect(resolveTarget("-a.example.com", { ...opts, mode })).rejects.toThrow(/malformed/);
      await expect(resolveTarget("public.example.com", { ...opts, mode })).resolves.toEqual([
        "8.8.8.8",
      ]);
    }
  });
});
