import {
  type NetworkBlockedHost,
  sandboxProxyRefusalLayer,
  validateAllowHost,
} from "@capybara-hq/plugin-sdk";
import { MAX_NETWORK_BLOCKED_HOSTS } from "@capybara-hq/plugin-sdk/device-protocol";

/**
 * The hosts one command was refused, from its egress proxy's recorded refusals (the control
 * reply's `refusals`: `{ host, port, reason }`, egress-proxy/proxy.mjs): the layer from the
 * proxy's reason through the SDK's `sandboxProxyRefusalLayer` (a closed address is `address`, a
 * host off the list `device`, anything else `unknown`), and any host that is no valid allowlist
 * name (an IP literal, a single label, a wildcard) is `address` whatever the reason, since nobody
 * can allow it. Deduped by host (the most restrictive refusal wins, then the first port), at most
 * `MAX_NETWORK_BLOCKED_HOSTS`; malformed entries are skipped. Only a report: the kernel
 * recomputes the org layer and decides what may be asked.
 */
export function blockedHosts(refusals: unknown): NetworkBlockedHost[] {
  if (!Array.isArray(refusals)) return [];
  const out = new Map<string, NetworkBlockedHost>();
  for (const r of refusals.slice(0, 64)) {
    if (typeof r !== "object" || r === null) continue;
    const { host, port, reason } = r as Record<string, unknown>;
    if (typeof host !== "string" || host === "" || host.length > 255) continue;
    if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) continue;
    if (typeof reason !== "string" || reason.length > 1024) continue;
    const layer =
      host.startsWith("*") || validateAllowHost(host).length > 0
        ? "address"
        : sandboxProxyRefusalLayer(reason);
    const had = out.get(host);
    if (had !== undefined) {
      // an address refusal of a host seen before under another reason: the address holds
      if (layer === "address") had.layer = "address";
      continue;
    }
    if (out.size >= MAX_NETWORK_BLOCKED_HOSTS) continue;
    out.set(host, { host, port, layer });
  }
  return [...out.values()];
}
