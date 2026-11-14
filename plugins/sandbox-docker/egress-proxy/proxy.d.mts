import type { Server } from "node:http";
import type { Server as NetServer, Socket } from "node:net";

/** open-public: any public host, any port, SOCKS; allowlist: listed hosts, any port, SOCKS. */
export type EgressProxyMode = "open-public" | "allowlist";

export interface EgressProxyConfig {
  /** Default "open-public". */
  mode?: EgressProxyMode;
  /** Allowed host names (allowlist); ignored in open-public mode. */
  allowHosts?: string[];
  /** Test only: host name -> pinned IP (exempt from the private address check; allowlist still needs the list). */
  testHosts?: Record<string, string>;
  lookup?: (host: string) => Promise<{ address: string }[]>;
  /** Receives one English line per refusal; default console.warn. */
  log?: (msg: string) => void;
}

export const MODES: readonly EgressProxyMode[];
export function isForbiddenAddress(ip: string): boolean;
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
  },
): Promise<string[]>;
export function connectAny(ips: string[], port: number, timeoutMs?: number): Promise<Socket>;
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
