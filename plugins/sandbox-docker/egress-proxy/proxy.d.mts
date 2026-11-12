import type { Server } from "node:http";
import type { Server as NetServer, Socket } from "node:net";

/** strict: allowlist, CONNECT to listed ports; dev: allowlist, any port, SOCKS; open: any public host, any port, SOCKS. */
export type EgressProxyMode = "strict" | "dev" | "open";

export interface EgressProxyConfig {
  /** Default "strict". */
  mode?: EgressProxyMode;
  /** Allowed host names (strict / dev); ignored in open mode. */
  allowHosts?: string[];
  /** Test only: host name -> pinned IP (exempt from the private address check; strict / dev still need the allowlist). */
  testHosts?: Record<string, string>;
  /** Ports CONNECT allows in strict mode, default [443, 80]; dev / open allow any port. */
  connectPorts?: number[];
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
  cfg: Omit<EgressProxyConfig, "connectPorts"> & {
    /** Absolute deadline for the handshake and any refusal reply, default 30 000 ms. */
    handshakeMs?: number;
  },
): NetServer;
export function main(env?: Record<string, string | undefined>): {
  http: Server;
  socks: NetServer | null;
};
