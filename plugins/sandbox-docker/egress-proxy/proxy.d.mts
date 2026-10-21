import type { Server } from "node:http";

export interface EgressProxyConfig {
  allowHosts: string[];
  /** 仅测试：主机名 → 固定 IP（豁免私有地址检查，仍须在白名单里）。 */
  testHosts?: Record<string, string>;
  lookup?: (host: string) => Promise<{ address: string }[]>;
}

export function isForbiddenAddress(ip: string): boolean;
export function normalizeHost(host: string): string;
export function hostAllowed(host: string, allowHosts: string[]): boolean;
export function resolveTarget(host: string, opts: Required<EgressProxyConfig>): Promise<string>;
export function createEgressProxy(cfg: EgressProxyConfig): Server;
export function main(env?: Record<string, string | undefined>): Server;
