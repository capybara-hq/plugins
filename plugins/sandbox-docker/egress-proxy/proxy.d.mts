import type { Server } from "node:http";
import type { Socket } from "node:net";

export interface EgressProxyConfig {
  allowHosts: string[];
  /** 仅测试：主机名 → 固定 IP（豁免私有地址检查，仍须在白名单里）。 */
  testHosts?: Record<string, string>;
  /** CONNECT 放行的端口，默认 [443, 80]。 */
  connectPorts?: number[];
  lookup?: (host: string) => Promise<{ address: string }[]>;
}

export function isForbiddenAddress(ip: string): boolean;
export function normalizeHost(host: string): string;
export function hostAllowed(host: string, allowHosts: string[]): boolean;
export function resolveTarget(
  host: string,
  opts: Required<Omit<EgressProxyConfig, "connectPorts">>,
): Promise<string[]>;
export function connectAny(ips: string[], port: number): Promise<Socket>;
export function createEgressProxy(cfg: EgressProxyConfig): Server;
export function main(env?: Record<string, string | undefined>): Server;
