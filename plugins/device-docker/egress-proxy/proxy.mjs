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
// In-place list changes (allowlist only): a control socket (CONTROL_SOCKET, default
// /run/egress/control.sock, a Unix socket on a tmpfs only this container reaches; the sandbox
// reaches the proxy only on its TCP ports) takes a new host list and denied ranges from
// `node proxy.mjs control apply` (one JSON line on stdin), started by the provider through the
// Docker exec API. The proxy writes the list to CONFIG_FILE (default /config/allow.json, on the
// instance's own volume), swaps it in, closes every admitted connection the new list no longer
// covers (resolving, connecting or tunnelling), and only then replies with the list's digest. At
// start a valid CONFIG_FILE wins over MODE / ALLOW_HOSTS (it is exactly the list last applied);
// an unreadable one stops the proxy (never a fall back to the create-time list, which may be
// wider); its denied ranges join DENIED_CIDRS. `control status` prints the list in force.
//
// Test only: CAPYBARA_EGRESS_TEST_HOSTS (JSON object name -> IP) pins a name to an IP and exempts
// it from the private address check (in allowlist it must still be on the list; in open-public a
// pinned name is allowed). CAPYBARA_EGRESS_TEST_RESOLVE (JSON object name -> IP) answers a name
// as a resolver would, with no exemption: the answer is judged like any resolved address (a name
// resolving into a closed class). The plugin's deployment config can set neither; only tests that
// call createDockerSandbox directly can.
//
// Dependency-free, Node >= 22. Error text reaches the model (through curl / pip output): English.
import { createHash } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import { chmodSync, readFileSync, rmSync } from "node:fs";
import { open as openFile, rename } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, connect, createServer as createNetServer, isIP } from "node:net";
import { dirname } from "node:path";

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
  return denied === undefined ? false : inDenied(ip, denied);
}

/**
 * Whether `ip` falls in the deployment's denied ranges only (`denied`, {@link deniedList}), the
 * embedded IPv4 of the IPv6 forms {@link isForbiddenAddress} names included. Unparseable is denied.
 * @param {string} ip
 * @param {BlockList} denied
 */
export function inDenied(ip, denied) {
  const family = isIP(ip);
  if (family === 4) return denied.check(ip, "ipv4");
  if (family !== 6) return true;
  const g = v6Groups(ip);
  if (g === null) return true;
  const canonical = g.map((x) => x.toString(16)).join(":");
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

// ---- the list in force, the connection registry and in-place changes ---------------------------

/**
 * Why `h` is not a valid allowlist entry (null when it is): plugin-sdk's validateAllowHost (an
 * exact lowercase public name, or `*.` followed by one).
 * @param {unknown} h
 */
export function allowHostError(h) {
  if (typeof h !== "string" || h.length === 0) return "host must be a non-empty string";
  if (h.length > 253) return "host must be at most 253 characters";
  const name = h.startsWith("*.") ? h.slice(2) : h;
  return publicNameError(name);
}

const sortedUnique = (list) => [...new Set(list)].sort();

/**
 * The digest of a list (pure): sha256 over the mode, the hosts and the denied ranges, each list
 * sorted and without duplicates. The provider computes the same (src/provider.ts
 * `egressAllowDigest`) and accepts an in-place change only when the proxy answers with it.
 * @param {{ mode: string; hosts: readonly string[]; deniedCidrs: readonly string[] }} c
 */
export function allowDigest(c) {
  const canonical = JSON.stringify({
    mode: c.mode,
    hosts: sortedUnique(c.hosts),
    deniedCidrs: sortedUnique(c.deniedCidrs),
  });
  return createHash("sha256").update(canonical).digest("hex");
}

/**
 * Validates a list sent through the control socket (or read from the config file): an allowlist
 * with at least one host, every host valid, every denied range a CIDR. One bad entry refuses the
 * whole list. Returns the normalized config.
 * @param {unknown} raw
 * @returns {{ mode: "allowlist"; hosts: string[]; deniedCidrs: string[] }}
 */
export function parseAllowConfig(raw) {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("The egress list must be a JSON object { mode, hosts, deniedCidrs }.");
  }
  if (raw.mode !== "allowlist") {
    throw new Error('Only an allowlist ("mode": "allowlist") is changed in place.');
  }
  if (!Array.isArray(raw.hosts) || raw.hosts.length === 0) {
    throw new Error("The allowlist needs at least one host (an empty list is no network).");
  }
  for (const h of raw.hosts) {
    const err = allowHostError(h);
    if (err !== null) throw new Error(`Invalid allowlist host ${q(h)}: ${err}.`);
  }
  const deniedCidrs = raw.deniedCidrs ?? [];
  deniedList(deniedCidrs);
  return { mode: "allowlist", hosts: [...raw.hosts], deniedCidrs: [...deniedCidrs] };
}

/** Writes `data` to `file` through a temp file, fsync and rename (a crash leaves the old or the new file). */
async function writeAtomic(file, data) {
  const tmp = `${file}.tmp`;
  const fh = await openFile(tmp, "w", 0o600);
  try {
    await fh.writeFile(data);
    await fh.sync();
  } finally {
    await fh.close();
  }
  await rename(tmp, file);
  // the rename itself is durable once the directory is synced (best effort)
  const dir = await openFile(dirname(file), "r").catch(() => null);
  if (dir !== null) {
    await dir.sync().catch(() => undefined);
    await dir.close();
  }
}

/**
 * The proxy's mutable state, shared by the HTTP and SOCKS listeners and the control socket of one
 * process: the list in force (`policy`, replaced as a whole, so a check sees the old or the new
 * list, never a mix) and the registry of admitted connections. An entry is registered when a
 * request names its target, before name resolution, and leaves when its client side closes; it
 * records the normalized host and, once connected, the upstream address. `apply` closes every
 * entry the new list does not cover; a connection still resolving or connecting re-checks the list
 * in force when its upstream connects (`keep`).
 * @param {{ mode?: "open-public" | "allowlist"; allowHosts?: string[]; deniedCidrs?: string[]; testHosts?: Record<string, string>; configFile?: string; log?: (msg: string) => void }} cfg
 */
export function createEgressState(cfg = {}) {
  const mode = cfg.mode ?? "open-public";
  if (!MODES.includes(mode)) throw new Error(`Unknown egress proxy mode ${JSON.stringify(mode)}.`);
  const testHosts = cfg.testHosts ?? {};
  const log = cfg.log ?? defaultLog;
  const makePolicy = (m, hosts, deniedCidrs) =>
    Object.freeze({
      mode: m,
      allowHosts: Object.freeze(hosts.map((h) => h.toLowerCase())),
      deniedCidrs: Object.freeze([...deniedCidrs]),
      denied: deniedList(deniedCidrs),
      digest: allowDigest({ mode: m, hosts: hosts.map((h) => h.toLowerCase()), deniedCidrs }),
    });
  let policy = makePolicy(
    mode,
    mode === "open-public" ? [] : (cfg.allowHosts ?? []),
    cfg.deniedCidrs ?? [],
  );
  /** @type {Set<{ host: string; pinned: boolean; ip: string | null; revoked: boolean; sockets: Set<import("node:net").Socket> }>} */
  const registry = new Set();
  /** Applies run one after another (a later one waits for the earlier to finish). */
  let chain = Promise.resolve();

  const covers = (entry, p) => {
    if (p.mode === "allowlist" && !hostAllowed(entry.host, p.allowHosts)) return false;
    // pinned test names are exempt from the address checks, as at admission
    // (the closed classes were checked at admission and do not change; the denied ranges can)
    if (entry.ip !== null && !entry.pinned && inDenied(entry.ip, p.denied)) return false;
    return true;
  };
  const revoke = (entry) => {
    entry.revoked = true;
    registry.delete(entry);
    // a reset drops what is still queued for sending (written under the old list)
    for (const s of entry.sockets) {
      try {
        if (typeof s.resetAndDestroy === "function" && !s.destroyed && !s.connecting) {
          s.resetAndDestroy();
        } else s.destroy();
      } catch {
        s.destroy();
      }
    }
  };

  return {
    get policy() {
      return policy;
    },
    testHosts,
    /** Admitted connections not yet closed (tests). */
    get connections() {
      return registry.size;
    },
    /**
     * Registers a request for `host` (before resolution) with its client side `client`; the entry
     * leaves the registry when `closed` emits "close" (the client socket, or an HTTP response).
     * @param {string} host
     * @param {import("node:net").Socket} client
     * @param {import("node:events").EventEmitter} [closed]
     */
    admit(host, client, closed = client) {
      const h = normalizeHost(host);
      const entry = {
        host: h,
        pinned: Object.hasOwn(testHosts, h),
        ip: null,
        revoked: false,
        sockets: new Set([client]),
      };
      registry.add(entry);
      closed.once("close", () => registry.delete(entry));
      return entry;
    },
    /**
     * Records the upstream socket of an admitted entry once it connected; false when the entry was
     * revoked or the list in force no longer covers it (then the caller drops `up`).
     * @param {ReturnType<this["admit"]>} entry
     * @param {import("node:net").Socket} up
     */
    keep(entry, up) {
      entry.ip = up.remoteAddress ?? null;
      if (entry.revoked || !registry.has(entry) || !covers(entry, policy)) {
        // the caller drops `up` and refuses; the client side stays to receive the refusal
        registry.delete(entry);
        return false;
      }
      entry.sockets.add(up);
      return true;
    },
    /**
     * Puts a new list in force (allowlist proxies only): validate, write the config file, swap,
     * close every connection the new list does not cover, then resolve with the digest. A list
     * with the digest already in force resolves at once. `ifDigest` (when given) makes it a compare
     * and swap: refused unless the list in force has that digest, so an apply from a caller that
     * read the proxy's list before another caller changed it never lands after that change. This
     * narrows, but does not close, the stale-holder race: a caller that lost its lease without
     * noticing and read the list after the newer change still applies; only a fencing token from
     * the kernel would close it, and `update` carries none.
     * @param {unknown} raw
     * @param {string} [ifDigest]
     */
    apply(raw, ifDigest) {
      const run = chain.then(async () => {
        const next = parseAllowConfig(raw);
        if (policy.mode !== "allowlist") {
          throw new Error("This proxy runs open-public: only an allowlist proxy takes a new list.");
        }
        const digest = allowDigest(next);
        if (digest === policy.digest) return digest;
        if (ifDigest !== undefined && ifDigest !== policy.digest) {
          throw new Error("The list in force changed since it was read; nothing was applied.");
        }
        if (cfg.configFile !== undefined) {
          await writeAtomic(cfg.configFile, `${JSON.stringify({ ...next, digest })}\n`);
        }
        policy = makePolicy("allowlist", next.hosts, next.deniedCidrs);
        let closed = 0;
        for (const entry of [...registry]) {
          if (!covers(entry, policy)) {
            revoke(entry);
            closed++;
          }
        }
        log(
          `egress allowlist changed: allow ${next.hosts.join(", ")}; extra denied: ${next.deniedCidrs.join(", ") || "(none)"}; closed ${closed} connection(s)`,
        );
        return digest;
      });
      chain = run.catch(() => undefined);
      return run;
    },
  };
}

/**
 * Reads the config file a previous `apply` wrote: null when there is none; throws when it exists
 * but cannot be read or is invalid (the proxy must not start on a guess).
 * @param {string} file
 */
export function readAllowFile(file) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (e) {
    if (e?.code === "ENOENT") return null;
    throw new Error(`Cannot read the egress list ${file}: ${e?.message ?? e}`);
  }
  try {
    return parseAllowConfig(JSON.parse(text));
  } catch (e) {
    throw new Error(`The egress list ${file} is invalid: ${e?.message ?? e}`);
  }
}

/** The longest control request line. */
const CONTROL_MAX_BYTES = 1024 * 1024;
/** A control exchange must finish within this time. */
const CONTROL_DEADLINE_MS = 30_000;

/**
 * The control listener (not listening): one JSON request line per connection,
 * `{"op":"apply","config":{...}}` or `{"op":"status"}`, answered with one JSON line
 * `{"ok":true,"digest":...}` (status adds `mode` and `hosts`) or `{"ok":false,"error":...}`.
 * @param {ReturnType<typeof createEgressState>} state
 */
export function createControlServer(state) {
  return createNetServer((sock) => {
    let buf = "";
    let done = false;
    const deadline = AbortSignal.timeout(CONTROL_DEADLINE_MS);
    const onDeadline = () => sock.destroy();
    deadline.addEventListener("abort", onDeadline, { once: true });
    sock.once("close", () => deadline.removeEventListener("abort", onDeadline));
    sock.on("error", () => sock.destroy());
    sock.setEncoding("utf8");
    const reply = (body) => sock.end(`${JSON.stringify(body)}\n`);
    const handle = async (line) => {
      let req;
      try {
        req = JSON.parse(line);
      } catch {
        reply({ ok: false, error: "The control request is not JSON." });
        return;
      }
      if (req?.op === "status") {
        const p = state.policy;
        reply({
          ok: true,
          mode: p.mode,
          hosts: [...p.allowHosts],
          digest: p.digest,
          connections: state.connections,
        });
        return;
      }
      if (req?.op !== "apply") {
        reply({ ok: false, error: "Unknown control operation." });
        return;
      }
      try {
        const ifDigest = typeof req.ifDigest === "string" ? req.ifDigest : undefined;
        reply({ ok: true, digest: await state.apply(req.config, ifDigest) });
      } catch (e) {
        reply({ ok: false, error: String(e?.message ?? e) });
      }
    };
    sock.on("data", (chunk) => {
      if (done) return;
      buf += chunk;
      const nl = buf.indexOf("\n");
      if (nl >= 0) {
        done = true;
        void handle(buf.slice(0, nl));
      } else if (buf.length > CONTROL_MAX_BYTES) {
        done = true;
        reply({ ok: false, error: "The control request is too long." });
      }
    });
  });
}

/**
 * Sends one control request to the socket at `path` and resolves with the parsed reply.
 * @param {string} path
 * @param {unknown} request
 */
export function controlRequest(path, request) {
  return new Promise((resolve, reject) => {
    const s = connect(path);
    let buf = "";
    const deadline = AbortSignal.timeout(CONTROL_DEADLINE_MS);
    const onDeadline = () => s.destroy(new Error("The egress proxy control request timed out."));
    deadline.addEventListener("abort", onDeadline, { once: true });
    s.setEncoding("utf8");
    s.on("data", (c) => {
      buf += c;
    });
    s.on("error", (e) => {
      deadline.removeEventListener("abort", onDeadline);
      reject(e);
    });
    s.on("end", () => {
      deadline.removeEventListener("abort", onDeadline);
      try {
        resolve(JSON.parse(buf));
      } catch {
        reject(new Error("The egress proxy sent no valid control reply."));
      }
    });
    s.write(`${JSON.stringify(request)}\n`);
  });
}

/** Reads one line from a stream (at most CONTROL_MAX_BYTES). */
function readLine(stream) {
  return new Promise((resolve, reject) => {
    let buf = "";
    stream.setEncoding("utf8");
    const onData = (c) => {
      buf += c;
      const nl = buf.indexOf("\n");
      if (nl >= 0 || buf.length > CONTROL_MAX_BYTES) {
        stream.off("data", onData);
        stream.pause();
        if (nl < 0) reject(new Error("The control input is too long."));
        else resolve(buf.slice(0, nl));
      }
    };
    stream.on("data", onData);
    stream.once("end", () => resolve(buf));
    stream.once("error", reject);
  });
}

/**
 * The control client (`node proxy.mjs control apply|status`): `apply` reads the config as one JSON
 * line on stdin. Prints the reply as one JSON line; exit code 0 only when the proxy answered ok.
 * @param {string[]} args
 * @param {Record<string, string | undefined>} env
 */
async function controlMain(args, env) {
  const path = env.CONTROL_SOCKET || DEFAULT_CONTROL_SOCKET;
  const op = args[0];
  try {
    if (op !== "apply" && op !== "status") throw new Error("usage: control apply|status");
    // apply reads `{ config, ifDigest? }` as one JSON line on stdin
    const request = op === "apply" ? { op, ...JSON.parse(await readLine(process.stdin)) } : { op };
    const reply = await controlRequest(path, request);
    process.stdout.write(`${JSON.stringify(reply)}\n`);
    process.exitCode = reply?.ok === true ? 0 : 1;
  } catch (e) {
    process.stderr.write(`egress control failed: ${e?.message ?? e}\n`);
    process.exitCode = 1;
  }
  process.stdin.destroy();
}

const DEFAULT_CONTROL_SOCKET = "/run/egress/control.sock";
const DEFAULT_CONFIG_FILE = "/config/allow.json";

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

/**
 * Shared options for both listeners: the state (`cfg.state`, shared with the other listener and the
 * control socket; else one of their own from `cfg`) and the resolver seams. `check()` is what
 * `resolveTarget` needs, with the list in force at the moment of the call.
 */
function proxyOptions(cfg) {
  const state = cfg.state ?? createEgressState(cfg);
  const base = {
    connect: cfg.connect ?? connect,
    testHosts: state.testHosts,
    lookup: cfg.lookup ?? defaultLookup,
    encryptedDns: cfg.encryptedDns ?? createEncryptedDns(),
    log: cfg.log ?? defaultLog,
  };
  return {
    ...base,
    state,
    check() {
      const p = state.policy;
      return { ...base, mode: p.mode, allowHosts: p.allowHosts, denied: p.denied };
    },
  };
}

/** The refusal when the list changed while a connection was being opened. */
const CHANGED_REFUSAL = (h) =>
  `Outbound access to ${h} is blocked: the sandbox egress allowlist changed while connecting.`;

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
    // registered before resolution: a list change closes it whatever stage it is in
    const entry = opts.state.admit(url.hostname, req.socket, res);
    let sock;
    try {
      const ips = await resolveTarget(url.hostname, opts.check());
      if (entry.revoked) throw new Refused(403, CHANGED_REFUSAL(normalizeHost(url.hostname)));
      sock = await connectAny(ips, port, undefined, opts.connect).catch(() => {
        throw new Refused(502, `Cannot connect to ${url.host}.`);
      });
    } catch (e) {
      refuse(res, e, url.host);
      return;
    }
    if (!opts.state.keep(entry, sock)) {
      sock.destroy();
      refuse(res, new Refused(403, CHANGED_REFUSAL(normalizeHost(url.hostname))), url.host);
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
    // the client went away (also after its request body was complete): drop the upstream too
    res.once("close", () => sock.destroy());
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
    const entry = opts.state.admit(hp[0], socket);
    let ips;
    try {
      ips = await resolveTarget(hp[0], opts.check());
    } catch (e) {
      fail(e instanceof Refused ? e.status : 502, e instanceof Refused ? e.message : "Failed.");
      return;
    }
    if (entry.revoked) return;
    let up;
    try {
      up = await connectAny(ips, hp[1], undefined, opts.connect);
    } catch {
      fail(502, `Cannot connect to ${hp[0]}:${hp[1]}.`);
      return;
    }
    if (!opts.state.keep(entry, up)) {
      up.destroy();
      fail(403, CHANGED_REFUSAL(normalizeHost(hp[0])));
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
      if (isLiteral && opts.state.policy.mode !== "open-public") {
        deny(SOCKS5_NOT_ALLOWED, "IP address destinations are not allowed; send a host name.");
        return;
      }
      const entry = opts.state.admit(host, socket);
      let ips;
      try {
        ips = await resolveTarget(host, opts.check());
      } catch (e) {
        const status = e instanceof Refused ? e.status : 502;
        deny(status === 502 ? SOCKS5_HOST_UNREACHABLE : SOCKS5_NOT_ALLOWED, e.message);
        return;
      }
      if (entry.revoked) return;
      let up;
      try {
        up = await connectAny(ips, port, undefined, opts.connect);
      } catch (e) {
        deny(socks5ConnectCode(e), `Cannot connect to ${target}.`);
        return;
      }
      if (socket.destroyed) {
        up.destroy();
        return;
      }
      if (!opts.state.keep(entry, up)) {
        up.destroy();
        deny(SOCKS5_NOT_ALLOWED, CHANGED_REFUSAL(normalizeHost(host)));
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
 * Container entry: read the config and listen. PORT (default 3128) for the HTTP proxy; SOCKS_PORT
 * (default 1080) for the SOCKS listener; DENIED_CIDRS (JSON array, default empty) for the
 * deployment's extra denied ranges; CONFIG_FILE (default /config/allow.json) for the list a
 * previous control `apply` wrote, which wins over MODE / ALLOW_HOSTS when present (its denied ranges
 * join DENIED_CIDRS); CONTROL_SOCKET (default /run/egress/control.sock) for the control listener,
 * which listens before the proxy ports do; when it cannot listen the proxy serves without it, and
in-place changes then fail (status / apply calls fail, so the provider recreates the instance). An
 * invalid list or config file throws before listening.
 * @returns {{ http: import("node:http").Server; socks: import("node:net").Server; control: import("node:net").Server; state: ReturnType<typeof createEgressState> }}
 */
export function main(env = process.env) {
  let mode = env.MODE === undefined || env.MODE === "" ? "open-public" : env.MODE;
  if (!MODES.includes(mode)) {
    throw new Error(`Unknown MODE ${JSON.stringify(mode)}; expected open-public or allowlist.`);
  }
  let allowHosts = mode === "open-public" ? [] : JSON.parse(env.ALLOW_HOSTS ?? "[]");
  const testHosts = JSON.parse(env.CAPYBARA_EGRESS_TEST_HOSTS ?? "{}");
  const testResolve = JSON.parse(env.CAPYBARA_EGRESS_TEST_RESOLVE ?? "{}");
  /** @param {string} h */
  const lookup = (h) =>
    Object.hasOwn(testResolve, h)
      ? Promise.resolve([{ address: String(testResolve[h]) }])
      : defaultLookup(h);
  let deniedCidrs = JSON.parse(env.DENIED_CIDRS ?? "[]");
  if (!Array.isArray(deniedCidrs)) {
    throw new Error("DENIED_CIDRS must be a JSON array of CIDR strings.");
  }
  deniedList(deniedCidrs);
  const configFile = env.CONFIG_FILE || DEFAULT_CONFIG_FILE;
  const saved = readAllowFile(configFile);
  if (saved !== null) {
    // exactly the list last applied; the denied ranges only ever add up
    mode = saved.mode;
    allowHosts = saved.hosts;
    deniedCidrs = [...new Set([...deniedCidrs, ...saved.deniedCidrs])];
  }
  const state = createEgressState({ mode, allowHosts, deniedCidrs, testHosts, configFile });
  const port = Number(env.PORT ?? 3128);
  const socksPort = Number(env.SOCKS_PORT ?? 1080);
  const http = createEgressProxy({ state, lookup });
  const socks = createSocksProxy({ state, lookup });
  const control = createControlServer(state);
  const controlPath = env.CONTROL_SOCKET || DEFAULT_CONTROL_SOCKET;
  let portsStarted = false;
  const listenPorts = () => {
    if (portsStarted) return;
    portsStarted = true;
    const hosts = mode === "open-public" ? "any public host" : allowHosts.join(", ") || "(none)";
    http.listen(port, () => {
      console.log(
        `egress proxy (${mode}) listening on ${port}; allow: ${hosts}; extra denied: ${deniedCidrs.join(", ") || "(none)"}${saved !== null ? ` (from ${configFile})` : ""}`,
      );
    });
    socks.listen(socksPort, () => {
      console.log(`egress SOCKS proxy (${mode}) listening on ${socksPort}`);
    });
  };
  // Without its tmpfs (a proxy started by an earlier plugin version's create) the control cannot
  // listen: the proxy then runs without it, and an in-place change fails (the provider recreates).
  control.on("error", (e) => {
    console.warn(`egress control socket unavailable (${e.message}); in-place list changes are off`);
    listenPorts();
  });
  try {
    rmSync(controlPath, { force: true });
  } catch {
    // a read-only location: listen reports it
  }
  control.listen(controlPath, () => {
    // only this container's user reaches it (the directory is 0700 as well)
    chmodSync(controlPath, 0o600);
    listenPorts();
  });
  const stop = () => {
    control.close();
    socks.close();
    http.close(() => process.exit(0));
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  return { http, socks, control, state };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (process.argv[2] === "control") void controlMain(process.argv.slice(3), process.env);
  else main();
}
