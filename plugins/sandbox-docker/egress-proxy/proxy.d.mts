import type { Server } from "node:http";
import type { BlockList, Server as NetServer, Socket } from "node:net";

/** open-public: any public host, any port, SOCKS; allowlist: listed hosts, any port, SOCKS. */
export type EgressProxyMode = "open-public" | "allowlist";

export interface EgressProxyConfig {
  /** Default "open-public". */
  mode?: EgressProxyMode;
  /** Allowed host names (allowlist); ignored in open-public mode. */
  allowHosts?: string[];
  /** The deployment's extra denied ranges (IPv4 / IPv6 CIDRs), refused in every mode. */
  deniedCidrs?: string[];
  /** Test only: host name -> pinned IP (exempt from the private address check; allowlist still needs the list). */
  testHosts?: Record<string, string>;
  lookup?: (host: string) => Promise<{ address: string }[]>;
  /** Encrypted DNS for fake-IP answers; default {@link createEncryptedDns} with the SDK's endpoints. */
  encryptedDns?: EncryptedDns;
  /** Receives one English line per refusal; default console.warn. */
  log?: (msg: string) => void;
}

export const MODES: readonly EgressProxyMode[];
/** A copy of plugin-sdk's OPEN_PUBLIC_DENIED_CIDRS: every closed address, in both modes. */
export const CLOSED_CIDRS: readonly string[];
/** A copy of plugin-sdk's SANDBOX_FAKE_IP_DNS. */
export const FAKE_IP_DNS: {
  readonly fakeIpCidr: string;
  readonly endpoints: readonly string[];
  readonly timeoutMs: number;
  readonly cacheTtlCapSeconds: number;
  readonly cacheMaxNames: number;
};
/** The refusal when a fake-IP answer could not be resolved through encrypted DNS. */
export const FAKE_IP_REFUSAL: string;
export interface EncryptedDns {
  resolve(name: string): Promise<string[]>;
}
export function isFakeIp(address: string): boolean;
export function dnsQuery(name: string, qtype: 1 | 28): Buffer;
export function dnsAnswers(
  raw: Uint8Array,
  qtype: 1 | 28,
): { addresses: string[]; ttl: number | null };
export function createEncryptedDns(seams?: {
  endpoints?: readonly string[];
  ca?: string | Buffer;
  fetch?: (url: string, query: Uint8Array, timeoutMs: number) => Promise<Uint8Array>;
  clock?: () => number;
}): EncryptedDns & { cacheSize(): number };
/** The deployment's denied CIDRs as a BlockList; throws on an entry that is not a CIDR. */
export function deniedList(cidrs: readonly string[]): BlockList;
export function isForbiddenAddress(ip: string, denied?: BlockList): boolean;
export function normalizeHost(host: string): string;
export function hostAllowed(host: string, allowHosts: string[]): boolean;
export function publicNameError(host: string): string | null;
export function resolveTarget(
  host: string,
  opts: {
    mode?: EgressProxyMode;
    allowHosts: string[];
    testHosts: Record<string, string>;
    lookup: (host: string) => Promise<{ address: string }[]>;
    /** The deployment's denied ranges ({@link deniedList}). */
    denied?: BlockList;
    /** Re-resolves a fake-IP answer; without it such an answer is refused. */
    encryptedDns?: EncryptedDns;
  },
): Promise<string[]>;
export function connectAny(
  ips: string[],
  port: number,
  timeoutMs?: number,
  /** The transport; tests inject a fake so the per-attempt deadline is deterministic. */
  connectFn?: (opts: { host: string; port: number; allowHalfOpen: boolean }) => Socket,
): Promise<Socket>;
export function createEgressProxy(cfg: EgressProxyConfig): Server;
export function createSocksProxy(
  cfg: EgressProxyConfig & {
    /** Absolute deadline for the handshake and any refusal reply, default 30 000 ms. */
    handshakeMs?: number;
  },
): NetServer;
export function main(env?: Record<string, string | undefined>): {
  http: Server;
  socks: NetServer;
};
