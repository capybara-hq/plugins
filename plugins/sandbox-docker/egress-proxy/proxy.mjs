// Capybara sandbox egress proxy: one per proxied sandbox, on an internal network shared only with
// that sandbox; its other leg joins the outbound network.
//
// Modes (env MODE, default "open-public"):
// - open-public: any public host name (shape as validateAllowHost, no list), and IP literals when
//   the address is public; any port; HTTP by absolute URL, CONNECT and a SOCKS listener on
//   SOCKS_PORT (default 1080). ALLOW_HOSTS is ignored.
// - allowlist: hosts from ALLOW_HOSTS (JSON array of names, rules as plugin-sdk's
//   validateAllowHost: an exact name, or `*.example.com` for any subdomain, not example.com
//   itself); any port; HTTP, CONNECT and the SOCKS listener. IP literals are refused.
// The SOCKS listener speaks SOCKS5 (no-auth, CONNECT only; ATYP domain / IPv4 / IPv6) and SOCKS4a
// (CONNECT only; for `socat ... SOCKS4A:`).
//
// Every mode: refuse malformed names (control characters, bad labels); resolve, then check EVERY
// resolved IP: private, loopback, link-local (including the 169.254.169.254 metadata address),
// CGNAT, ULA, unspecified, multicast, reserved and documentation addresses are refused (this blocks
// DNS rebinding such as 10.0.0.1.nip.io); then connect to an address that was checked, never
// resolving a second time. When the first address cannot be reached the next checked one is tried.
//
// Test only: CAPYBARA_EGRESS_TEST_HOSTS (JSON object name -> IP) pins a name to an IP and exempts
// it from the private address check (in allowlist it must still be on the list; in open-public a
// pinned name is allowed). The plugin's deployment config cannot set it; only tests that call
// createDockerSandbox directly can.
//
// Dependency-free, Node >= 22. Error text reaches the model (through curl / pip output): English.
import { lookup as dnsLookup } from "node:dns/promises";
import { createServer, request as httpRequest } from "node:http";
import { BlockList, connect, createServer as createNetServer, isIP } from "node:net";

// This file runs in the egress proxy container (not in the kernel process); the module-level
// objects below are constant tables, read-only after start.
// capybara:allow-module-state read-only constant table (egress proxy container, not the kernel)
const BLOCKED_V4 = [
  ["0.0.0.0", 8], // unspecified / this network
  ["10.0.0.0", 8],
  ["100.64.0.0", 10], // CGNAT
  ["127.0.0.0", 8],
  ["169.254.0.0", 16], // link-local (including cloud metadata 169.254.169.254)
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved and broadcast
];
// IPv6 is default deny: only global unicast 2000::/3 is reachable, minus the special-purpose
// blocks below (addresses that embed an IPv4 address are judged by it first, see
// isForbiddenAddress).
// capybara:allow-module-state read-only constant table (egress proxy container, not the kernel)
const BLOCKED_V6 = [
  ["2001::", 23], // IETF protocol assignments, including Teredo 2001::/32 and benchmarking
  ["2001:db8::", 32], // documentation
  ["3fff::", 20], // documentation
];

// capybara:allow-module-state address table built once at start, read-only (proxy container)
const blocked = new BlockList();
for (const [a, p] of BLOCKED_V4) blocked.addSubnet(a, p, "ipv4");
for (const [a, p] of BLOCKED_V6) blocked.addSubnet(a, p, "ipv6");

/** IPv6 text -> 8 numbers of 16 bits; null when it does not parse. */
function v6Groups(ip) {
  let s = ip.toLowerCase();
  const zone = s.indexOf("%");
  if (zone >= 0) s = s.slice(0, zone);
  // trailing dotted IPv4 (::ffff:1.2.3.4)
  const m = s.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (m) {
    const b = m[2].split(".").map(Number);
    s = `${m[1]}${((b[0] << 8) | b[1]).toString(16)}:${((b[2] << 8) | b[3]).toString(16)}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0) return null;
  const groups = [...head, ...Array(fill).fill("0"), ...tail].map((g) => Number.parseInt(g, 16));
  return groups.length === 8 && groups.every((g) => g >= 0 && g <= 0xffff) ? groups : null;
}

const v4Of = (hi, lo) => `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;

/**
 * Whether connecting to a resolved IP is forbidden. IPv6 addresses that embed an IPv4 address
 * (IPv4-mapped ::ffff:0:0/96, IPv4-compatible ::/96, NAT64 64:ff9b::/96, 6to4 2002::/16) are
 * judged by the embedded IPv4; anything unrecognised is forbidden.
 */
export function isForbiddenAddress(ip) {
  const family = isIP(ip);
  if (family === 4) return blocked.check(ip, "ipv4");
  if (family !== 6) return true;
  const g = v6Groups(ip);
  if (g === null) return true;
  const zeros = (from, to) => g.slice(from, to).every((x) => x === 0);
  if (zeros(0, 5) && g[5] === 0xffff) return isForbiddenAddress(v4Of(g[6], g[7]));
  if (zeros(0, 6) && (g[6] !== 0 || g[7] > 1)) return isForbiddenAddress(v4Of(g[6], g[7]));
  if (g[0] === 0x64 && g[1] === 0xff9b && zeros(2, 6)) return isForbiddenAddress(v4Of(g[6], g[7]));
  if (g[0] === 0x2002) return isForbiddenAddress(v4Of(g[1], g[2]));
  // Everything outside global unicast 2000::/3 (loopback, ULA, link-local, multicast, the local-use
  // NAT64 prefix 64:ff9b:1::/48, SIIT ::ffff:0:0:0/96, 5f00::/16, ...) is forbidden.
  if ((g[0] & 0xe000) !== 0x2000) return true;
  const canonical = g.map((x) => x.toString(16)).join(":");
  return blocked.check(canonical, "ipv6");
}

/** Normalise a host name: lowercase, without trailing dots and IPv6 brackets. */
export function normalizeHost(host) {
  let h = String(host).trim().toLowerCase();
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
  while (h.endsWith(".")) h = h.slice(0, -1);
  return h;
}

/** Whether a host is on the allowlist: exact, or `*.x` for any subdomain of x (not x). Never an IP literal. */
export function hostAllowed(host, allowHosts) {
  const h = normalizeHost(host);
  if (h === "" || isIP(h) !== 0) return false;
  return allowHosts.some((p) => (p.startsWith("*.") ? h.endsWith(p.slice(1)) : h === p));
}

const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * Why a normalised host name is not a public DNS name (null when it is): the shape rules of
 * plugin-sdk's validateAllowHost without the wildcard (lowercase LDH labels, at least two labels,
 * a top-level label starting with a letter, no .local / .internal / .localhost).
 */
export function publicNameError(h) {
  if (h.length === 0 || h.length > 253) return "host name is empty or too long";
  const labels = h.split(".");
  if (!labels.every((l) => LABEL.test(l))) return "host name is malformed";
  if (labels.length < 2) return "single-label host names are not allowed";
  const tld = labels[labels.length - 1];
  if (!/^[a-z]/.test(tld)) return "host name is malformed";
  if (["local", "internal", "localhost"].includes(tld)) {
    return "internal-only domains (.local, .internal, .localhost) are not allowed";
  }
  return null;
}

/** Proxy modes. */
// capybara:allow-module-state read-only constant list (egress proxy container, not the kernel)
export const MODES = Object.freeze(["open-public", "allowlist"]);

class Refused extends Error {
  /** @param {number} status 400 malformed, 403 not allowed, 502 cannot resolve or connect */
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/**
 * Decide which IPs may be connected to: host check for the mode -> resolve -> no address may be
 * forbidden. Returns every checked address (in resolution order).
 * @param {{ mode?: "open-public" | "allowlist"; allowHosts: string[]; testHosts: Record<string, string>; lookup: (h: string) => Promise<{ address: string }[]> }} opts
 */
export async function resolveTarget(host, opts) {
  const mode = opts.mode ?? "open-public";
  const raw = String(host);
  // Control characters, spaces and other bytes no host name or IP literal contains.
  if (!/^[\x21-\x7e]+$/.test(raw) || /[/\\@?#%]/.test(raw)) {
    throw new Refused(400, "Malformed host name.");
  }
  const h = normalizeHost(raw);
  const pinned = Object.hasOwn(opts.testHosts, h) ? opts.testHosts[h] : undefined;
  if (mode === "open-public" && isIP(h) !== 0) {
    if (isForbiddenAddress(h)) {
      throw new Refused(
        403,
        `Outbound access to ${h} is blocked: it is a private or reserved address.`,
      );
    }
    return [h];
  }
  // Every mode: a name must have the shape of a public DNS name (pinned test names excepted).
  if (isIP(h) === 0 && pinned === undefined) {
    const err = publicNameError(h);
    if (err !== null) throw new Refused(403, `Outbound access to ${h} is blocked: ${err}.`);
  }
  if (mode === "allowlist" && !hostAllowed(h, opts.allowHosts)) {
    throw new Refused(
      403,
      `Outbound access to ${h} is blocked by the sandbox egress allowlist. Allowed hosts: ${opts.allowHosts.join(", ") || "(none)"}.`,
    );
  }
  if (pinned !== undefined) return [pinned];
  let addrs;
  try {
    addrs = await opts.lookup(h);
  } catch {
    throw new Refused(502, `Cannot resolve ${h}.`);
  }
  if (addrs.length === 0) throw new Refused(502, `Cannot resolve ${h}.`);
  if (addrs.some((a) => isForbiddenAddress(a.address))) {
    throw new Refused(
      403,
      `Outbound access to ${h} is blocked: it resolves to a private or reserved address.`,
    );
  }
  return addrs.map((a) => a.address);
}

/** Each address gets this long to connect before the next one is tried. */
const CONNECT_TIMEOUT_MS = 10_000;

/**
 * Connect to the checked addresses in turn; resolve with the first that connects, else reject with
 * the last error. Each attempt is bounded by AbortSignal.timeout (plugins use no timers).
 */
export function connectAny(ips, port, timeoutMs = CONNECT_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const attempt = (i, lastError) => {
      if (i >= ips.length) {
        reject(lastError ?? new Error("no address"));
        return;
      }
      const s = connect({ host: ips[i], port, allowHalfOpen: true });
      const deadline = AbortSignal.timeout(timeoutMs);
      const onTimeout = () => {
        const e = Object.assign(new Error(`connect to ${ips[i]}:${port} timed out`), {
          code: "ETIMEDOUT",
        });
        s.destroy(e);
      };
      deadline.addEventListener("abort", onTimeout, { once: true });
      s.once("connect", () => {
        deadline.removeEventListener("abort", onTimeout);
        s.removeAllListeners("error");
        resolve(s);
      });
      s.once("error", (e) => {
        deadline.removeEventListener("abort", onTimeout);
        s.destroy();
        attempt(i + 1, e);
      });
    };
    attempt(0, undefined);
  });
}

// capybara:allow-module-state read-only constant table (egress proxy container, not the kernel)
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

/** Drop hop-by-hop headers (including those listed in Connection). */
function forwardHeaders(headers) {
  const listed = String(headers.connection ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    if (!HOP_BY_HOP.has(k) && !listed.includes(k) && v !== undefined) out[k] = v;
  }
  return out;
}

/** `host:port` (also `[v6]:port`) -> [host, port]. */
function splitHostPort(s) {
  const m = String(s).match(/^\[?([^\]]*?)\]?:(\d{1,5})$/);
  if (!m) return null;
  const port = Number(m[2]);
  return port > 0 && port < 65536 ? [m[1], port] : null;
}

/** Pipe two sockets both ways; either side failing or closing tears down the other. */
function splice(client, up) {
  up.on("error", () => client.destroy());
  client.on("error", () => up.destroy());
  client.on("close", () => up.destroy());
  up.on("close", () => client.destroy());
  up.pipe(client);
  client.pipe(up);
}

const defaultLookup = (h) => dnsLookup(h, { all: true, verbatim: true });
const defaultLog = (msg) => console.warn(msg);

/** Shared options for both listeners. */
function proxyOptions(cfg) {
  const mode = cfg.mode ?? "open-public";
  if (!MODES.includes(mode)) throw new Error(`Unknown egress proxy mode ${JSON.stringify(mode)}.`);
  return {
    mode,
    allowHosts: (cfg.allowHosts ?? []).map((h) => h.toLowerCase()),
    testHosts: cfg.testHosts ?? {},
    lookup: cfg.lookup ?? defaultLookup,
    log: cfg.log ?? defaultLog,
  };
}

/** A host for logs: quoted, every non-printable-ASCII character escaped, so nothing can forge log lines. */
const q = (s) =>
  JSON.stringify(String(s)).replace(
    /[^\x20-\x7e]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );

/** Concurrent connections each listener accepts. */
const MAX_CONNECTIONS = 512;

/**
 * Create the HTTP proxy server (not listening): absolute-URL HTTP forwarding, CONNECT tunnels and
 * GET /healthz. Both modes allow any port 1-65535.
 * @param {{ mode?: "open-public" | "allowlist"; allowHosts?: string[]; testHosts?: Record<string, string>; lookup?: (h: string) => Promise<{ address: string }[]>; log?: (msg: string) => void }} cfg
 */
export function createEgressProxy(cfg) {
  const opts = proxyOptions(cfg);
  const refuse = (res, e, target) => {
    const status = e instanceof Refused ? e.status : 502;
    const msg = e instanceof Refused ? e.message : "Upstream connection failed.";
    opts.log(`egress refused http ${q(target)}: ${msg}`);
    if (!res.headersSent)
      res.writeHead(status, { "content-type": "text/plain", connection: "close" });
    res.end(`${msg}\n`);
  };

  const server = createServer(async (req, res) => {
    if (req.url === "/healthz") {
      res.writeHead(200, { "content-type": "text/plain" }).end("ok\n");
      return;
    }
    let url;
    try {
      url = new URL(req.url);
    } catch {
      refuse(
        res,
        new Refused(400, "This is an HTTP proxy: request an absolute http:// URL."),
        req.url,
      );
      return;
    }
    if (url.protocol !== "http:") {
      refuse(
        res,
        new Refused(400, "Only http:// URLs can be proxied; use CONNECT for https."),
        req.url,
      );
      return;
    }
    const port = url.port === "" ? 80 : Number(url.port);
    let sock;
    try {
      const ips = await resolveTarget(url.hostname, opts);
      sock = await connectAny(ips, port).catch(() => {
        throw new Refused(502, `Cannot connect to ${url.host}.`);
      });
    } catch (e) {
      refuse(res, e, url.host);
      return;
    }
    const headers = forwardHeaders(req.headers);
    headers.host = url.host;
    // One upstream connection per request (no pool, never reused for another host).
    headers.connection = "close";
    const up = httpRequest({
      createConnection: () => sock,
      method: req.method,
      path: `${url.pathname}${url.search}`,
      headers,
      setHost: false,
    });
    up.on("response", (r) => {
      res.writeHead(r.statusCode ?? 502, forwardHeaders(r.headers));
      r.pipe(res);
    });
    up.on("error", (e) => refuse(res, e, url.host));
    req.on("aborted", () => up.destroy());
    req.pipe(up);
  });

  server.on("connect", async (req, socket, head) => {
    socket.on("error", () => socket.destroy());
    const hp = splitHostPort(req.url);
    const fail = (status, msg) => {
      opts.log(`egress refused connect ${q(req.url)}: ${msg}`);
      const reason = status === 403 ? "Forbidden" : status === 400 ? "Bad Request" : "Bad Gateway";
      socket.end(
        `HTTP/1.1 ${status} ${reason}\r\ncontent-type: text/plain\r\nconnection: close\r\n\r\n${msg}\n`,
      );
    };
    if (hp === null) {
      fail(400, "CONNECT needs host:port.");
      return;
    }
    let ips;
    try {
      ips = await resolveTarget(hp[0], opts);
    } catch (e) {
      fail(e instanceof Refused ? e.status : 502, e instanceof Refused ? e.message : "Failed.");
      return;
    }
    let up;
    try {
      up = await connectAny(ips, hp[1]);
    } catch {
      fail(502, `Cannot connect to ${hp[0]}:${hp[1]}.`);
      return;
    }
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head.length > 0) up.write(head);
    splice(socket, up);
  });
  server.on("clientError", (_e, socket) => socket.destroy());
  server.maxConnections = MAX_CONNECTIONS;
  return server;
}

// SOCKS5 reply codes (RFC 1928 section 6).
const SOCKS5_OK = 0x00;
const SOCKS5_FAILURE = 0x01;
const SOCKS5_NOT_ALLOWED = 0x02;
const SOCKS5_NET_UNREACHABLE = 0x03;
const SOCKS5_HOST_UNREACHABLE = 0x04;
const SOCKS5_CONN_REFUSED = 0x05;
const SOCKS5_TTL_EXPIRED = 0x06;
const SOCKS5_CMD_UNSUPPORTED = 0x07;
const SOCKS5_ATYP_UNSUPPORTED = 0x08;

/** Handshake must finish within this time and this many bytes. */
const SOCKS_HANDSHAKE_MS = 30_000;
const SOCKS_HANDSHAKE_MAX = 1024;

/** Map a connect error to a SOCKS5 reply code. */
function socks5ConnectCode(e) {
  switch (e?.code) {
    case "ECONNREFUSED":
      return SOCKS5_CONN_REFUSED;
    case "ENETUNREACH":
      return SOCKS5_NET_UNREACHABLE;
    case "EHOSTUNREACH":
      return SOCKS5_HOST_UNREACHABLE;
    case "ETIMEDOUT":
      return SOCKS5_TTL_EXPIRED;
    default:
      return SOCKS5_FAILURE;
  }
}

/**
 * Parse the buffered SOCKS handshake. Returns { need: true } while more bytes are needed, or a
 * parsed step. Only the parts that can be judged from the bytes are decided here.
 */
function parseSocks(buf, stage) {
  if (buf.length < 1) return { need: true };
  if (stage === "greeting") {
    const ver = buf[0];
    if (ver === 5) {
      if (buf.length < 2) return { need: true };
      const n = buf[1];
      if (buf.length < 2 + n) return { need: true };
      return { kind: "greeting5", methods: [...buf.subarray(2, 2 + n)], used: 2 + n };
    }
    if (ver === 4) {
      // VER CMD DSTPORT(2) DSTIP(4) USERID\0 [HOST\0 for SOCKS4a]
      if (buf.length < 9) return { need: true };
      const userEnd = buf.indexOf(0, 8);
      if (userEnd < 0) return { need: true };
      const cmd = buf[1];
      const port = buf.readUInt16BE(2);
      const ip = buf.subarray(4, 8);
      const is4a = ip[0] === 0 && ip[1] === 0 && ip[2] === 0 && ip[3] !== 0;
      if (!is4a) {
        return { kind: "request4", cmd, port, host: [...ip].join("."), used: userEnd + 1 };
      }
      const hostEnd = buf.indexOf(0, userEnd + 1);
      if (hostEnd < 0) return { need: true };
      const host = buf.subarray(userEnd + 1, hostEnd).toString("latin1");
      return { kind: "request4", cmd, port, host, used: hostEnd + 1 };
    }
    return { kind: "bad", reason: `unknown SOCKS version ${ver}` };
  }
  // stage === "request": VER CMD RSV ATYP DST.ADDR DST.PORT
  if (buf.length < 4) return { need: true };
  if (buf[0] !== 5) return { kind: "bad", reason: `bad SOCKS5 request version ${buf[0]}` };
  const cmd = buf[1];
  const atyp = buf[3];
  let host;
  let end;
  if (atyp === 0x01) {
    end = 4 + 4;
    if (buf.length < end + 2) return { need: true };
    host = [...buf.subarray(4, 8)].join(".");
  } else if (atyp === 0x04) {
    end = 4 + 16;
    if (buf.length < end + 2) return { need: true };
    const parts = [];
    for (let i = 4; i < 20; i += 2) parts.push(buf.readUInt16BE(i).toString(16));
    host = parts.join(":");
  } else if (atyp === 0x03) {
    if (buf.length < 5) return { need: true };
    const len = buf[4];
    end = 5 + len;
    if (buf.length < end + 2) return { need: true };
    host = buf.subarray(5, end).toString("latin1");
  } else {
    return { kind: "request5", cmd, atyp, used: buf.length };
  }
  return { kind: "request5", cmd, atyp, host, port: buf.readUInt16BE(end), used: end + 2 };
}

/**
 * Create the SOCKS listener (not listening): SOCKS5 with no authentication and CONNECT only, and
 * SOCKS4a CONNECT. Same host and resolved-address checks as the HTTP proxy for the mode; any port.
 * IP literals (SOCKS5 ATYP IPv4 / IPv6, plain SOCKS4) are only allowed in open-public mode, when
 * public.
 * @param {{ mode?: "open-public" | "allowlist"; allowHosts?: string[]; testHosts?: Record<string, string>; lookup?: (h: string) => Promise<{ address: string }[]>; log?: (msg: string) => void }} cfg
 */
export function createSocksProxy(cfg) {
  const opts = proxyOptions(cfg);
  const handshakeMs = cfg.handshakeMs ?? SOCKS_HANDSHAKE_MS;
  // Half-open both ways: a client that shuts down its write side (nc on end of input) still gets
  // the rest of the response.
  const server = createNetServer({ allowHalfOpen: true }, (socket) => {
    let buf = Buffer.alloc(0);
    let stage = "greeting";
    let busy = false;
    // Absolute deadline: the handshake (and any refusal reply) must be over by then, or the
    // socket is destroyed. Removed only once a tunnel is up. Plugins use no timers.
    const deadline = AbortSignal.timeout(handshakeMs);
    const onDeadline = () => {
      if (!busy) opts.log("egress refused socks: handshake timed out");
      socket.destroy();
    };
    deadline.addEventListener("abort", onDeadline, { once: true });
    socket.once("close", () => deadline.removeEventListener("abort", onDeadline));
    socket.on("error", () => socket.destroy());
    // The client gave up during the handshake: nothing left to answer.
    socket.on("end", () => {
      if (!busy) socket.destroy();
    });

    const reply5 = (code) => {
      // BND.ADDR 0.0.0.0, BND.PORT 0: clients do not use them for CONNECT.
      return Buffer.from([5, code, 0, 1, 0, 0, 0, 0, 0, 0]);
    };
    // After a refusal: stop parsing, send the reply and keep reading (discarding) until the client
    // closes, so unread input cannot turn the close into a reset that loses the reply.
    const finish = (bytes) => {
      busy = true;
      socket.end(bytes);
      socket.resume();
    };
    const refuse5 = (code, target, reason) => {
      opts.log(`egress refused socks5 ${q(target)}: ${reason}`);
      finish(reply5(code));
    };
    const refuse4 = (target, reason) => {
      opts.log(`egress refused socks4 ${q(target)}: ${reason}`);
      finish(Buffer.from([0, 0x5b, 0, 0, 0, 0, 0, 0]));
    };

    /** Check, resolve and connect; then reply and splice. */
    const open = async (version, host, port, rest) => {
      busy = true;
      socket.pause();
      const target = `${host}:${port}`;
      const isLiteral = isIP(normalizeHost(host)) !== 0;
      const deny = (code, reason) =>
        version === 5 ? refuse5(code, target, reason) : refuse4(target, reason);
      if (port < 1 || port > 65535) {
        deny(SOCKS5_NOT_ALLOWED, `port ${port} is not allowed.`);
        return;
      }
      if (isLiteral && opts.mode !== "open-public") {
        deny(SOCKS5_NOT_ALLOWED, "IP address destinations are not allowed; send a host name.");
        return;
      }
      let ips;
      try {
        ips = await resolveTarget(host, opts);
      } catch (e) {
        const status = e instanceof Refused ? e.status : 502;
        deny(status === 502 ? SOCKS5_HOST_UNREACHABLE : SOCKS5_NOT_ALLOWED, e.message);
        return;
      }
      let up;
      try {
        up = await connectAny(ips, port);
      } catch (e) {
        deny(socks5ConnectCode(e), `Cannot connect to ${target}.`);
        return;
      }
      if (socket.destroyed) {
        up.destroy();
        return;
      }
      deadline.removeEventListener("abort", onDeadline);
      socket.removeAllListeners("data");
      socket.write(version === 5 ? reply5(SOCKS5_OK) : Buffer.from([0, 0x5a, 0, 0, 0, 0, 0, 0]));
      if (rest.length > 0) up.write(rest);
      splice(socket, up);
      socket.resume();
    };

    const step = () => {
      while (!busy) {
        const p = parseSocks(buf, stage);
        if (p.need) {
          if (buf.length > SOCKS_HANDSHAKE_MAX) {
            opts.log("egress refused socks: handshake too long");
            socket.destroy();
          }
          return;
        }
        if (p.kind === "bad") {
          opts.log(`egress refused socks: ${p.reason}`);
          socket.destroy();
          return;
        }
        buf = buf.subarray(p.used);
        if (p.kind === "greeting5") {
          if (!p.methods.includes(0x00)) {
            opts.log("egress refused socks5: client offers no supported authentication method");
            finish(Buffer.from([5, 0xff]));
            return;
          }
          socket.write(Buffer.from([5, 0x00]));
          stage = "request";
          continue;
        }
        if (p.kind === "request4") {
          if (p.cmd !== 1) {
            refuse4(`${p.host}:${p.port}`, `SOCKS4 command ${p.cmd} is not supported.`);
            return;
          }
          void open(4, p.host, p.port, buf);
          return;
        }
        // request5
        if (p.atyp !== 0x01 && p.atyp !== 0x03 && p.atyp !== 0x04) {
          refuse5(SOCKS5_ATYP_UNSUPPORTED, "?", `address type ${p.atyp} is not supported.`);
          return;
        }
        if (p.cmd !== 1) {
          const name = p.cmd === 2 ? "BIND" : p.cmd === 3 ? "UDP ASSOCIATE" : `command ${p.cmd}`;
          refuse5(
            SOCKS5_CMD_UNSUPPORTED,
            `${p.host}:${p.port}`,
            `${name} is not supported; only CONNECT.`,
          );
          return;
        }
        void open(5, p.host, p.port, buf);
        return;
      }
    };

    socket.on("data", (chunk) => {
      // After a refusal (or while a target is being opened) input is discarded, never buffered.
      if (busy) return;
      buf = Buffer.concat([buf, chunk]);
      step();
    });
  });
  server.maxConnections = MAX_CONNECTIONS;
  return server;
}

/**
 * Container entry: read the config from the environment and listen. PORT (default 3128) for the
 * HTTP proxy; SOCKS_PORT (default 1080) for the SOCKS listener.
 * @returns {{ http: import("node:http").Server; socks: import("node:net").Server }}
 */
export function main(env = process.env) {
  const mode = env.MODE === undefined || env.MODE === "" ? "open-public" : env.MODE;
  if (!MODES.includes(mode)) {
    throw new Error(`Unknown MODE ${JSON.stringify(mode)}; expected open-public or allowlist.`);
  }
  const allowHosts = mode === "open-public" ? [] : JSON.parse(env.ALLOW_HOSTS ?? "[]");
  const testHosts = JSON.parse(env.CAPYBARA_EGRESS_TEST_HOSTS ?? "{}");
  const port = Number(env.PORT ?? 3128);
  const socksPort = Number(env.SOCKS_PORT ?? 1080);
  const http = createEgressProxy({ mode, allowHosts, testHosts });
  const hosts = mode === "open-public" ? "any public host" : allowHosts.join(", ") || "(none)";
  http.listen(port, () => {
    console.log(`egress proxy (${mode}) listening on ${port}; allow: ${hosts}`);
  });
  const socks = createSocksProxy({ mode, allowHosts, testHosts });
  socks.listen(socksPort, () => {
    console.log(`egress SOCKS proxy (${mode}) listening on ${socksPort}`);
  });
  const stop = () => {
    socks.close();
    http.close(() => process.exit(0));
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  return { http, socks };
}

if (import.meta.url === `file://${process.argv[1]}`) main();
