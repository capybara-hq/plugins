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
  /** The start fence token (the config file's, else the create-time one); default 0. */
  fence?: number;
  /** Test only: host name -> pinned IP (exempt from the private address check; allowlist still needs the list). */
  testHosts?: Record<string, string>;
  lookup?: (host: string) => Promise<{ address: string }[]>;
  /** Encrypted DNS for fake-IP answers; default {@link createEncryptedDns} with the SDK's endpoints. */
  encryptedDns?: EncryptedDns;
  /** Receives one English line per refusal; default console.warn. */
  log?: (msg: string) => void;
  /** The state shared with the other listener and the control socket; default one of its own. */
  state?: EgressState;
  /** Where `apply` writes the list in force (the container's /config/allow.json); none in tests. */
  configFile?: string;
  /** Test seam: the transport `connectAny` dials with. */
  connect?: (opts: { host: string; port: number; allowHalfOpen: boolean }) => Socket;
}

/** The list in force; replaced as a whole by `apply`. */
export interface EgressPolicy {
  readonly mode: EgressProxyMode;
  readonly allowHosts: readonly string[];
  readonly deniedCidrs: readonly string[];
  readonly denied: BlockList;
  readonly digest: string;
}

export interface EgressEntry {
  readonly host: string;
  readonly pinned: boolean;
  ip: string | null;
  revoked: boolean;
  readonly sockets: Set<Socket>;
}

export interface EgressState {
  readonly policy: EgressPolicy;
  readonly testHosts: Record<string, string>;
  /** Admitted connections whose client side has not closed. */
  readonly connections: number;
  /** The highest fence token applied (or the start token). */
  readonly fence: number;
  admit(host: string, client: Socket, closed?: import("node:events").EventEmitter): EgressEntry;
  /** Records a refusal for the operation `tag`; no tag or no reason records nothing. */
  recordRefusal(tag: string | null, host: string, port: number, reason: string | undefined): void;
  /** The refusals recorded for `tag`, oldest first, then forgotten. */
  takeRefusals(tag: string): EgressRefusal[];
  keep(entry: EgressEntry, up: Socket): boolean;
  /**
   * Under the fence token `fence`: refuses a missing or invalid token, throws {@link StaleFence}
   * for a lower one (nothing changed); otherwise validates, writes the config file with the token,
   * swaps, closes what the new list does not cover; the digest. The same list with a higher token
   * only stores the token.
   */
  apply(config: unknown, fence: unknown): Promise<string>;
}

export interface AllowConfig {
  mode: "allowlist";
  hosts: string[];
  deniedCidrs: string[];
}

/** An apply refused for its lower fence token. */
export class StaleFence extends Error {
  readonly code: "stale-fence";
  /** The token in force. */
  readonly fence: number;
  constructor(fence: number);
}
export function isFence(v: unknown): v is number;

export function allowHostError(h: unknown): string | null;
export function allowDigest(c: {
  mode: string;
  hosts: readonly string[];
  deniedCidrs: readonly string[];
}): string;
export function parseAllowConfig(raw: unknown): AllowConfig;
export function readAllowFile(file: string): (AllowConfig & { fence: number }) | null;
export function createEgressState(cfg?: EgressProxyConfig): EgressState;
export function createControlServer(state: EgressState): NetServer;
export function controlRequest(path: string, request: unknown): Promise<Record<string, unknown>>;
export function inDenied(ip: string, denied: BlockList): boolean;

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
/** A refusal recorded for an operation (see `operationTag`). */
export interface EgressRefusal {
  /** Normalized; an IPv6 literal bracketed. */
  host: string;
  port: number;
  /** One of {@link REFUSAL_REASONS}. */
  reason: string;
}
/** The reasons a refusal names (the status phrase), in the SDK's sandbox proxy vocabulary. */
export const REFUSAL_REASONS: Readonly<{
  malformed: string;
  literal: string;
  resolved: string;
  offList: string;
  fakeIp: string;
}>;
/** The operation tag of a `Proxy-Authorization` header (`capybara:<32 hex>`), or null. */
export function operationTag(header: unknown): string | null;
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
  control: NetServer;
  state: EgressState;
};
