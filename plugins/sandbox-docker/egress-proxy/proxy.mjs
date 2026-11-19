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
// resolved IP against the SDK's closed address classes (CLOSED_CIDRS, a copy of plugin-sdk's
// OPEN_PUBLIC_DENIED_CIDRS: private, CGNAT, ULA, link-local and metadata, loopback, multicast,
// broadcast, unspecified, NAT64 and reserved) and the deployment's own ranges (DENIED_CIDRS, a JSON
// array of CIDRs from the plugin's `deniedCidrs` setting); one closed address refuses the name
// (this blocks DNS rebinding such as 10.0.0.1.nip.io). Then connect to an address that was checked,
// never resolving a second time; when the first cannot be reached the next checked one is tried.
// A name the system resolver answers with a fake IP (198.18.0.0/15, a fake-IP router or proxy) is
// resolved again through DNS-over-HTTPS (FAKE_IP_DNS, a copy of plugin-sdk's SANDBOX_FAKE_IP_DNS)
// and only that answer is judged and dialled; when encrypted DNS fails the name is refused and the
// fake address is never dialled.
//
// Test only: CAPYBARA_EGRESS_TEST_HOSTS (JSON object name -> IP) pins a name to an IP and exempts
// it from the private address check (in allowlist it must still be on the list; in open-public a
// pinned name is allowed). The plugin's deployment config cannot set it; only tests that call
// createDockerSandbox directly can.
//
// Dependency-free, Node >= 22. Error text reaches the model (through curl / pip output): English.
import { lookup as dnsLookup } from "node:dns/promises";
import { createServer, request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, connect, createServer as createNetServer, isIP } from "node:net";

// This file runs in the egress proxy container (not in the kernel process); the module-level
// objects below are constant tables, read-only after start.

/**
 * Every address closed in open-public mode, in both modes: the SDK's `OPEN_PUBLIC_DENIED_CIDRS`
 * (plugin-sdk `network-classes.ts`, computed from its address-class table: private, CGNAT, ULA,
 * link-local, metadata, loopback, multicast, broadcast, unspecified, NAT64 and reserved, with the
 * embedded IPv6 forms expanded), copied because this container carries no SDK.
 * `test/egress-proxy-classes.test.ts` keeps the copy equal to the SDK's list.
 */
// capybara:allow-module-state read-only constant table (egress proxy container, not the kernel)
export const CLOSED_CIDRS = Object.freeze([
  "0.0.0.0/8",
  "10.0.0.0/8",
  "100.64.0.0/10",
  "127.0.0.0/8",
  "168.63.129.16/32",
  "169.254.0.0/16",
  "172.16.0.0/12",
  "192.0.0.0/24",
  "192.0.2.0/24",
  "192.88.99.0/24",
  "192.168.0.0/16",
  "198.18.0.0/15",
  "198.51.100.0/24",
  "203.0.113.0/24",
  "224.0.0.0/3",
  "::/104",
  "::a00:0/104",
  "::6440:0/106",
  "::7f00:0/104",
  "::a83f:8110/128",
  "::a9fe:0/112",
  "::ac10:0/108",
  "::c000:0/120",
  "::c000:200/120",
  "::c058:6300/120",
  "::c0a8:0/112",
  "::c612:0/111",
  "::c633:6400/120",
  "::cb00:7100/120",
  "::e000:0/99",
  "::1:0:0/96",
  "::2:0:0/95",
  "::4:0:0/94",
  "::8:0:0/93",
  "::10:0:0/92",
  "::20:0:0/91",
  "::40:0:0/90",
  "::80:0:0/89",
  "::100:0:0/88",
  "::200:0:0/87",
  "::400:0:0/86",
  "::800:0:0/85",
  "::1000:0:0/84",
  "::2000:0:0/83",
  "::4000:0:0/82",
  "::8000:0:0/82",
  "::c000:0:0/83",
  "::e000:0:0/84",
  "::f000:0:0/85",
  "::f800:0:0/86",
  "::fc00:0:0/87",
  "::fe00:0:0/88",
  "::ff00:0:0/89",
  "::ff80:0:0/90",
  "::ffc0:0:0/91",
  "::ffe0:0:0/92",
  "::fff0:0:0/93",
  "::fff8:0:0/94",
  "::fffc:0:0/95",
  "::fffe:0:0/96",
  "::ffff:0:0/104",
  "::ffff:a00:0/104",
  "::ffff:6440:0/106",
  "::ffff:7f00:0/104",
  "::ffff:a83f:8110/128",
  "::ffff:a9fe:0/112",
  "::ffff:ac10:0/108",
  "::ffff:c000:0/120",
  "::ffff:c000:200/120",
  "::ffff:c058:6300/120",
  "::ffff:c0a8:0/112",
  "::ffff:c612:0/111",
  "::ffff:c633:6400/120",
  "::ffff:cb00:7100/120",
  "::ffff:e000:0/99",
  "::1:0:0:0/80",
  "::2:0:0:0/79",
  "::4:0:0:0/78",
  "::8:0:0:0/77",
  "::10:0:0:0/76",
  "::20:0:0:0/75",
  "::40:0:0:0/74",
  "::80:0:0:0/73",
  "::100:0:0:0/72",
  "::200:0:0:0/71",
  "::400:0:0:0/70",
  "::800:0:0:0/69",
  "::1000:0:0:0/68",
  "::2000:0:0:0/67",
  "::4000:0:0:0/66",
  "::8000:0:0:0/66",
  "::c000:0:0:0/67",
  "::e000:0:0:0/68",
  "::f000:0:0:0/69",
  "::f800:0:0:0/70",
  "::fc00:0:0:0/71",
  "::fe00:0:0:0/72",
  "::ff00:0:0:0/73",
  "::ff80:0:0:0/74",
  "::ffc0:0:0:0/75",
  "::ffe0:0:0:0/76",
  "::fff0:0:0:0/77",
  "::fff8:0:0:0/78",
  "::fffc:0:0:0/79",
  "::fffe:0:0:0/80",
  "::ffff:0:0:0/104",
  "::ffff:0:a00:0/104",
  "::ffff:0:6440:0/106",
  "::ffff:0:7f00:0/104",
  "::ffff:0:a83f:8110/128",
  "::ffff:0:a9fe:0/112",
  "::ffff:0:ac10:0/108",
  "::ffff:0:c000:0/120",
  "::ffff:0:c000:200/120",
  "::ffff:0:c058:6300/120",
  "::ffff:0:c0a8:0/112",
  "::ffff:0:c612:0/111",
  "::ffff:0:c633:6400/120",
  "::ffff:0:cb00:7100/120",
  "::ffff:0:e000:0/99",
  "::ffff:1:0:0/96",
  "::ffff:2:0:0/95",
  "::ffff:4:0:0/94",
  "::ffff:8:0:0/93",
  "::ffff:10:0:0/92",
  "::ffff:20:0:0/91",
  "::ffff:40:0:0/90",
  "::ffff:80:0:0/89",
  "::ffff:100:0:0/88",
  "::ffff:200:0:0/87",
  "::ffff:400:0:0/86",
  "::ffff:800:0:0/85",
  "::ffff:1000:0:0/84",
  "::ffff:2000:0:0/83",
  "::ffff:4000:0:0/82",
  "::ffff:8000:0:0/81",
  "0:0:0:1::/64",
  "0:0:0:2::/63",
  "0:0:0:4::/62",
  "0:0:0:8::/61",
  "0:0:0:10::/60",
  "0:0:0:20::/59",
  "0:0:0:40::/58",
  "0:0:0:80::/57",
  "0:0:0:100::/56",
  "0:0:0:200::/55",
  "0:0:0:400::/54",
  "0:0:0:800::/53",
  "0:0:0:1000::/52",
  "0:0:0:2000::/51",
  "0:0:0:4000::/50",
  "0:0:0:8000::/49",
  "0:0:1::/48",
  "0:0:2::/47",
  "0:0:4::/46",
  "0:0:8::/45",
  "0:0:10::/44",
  "0:0:20::/43",
  "0:0:40::/42",
  "0:0:80::/41",
  "0:0:100::/40",
  "0:0:200::/39",
  "0:0:400::/38",
  "0:0:800::/37",
  "0:0:1000::/36",
  "0:0:2000::/35",
  "0:0:4000::/34",
  "0:0:8000::/33",
  "0:1::/32",
  "0:2::/31",
  "0:4::/30",
  "0:8::/29",
  "0:10::/28",
  "0:20::/27",
  "0:40::/26",
  "0:80::/25",
  "0:100::/24",
  "0:200::/23",
  "0:400::/22",
  "0:800::/21",
  "0:1000::/20",
  "0:2000::/19",
  "0:4000::/18",
  "0:8000::/17",
  "1::/16",
  "2::/15",
  "4::/14",
  "8::/13",
  "10::/12",
  "20::/11",
  "40::/10",
  "80::/9",
  "100::/8",
  "200::/7",
  "400::/6",
  "800::/5",
  "1000::/4",
  "2001::/23",
  "2001:db8::/32",
  "2002::/24",
  "2002:a00::/24",
  "2002:6440::/26",
  "2002:7f00::/24",
  "2002:a83f:8110::/48",
  "2002:a9fe::/32",
  "2002:ac10::/28",
  "2002:c000::/40",
  "2002:c000:200::/40",
  "2002:c058:6300::/40",
  "2002:c0a8::/32",
  "2002:c612::/31",
  "2002:c633:6400::/40",
  "2002:cb00:7100::/40",
  "2002:e000::/19",
  "3fff::/20",
  "4000::/2",
  "8000::/1",
]);

// capybara:allow-module-state address table built once at start, read-only (proxy container)
const blocked = new BlockList();
for (const cidr of CLOSED_CIDRS) {
  const [address, prefix] = cidr.split("/");
  blocked.addSubnet(address, Number(prefix), address.includes(":") ? "ipv6" : "ipv4");
}

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
 * The deployment's extra denied ranges as a BlockList: each entry is an IPv4 or IPv6 CIDR
 * (`203.0.113.0/24`, `2001:db8::/32`; a single address is `/32` or `/128`). Throws on anything
 * else, so a bad list stops the proxy instead of leaving the ranges open.
 * @param {unknown} cidrs
 */
export function deniedList(cidrs) {
  if (!Array.isArray(cidrs)) throw new Error("The denied CIDRs must be a JSON array of strings.");
  const list = new BlockList();
  for (const c of cidrs) {
    const m = typeof c === "string" ? /^([^/]+)\/(\d{1,3})$/.exec(c) : null;
    const family = m ? isIP(m[1]) : 0;
    const prefix = m ? Number(m[2]) : -1;
    if (!m || family === 0 || prefix > (family === 4 ? 32 : 128)) {
      throw new Error(
        `Invalid denied CIDR ${JSON.stringify(c)}: expected an IPv4 or IPv6 CIDR such as 203.0.113.0/24.`,
      );
    }
    list.addSubnet(m[1], prefix, family === 4 ? "ipv4" : "ipv6");
  }
  return list;
}

/**
 * Whether connecting to a resolved IP is forbidden: {@link CLOSED_CIDRS} (the SDK's closed classes,
 * NAT64 closed whatever it embeds), plus `denied` (the deployment's ranges, {@link deniedList}),
 * which also judge the IPv4 address an IPv6 form embeds (IPv4-mapped ::ffff:0:0/96,
 * IPv4-compatible ::/96, SIIT ::ffff:0:0:0/96, NAT64 64:ff9b::/96, 6to4 2002::/16). Anything
 * unrecognised is forbidden.
 * @param {string} ip
 * @param {BlockList} [denied]
 */
export function isForbiddenAddress(ip, denied) {
  const family = isIP(ip);
  if (family === 4) return blocked.check(ip, "ipv4") || (denied?.check(ip, "ipv4") ?? false);
  if (family !== 6) return true;
  const g = v6Groups(ip);
  if (g === null) return true;
  const canonical = g.map((x) => x.toString(16)).join(":");
  if (blocked.check(canonical, "ipv6")) return true;
  if (denied === undefined) return false;
  if (denied.check(canonical, "ipv6")) return true;
  const zeros = (from, to) => g.slice(from, to).every((x) => x === 0);
  const v4 = (hi, lo) => denied.check(v4Of(hi, lo), "ipv4");
  if (zeros(0, 5) && (g[5] === 0xffff || g[5] === 0)) return v4(g[6], g[7]);
  if (zeros(0, 4) && g[4] === 0xffff && g[5] === 0) return v4(g[6], g[7]);
  if (g[0] === 0x64 && g[1] === 0xff9b && zeros(2, 6)) return v4(g[6], g[7]);
  if (g[0] === 0x2002) return v4(g[1], g[2]);
  return false;
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
 * @param {{ mode?: "open-public" | "allowlist"; allowHosts: string[]; testHosts: Record<string, string>; lookup: (h: string) => Promise<{ address: string }[]>; denied?: BlockList; encryptedDns?: { resolve(name: string): Promise<string[]> } }} opts
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
    if (isForbiddenAddress(h, opts.denied)) {
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
  // A fake-IP resolver's answer is never dialled: the name is resolved again through encrypted
  // DNS, and only that answer counts (judged like any resolved address below).
  if (isIP(h) === 0 && addrs.some((a) => isFakeIp(a.address))) {
    let real;
    try {
      if (!opts.encryptedDns) throw new Error("no encrypted DNS");
      real = await opts.encryptedDns.resolve(h);
    } catch {
      throw new Refused(403, FAKE_IP_REFUSAL);
    }
    if (real.length === 0) throw new Refused(502, `Cannot resolve ${h}.`);
    addrs = real.map((address) => ({ address }));
  }
  if (addrs.some((a) => isForbiddenAddress(a.address, opts.denied))) {
    throw new Refused(
      403,
      `Outbound access to ${h} is blocked: it resolves to a private or reserved address.`,
    );
  }
  return addrs.map((a) => a.address);
}

// ---- fake-IP resolvers: encrypted DNS --------------------------------------------------------

/**
 * The SDK's `SANDBOX_FAKE_IP_DNS` (plugin-sdk `network-classes.ts`), copied because this container
 * carries no SDK; `test/egress-proxy-classes.test.ts` keeps it equal. A router or local proxy in
 * fake-IP mode (OpenClash and the like) answers every name with an address in `fakeIpCidr`, which
 * is closed (reserved): such an answer is the signal to re-resolve the name through DNS-over-HTTPS
 * (RFC 8484, GET, wire format) at these IP-literal endpoints, TLS verified against the endpoint's IP
 * SAN, so no DNS is needed to reach them.
 */
// capybara:allow-module-state read-only constant (egress proxy container, not the kernel)
export const FAKE_IP_DNS = Object.freeze({
  fakeIpCidr: "198.18.0.0/15",
  endpoints: Object.freeze([
    "https://1.1.1.1/dns-query",
    "https://1.0.0.1/dns-query",
    "https://8.8.8.8/dns-query",
    "https://8.8.4.4/dns-query",
  ]),
  timeoutMs: 5000,
  cacheTtlCapSeconds: 300,
  cacheMaxNames: 256,
});

/** The refusal when the resolver gave a fake IP and encrypted DNS did not answer. */
export const FAKE_IP_REFUSAL =
  "The network's DNS resolver answers with fake IPs (198.18.0.0/15, a fake-IP resolver such as a router's proxy) and encrypted DNS did not answer; the fake address is never dialled.";

// capybara:allow-module-state address table built once at start, read-only (proxy container)
const fakeIpRange = new BlockList();
{
  const [address, prefix] = FAKE_IP_DNS.fakeIpCidr.split("/");
  fakeIpRange.addSubnet(address, Number(prefix), "ipv4");
}

/** Whether a resolved address is a fake-IP resolver's answer (IPv4, or IPv4-mapped IPv6). */
export function isFakeIp(address) {
  const ip = String(address).split("%")[0];
  if (isIP(ip) === 4) return fakeIpRange.check(ip, "ipv4");
  const g = isIP(ip) === 6 ? v6Groups(ip) : null;
  if (g === null || !g.slice(0, 5).every((x) => x === 0) || g[5] !== 0xffff) return false;
  return fakeIpRange.check(v4Of(g[6], g[7]), "ipv4");
}

/**
 * A recursive DNS query in wire format (ID 0, as RFC 8484 recommends) for `name` and `qtype`
 * (1 = A, 28 = AAAA).
 * @param {string} name
 * @param {1 | 28} qtype
 */
export function dnsQuery(name, qtype) {
  const parts = [Buffer.from([0, 0, 0x01, 0x00, 0, 1, 0, 0, 0, 0, 0, 0])];
  for (const label of name.replace(/\.$/, "").toLowerCase().split(".")) {
    const data = Buffer.from(label, "ascii");
    if (data.byteLength === 0 || data.byteLength > 63) throw new Error("Not a DNS name.");
    parts.push(Buffer.from([data.byteLength]), data);
  }
  parts.push(Buffer.from([0, 0, qtype, 0, 1]));
  return Buffer.concat(parts);
}

function skipName(data, at) {
  for (;;) {
    const length = data[at];
    if (length === undefined) throw new Error("Malformed DNS message.");
    if (length === 0) return at + 1;
    if ((length & 0xc0) === 0xc0) return at + 2;
    at += 1 + length;
  }
}

/**
 * The `qtype` records (class IN) of a DNS response and their smallest TTL (null without records).
 * An error response (other than a missing name) or a malformed message throws.
 * @param {Uint8Array} raw
 * @param {1 | 28} qtype
 */
export function dnsAnswers(raw, qtype) {
  const data = Buffer.from(raw);
  if (data.byteLength < 12) throw new Error("Malformed DNS message.");
  const flags = data.readUInt16BE(2);
  if ((flags & 0x8000) === 0 || ![0, 3].includes(flags & 0xf)) {
    throw new Error("DNS error response.");
  }
  const questions = data.readUInt16BE(4);
  const answers = data.readUInt16BE(6);
  let at = 12;
  for (let i = 0; i < questions; i++) at = skipName(data, at) + 4;
  const addresses = [];
  let ttl = null;
  for (let i = 0; i < answers; i++) {
    at = skipName(data, at);
    if (at + 10 > data.byteLength) throw new Error("Malformed DNS message.");
    const type = data.readUInt16BE(at);
    const cls = data.readUInt16BE(at + 2);
    const recordTtl = data.readUInt32BE(at + 4);
    const length = data.readUInt16BE(at + 8);
    at += 10;
    if (at + length > data.byteLength) throw new Error("Truncated DNS answer.");
    const record = data.subarray(at, at + length);
    at += length;
    if (cls !== 1 || type !== qtype || length !== (qtype === 1 ? 4 : 16)) continue;
    addresses.push(
      qtype === 1
        ? [...record].join(".")
        : Array.from({ length: 8 }, (_, g) => record.readUInt16BE(g * 2).toString(16)).join(":"),
    );
    ttl = ttl === null ? recordTtl : Math.min(ttl, recordTtl);
  }
  return { addresses: addresses.map(canonicalIp), ttl };
}

/** An address in Node's canonical text form (compressed IPv6). */
function canonicalIp(ip) {
  if (isIP(ip) !== 6) return ip;
  return new URL(`http://[${ip}]/`).hostname.slice(1, -1);
}

/** One DoH GET over HTTPS; `ca` replaces the trust store (tests). */
function dohFetch(url, query, timeoutMs, ca) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    target.searchParams.set("dns", Buffer.from(query).toString("base64url"));
    const req = httpsRequest(
      target,
      {
        method: "GET",
        headers: { accept: "application/dns-message" },
        timeout: timeoutMs,
        // one deadline for the whole exchange (connect, TLS, response)
        signal: AbortSignal.timeout(Math.max(1, Math.floor(timeoutMs))),
        ...(ca !== undefined && { ca }),
      },
      (res) => {
        const parts = [];
        let size = 0;
        res.on("data", (c) => {
          size += c.byteLength;
          if (size > 65_536) req.destroy(new Error("DoH answer too large."));
          else parts.push(c);
        });
        res.on("end", () =>
          res.statusCode === 200
            ? resolve(Buffer.concat(parts))
            : reject(new Error(`DoH answered ${res.statusCode}.`)),
        );
        res.on("error", reject);
      },
    );
    req.on("timeout", () => req.destroy(new Error("DoH timed out.")));
    req.on("error", reject);
    req.end();
  });
}

/**
 * Encrypted DNS for fake-IP networks ({@link FAKE_IP_DNS}): the endpoints in order, one deadline
 * per name covering A and AAAA at every endpoint, each endpoint getting an equal share of the time
 * left (its two queries share it). An answer is cached only when both queries succeeded at one
 * endpoint, for its smallest TTL capped at `cacheTtlCapSeconds`, for at most `cacheMaxNames` names
 * (the oldest goes first). `resolve` rejects with {@link FAKE_IP_REFUSAL} when no endpoint answers.
 * `endpoints`, `ca`, `fetch` and `clock` (milliseconds) are test seams.
 * @param {{ endpoints?: readonly string[]; ca?: string | Buffer; fetch?: (url: string, query: Uint8Array, timeoutMs: number) => Promise<Uint8Array>; clock?: () => number }} [seams]
 */
export function createEncryptedDns(seams = {}) {
  const endpoints = [...(seams.endpoints ?? FAKE_IP_DNS.endpoints)];
  const fetchDns = seams.fetch ?? ((url, query, ms) => dohFetch(url, query, ms, seams.ca));
  const clock = seams.clock ?? Date.now;
  /** name -> { expires, addresses }, in insertion order (the oldest first). */
  const cache = new Map();
  return {
    cacheSize: () => cache.size,
    /** @param {string} name */
    async resolve(name) {
      const key = name.toLowerCase().replace(/\.$/, "");
      const hit = cache.get(key);
      if (hit && hit.expires > clock()) return [...hit.addresses];
      const end = clock() + FAKE_IP_DNS.timeoutMs;
      for (let i = 0; i < endpoints.length; i++) {
        const shareEnd = clock() + (end - clock()) / (endpoints.length - i);
        try {
          const addresses = [];
          let ttl = FAKE_IP_DNS.cacheTtlCapSeconds;
          for (const qtype of [1, 28]) {
            const left = shareEnd - clock();
            if (left <= 0) throw new Error("The endpoint's share of the deadline ran out.");
            const answer = dnsAnswers(
              await fetchDns(endpoints[i], dnsQuery(key, qtype), left),
              qtype,
            );
            addresses.push(...answer.addresses);
            if (answer.ttl !== null) ttl = Math.min(ttl, answer.ttl);
          }
          cache.delete(key);
          while (cache.size >= FAKE_IP_DNS.cacheMaxNames) cache.delete(cache.keys().next().value);
          cache.set(key, { expires: clock() + ttl * 1000, addresses });
          return [...addresses];
        } catch {
          // the next endpoint, within what is left of the deadline
        }
      }
      throw new Error(FAKE_IP_REFUSAL);
    },
  };
}

/** Each address gets this long to connect before the next one is tried. */
const CONNECT_TIMEOUT_MS = 10_000;

/**
 * Connect to the checked addresses in turn; resolve with the first that connects, else reject with
 * the last error. Each attempt is bounded by AbortSignal.timeout (plugins use no timers).
 * @param {string[]} ips
 * @param {number} port
 * @param {number} [timeoutMs]
 * @param {typeof connect} [connectFn] the transport; tests inject a fake so the deadline does not
 *   depend on the host routing the address
 */
export function connectAny(ips, port, timeoutMs = CONNECT_TIMEOUT_MS, connectFn = connect) {
  return new Promise((resolve, reject) => {
    const attempt = (i, lastError) => {
      if (i >= ips.length) {
        reject(lastError ?? new Error("no address"));
        return;
      }
      const s = connectFn({ host: ips[i], port, allowHalfOpen: true });
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
    denied: deniedList(cfg.deniedCidrs ?? []),
    lookup: cfg.lookup ?? defaultLookup,
    encryptedDns: cfg.encryptedDns ?? createEncryptedDns(),
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
 * @param {{ mode?: "open-public" | "allowlist"; allowHosts?: string[]; deniedCidrs?: string[]; testHosts?: Record<string, string>; lookup?: (h: string) => Promise<{ address: string }[]>; encryptedDns?: { resolve(name: string): Promise<string[]> }; log?: (msg: string) => void }} cfg
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
 * @param {{ mode?: "open-public" | "allowlist"; allowHosts?: string[]; testHosts?: Record<string, string>; lookup?: (h: string) => Promise<{ address: string }[]>; encryptedDns?: { resolve(name: string): Promise<string[]> }; log?: (msg: string) => void }} cfg
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
 * HTTP proxy; SOCKS_PORT (default 1080) for the SOCKS listener; DENIED_CIDRS (JSON array, default
 * empty) for the deployment's extra denied ranges. An invalid list throws before listening.
 * @returns {{ http: import("node:http").Server; socks: import("node:net").Server }}
 */
export function main(env = process.env) {
  const mode = env.MODE === undefined || env.MODE === "" ? "open-public" : env.MODE;
  if (!MODES.includes(mode)) {
    throw new Error(`Unknown MODE ${JSON.stringify(mode)}; expected open-public or allowlist.`);
  }
  const allowHosts = mode === "open-public" ? [] : JSON.parse(env.ALLOW_HOSTS ?? "[]");
  const testHosts = JSON.parse(env.CAPYBARA_EGRESS_TEST_HOSTS ?? "{}");
  const deniedCidrs = JSON.parse(env.DENIED_CIDRS ?? "[]");
  if (!Array.isArray(deniedCidrs)) {
    throw new Error("DENIED_CIDRS must be a JSON array of CIDR strings.");
  }
  deniedList(deniedCidrs);
  const port = Number(env.PORT ?? 3128);
  const socksPort = Number(env.SOCKS_PORT ?? 1080);
  const http = createEgressProxy({ mode, allowHosts, deniedCidrs, testHosts });
  const hosts = mode === "open-public" ? "any public host" : allowHosts.join(", ") || "(none)";
  http.listen(port, () => {
    console.log(
      `egress proxy (${mode}) listening on ${port}; allow: ${hosts}; extra denied: ${deniedCidrs.join(", ") || "(none)"}`,
    );
  });
  const socks = createSocksProxy({ mode, allowHosts, deniedCidrs, testHosts });
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
