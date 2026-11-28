// Loopback port grants in the daemon: the host canonicalization the device's proxy applies before
// its loopback carve-out (so the per-tab check sees every spelling the proxy admits), and the file
// that keeps each conversation tree's granted ports across a restart of the service (a grant
// changes the service's network, which restarts it on some providers).

import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { isIP } from "node:net";
import { join } from "node:path";
import { LOOPBACK_MAX_PORTS_PER_SERVICE } from "@capybara-hq/plugin-sdk";

/** The longest a loopback port grant lives (the kernel's 24 hours). */
export const LOOPBACK_GRANT_MAX_MS = 24 * 60 * 60_000;

const stripBrackets = (h: string) => h.replace(/^\[(.*)\]$/, "$1");

/** `::ffff:a.b.c.d` (or its hex form) as the IPv4 address it connects to, else undefined. */
function mappedIPv4(v6: string): string | undefined {
  const dotted = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(v6);
  if (dotted?.[1] !== undefined) return dotted[1];
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(v6);
  if (hex?.[1] === undefined || hex[2] === undefined) return undefined;
  const hi = Number.parseInt(hex[1], 16);
  const lo = Number.parseInt(hex[2], 16);
  return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
}

/**
 * The host as the device's sandbox proxy canonicalizes it (sandbox-runtime `canonicalizeHost`):
 * WHATWG URL parsing (case, `127.1` and other inet_aton forms, IPv6 compression), an IPv4-mapped
 * IPv6 literal spelled as its IPv4 address, one trailing dot removed. Undefined when unparsable.
 */
export function canonicalHost(host: string): string | undefined {
  try {
    const bare = stripBrackets(host);
    const bracketed = isIP(bare) === 6 ? `[${bare}]` : bare;
    const out = stripBrackets(new URL(`http://${bracketed}/`).hostname);
    return isIP(out) === 6 ? (mappedIPv4(out) ?? out) : out.replace(/\.$/, "");
  } catch {
    return undefined;
  }
}

/**
 * The loopback grant host (`127.0.0.1`, `[::1]` or `localhost`) a URL host reaches through the
 * proxy's carve-out, or undefined for any other host: `localhost.`, `LOCALHOST`, `127.1`,
 * `[::ffff:127.0.0.1]` are all checked as the grant host they canonicalize to.
 */
export function loopbackGrantHostOf(host: string): string | undefined {
  const c = canonicalHost(host)?.toLowerCase();
  if (c === "127.0.0.1" || c === "localhost") return c;
  if (c === "::1") return "[::1]";
  return undefined;
}

interface SavedRoot {
  root: string;
  ports: number[];
  /** When the kernel last sent this set (the daemon's clock, ms). */
  at: number;
}

/**
 * `<state>/loopback-ports.json`: each tree's ports as the kernel last sent them. A set older than a
 * grant's longest life is dropped on load (none of its grants can still be live); a newer one is
 * replaced by the next request that carries the tree's set.
 */
export class LoopbackFile {
  private readonly file: string;

  constructor(stateDir: string) {
    this.file = join(stateDir, "loopback-ports.json");
  }

  /** The saved sets that may still hold live grants; an unreadable file is none. */
  load(now: number): Map<string, { ports: ReadonlySet<number>; at: number }> {
    const out = new Map<string, { ports: ReadonlySet<number>; at: number }>();
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(this.file, "utf8"));
    } catch {
      return out;
    }
    const roots = (raw as { roots?: unknown } | null)?.roots;
    if (!Array.isArray(roots)) return out;
    for (const r of roots as Partial<SavedRoot>[]) {
      if (typeof r?.root !== "string" || r.root === "" || typeof r.at !== "number") continue;
      if (now - r.at > LOOPBACK_GRANT_MAX_MS || r.at > now + 60_000) continue;
      if (!Array.isArray(r.ports) || r.ports.length > LOOPBACK_MAX_PORTS_PER_SERVICE) continue;
      const ports = r.ports.filter((p): p is number => Number.isInteger(p) && p >= 1 && p <= 65535);
      out.set(r.root, { ports: new Set(ports), at: r.at });
    }
    return out;
  }

  /** Writes the sets (atomically: a crash leaves the old file or the new one). */
  save(sets: ReadonlyMap<string, { ports: ReadonlySet<number>; at: number }>): void {
    const roots: SavedRoot[] = [...sets].map(([root, s]) => ({
      root,
      ports: [...s.ports].sort((a, b) => a - b),
      at: s.at,
    }));
    const tmp = `${this.file}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify({ version: 1, roots }), { mode: 0o600 });
      renameSync(tmp, this.file);
    } catch {
      // a full or read-only state directory: the sets live in memory until the next request
    }
  }
}
