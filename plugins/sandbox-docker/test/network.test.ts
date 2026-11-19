import type { SandboxLimits } from "@capybara-hq/plugin-sdk";
import { describe, expect, it } from "vitest";
import {
  egressProxyEnv,
  engineSupported,
  hostDeniedCidrs,
  type InstancePlan,
  internalNetworkCreateBody,
  internalNetworkHardened,
  planInstance,
  sandboxEnv,
  updateDecision,
} from "../src/provider.js";

/**
 * The sandbox network without Docker: what `create` builds for `limits.network`
 * (proxy mode, host list, environment, shm size), the refusal of the open public network, and when
 * `update` may change only the egress proxy.
 */

const MIB = 1024 * 1024;
const L = ["registry.npmjs.org", "*.example.com"];

const OPEN: SandboxLimits["network"] = { kind: "open-public", hosts: [] };
const allow = (hosts: string[] = L): SandboxLimits["network"] => ({
  kind: "allowlist",
  hosts,
});

const limits = (
  network: SandboxLimits["network"],
  o: { memoryMb?: number } = {},
): SandboxLimits => ({
  cpu: 1,
  memoryMb: o.memoryMb ?? 2048,
  diskMb: 1024,
  network,
});

/** The labels `create` puts on a container for a plan (as provider.ts planLabels does). */
const labelsOf = (p: InstancePlan): Record<string, string> => ({
  "dev.capybara.sandbox.network": p.mode,
  "dev.capybara.sandbox.allow-hosts": JSON.stringify(p.allowHosts),
});

describe("planInstance", () => {
  it("open-public: the open proxy, no host list", () => {
    expect(planInstance(limits(OPEN))).toEqual({
      mode: "open-public",
      allowHosts: [],
      shmBytes: 512 * MIB,
    });
  });

  it("allowlist: the proxy with the host list on any port", () => {
    expect(planInstance(limits(allow()))).toMatchObject({ mode: "allowlist", allowHosts: L });
  });

  it("an empty allowlist is the kill switch: no network at all", () => {
    expect(planInstance(limits(allow([])))).toMatchObject({ mode: "none", allowHosts: [] });
  });

  it("one shm profile: min(1 GiB, memoryMb / 4), whatever the mode", () => {
    expect(planInstance(limits(OPEN, { memoryMb: 2048 })).shmBytes).toBe(512 * MIB);
    expect(planInstance(limits(allow(), { memoryMb: 8192 })).shmBytes).toBe(1024 * MIB);
    expect(planInstance(limits(OPEN, { memoryMb: 512 })).shmBytes).toBe(128 * MIB);
    expect(planInstance(limits(allow(), { memoryMb: 2 })).shmBytes).toBe(MIB);
  });

  it("refuseOpenNetwork: open-public throws before Docker is touched, the allowlist works", () => {
    expect(() => planInstance(limits(OPEN), true)).toThrow(
      /refuseOpenNetwork.*extensionConfig\."sandbox-docker"\.refuseOpenNetwork/,
    );
    expect(planInstance(limits(allow()), true).mode).toBe("allowlist");
    // and it is off by default
    expect(planInstance(limits(OPEN)).mode).toBe("open-public");
  });

  it("old limits, including an explicitly open egress, fall to no network, never open-public", () => {
    // The pre-auto-mode limits shape: `egress: "open"` / `tier: "open"` must not open anything;
    // only `limits.network` is read.
    const old = {
      cpu: 1,
      memoryMb: 2048,
      diskMb: 1024,
      egress: "open",
      tier: "open",
      allowHosts: [],
      devHosts: [],
    } as unknown as SandboxLimits;
    expect(planInstance(old)).toMatchObject({ mode: "none", allowHosts: [] });
    // and a kernel that sends neither the network nor the old keys
    const absent = { cpu: 1, memoryMb: 2048, diskMb: 1024 } as unknown as SandboxLimits;
    expect(planInstance(absent)).toMatchObject({ mode: "none", allowHosts: [] });
  });

  it("rejects an unknown network kind", () => {
    expect(() =>
      planInstance(limits({ kind: "wide", hosts: [] } as unknown as SandboxLimits["network"])),
    ).toThrow(/unknown sandbox network kind/);
  });
});

describe("sandboxEnv", () => {
  const name = "cap-device-x";
  const proxy = "http://cap-device-x-egress:3128";

  it("proxy modes: HTTP(S)_PROXY, ALL_PROXY / GRPC_PROXY and ssh through SOCKS5", () => {
    for (const mode of ["open-public", "allowlist"] as const) {
      const env = sandboxEnv(name, mode);
      expect(env).toEqual(
        expect.arrayContaining([
          `HTTP_PROXY=${proxy}`,
          `HTTPS_PROXY=${proxy}`,
          `http_proxy=${proxy}`,
          `https_proxy=${proxy}`,
          "NO_PROXY=localhost,127.0.0.1,::1",
          `ALL_PROXY=${proxy}`,
          `all_proxy=${proxy}`,
          `GRPC_PROXY=${proxy}`,
          `grpc_proxy=${proxy}`,
          "GIT_SSH_COMMAND=ssh -o ProxyCommand='nc -X 5 -x cap-device-x-egress:1080 %h %p'",
        ]),
      );
      // the socket proxy rejects any non-ASCII byte in create bodies
      // biome-ignore lint/suspicious/noControlCharactersInRegex: ASCII range check
      expect(env.every((e) => /^[\x00-\x7f]*$/.test(e))).toBe(true);
    }
  });

  it("no network: no proxy variables", () => {
    expect(sandboxEnv(name, "none")).toEqual(["HOME=/workspace", "LANG=C.UTF-8"]);
  });
});

describe("egressProxyEnv", () => {
  it("open-public: the mode, ports and no host list", () => {
    expect(egressProxyEnv("open-public", [])).toEqual([
      "MODE=open-public",
      "PORT=3128",
      "SOCKS_PORT=1080",
    ]);
    // the list is ignored (open-public takes any public host)
    expect(egressProxyEnv("open-public", L)).toEqual([
      "MODE=open-public",
      "PORT=3128",
      "SOCKS_PORT=1080",
    ]);
  });

  it("allowlist: the host list plus the SOCKS port", () => {
    expect(egressProxyEnv("allowlist", L)).toEqual([
      "MODE=allowlist",
      "PORT=3128",
      "SOCKS_PORT=1080",
      `ALLOW_HOSTS=${JSON.stringify(L)}`,
    ]);
  });

  it("the deployment's denied CIDRs go through DENIED_CIDRS in both modes, absent when empty", () => {
    const denied = ["203.0.113.0/24", "2001:db8::/32"];
    for (const mode of ["open-public", "allowlist"] as const) {
      expect(egressProxyEnv(mode, L, undefined, denied)).toContain(
        `DENIED_CIDRS=${JSON.stringify(denied)}`,
      );
      expect(
        egressProxyEnv(mode, L, undefined, []).some((e) => e.startsWith("DENIED_CIDRS=")),
      ).toBe(false);
    }
  });

  it("test hosts go through CAPYBARA_EGRESS_TEST_HOSTS", () => {
    expect(egressProxyEnv("allowlist", [], { "a.example.com": "10.0.0.1" })).toContain(
      'CAPYBARA_EGRESS_TEST_HOSTS={"a.example.com":"10.0.0.1"}',
    );
  });
});

describe("updateDecision", () => {
  const at = (network: SandboxLimits["network"]) => planInstance(limits(network));

  it("allowlist to open-public recreates, so the labels say open-public (refuseOpenNetwork reads them)", () => {
    expect(updateDecision(labelsOf(at(allow())), at(OPEN))).toBe("recreate");
  });

  it("open-public to allowlist narrows what the labels record: recreate", () => {
    expect(updateDecision(labelsOf(at(OPEN)), at(allow(["pypi.org"])))).toBe("recreate");
  });

  it("allowlist: a host list keeping every recorded host is updated, a narrower one recreates", () => {
    const from = labelsOf(at(allow()));
    expect(updateDecision(from, at(allow([...L, "pypi.org"])))).toBe("updated");
    expect(updateDecision(from, at(allow([L[0] as string])))).toBe("recreate");
    expect(updateDecision(from, at(allow()))).toBe("updated");
  });

  it("open-public to open-public is updated", () => {
    expect(updateDecision(labelsOf(at(OPEN)), at(OPEN))).toBe("updated");
  });

  it("no network is recreated in every direction, the decision `update` makes", () => {
    expect(updateDecision(labelsOf(at(allow([]))), at(allow()))).toBe("recreate");
    expect(updateDecision(labelsOf(at(allow([]))), at(OPEN))).toBe("recreate");
    // `update` recreates a container whose plan is `none` (it cannot add or remove the internal
    // network in place), so `none` to `none` is a recreate rather than a no-op "updated".
    expect(updateDecision(labelsOf(at(allow([]))), at(allow([])))).toBe("recreate");
  });

  it("a proxy container cannot lose its network in place: recreate", () => {
    expect(updateDecision(labelsOf(at(OPEN)), at(allow([])))).toBe("recreate");
  });

  it("a container without this contract's labels recreates", () => {
    expect(updateDecision({}, at(allow()))).toBe("recreate");
    expect(updateDecision({ "dev.capybara.sandbox.network": "wide" }, at(OPEN))).toBe("recreate");
    expect(
      updateDecision(
        { "dev.capybara.sandbox.network": "allowlist", "dev.capybara.sandbox.allow-hosts": "{" },
        at(allow()),
      ),
    ).toBe("recreate");
  });
});

describe("instance network hardening (no Docker)", () => {
  it("creates the internal network without a host-side IPv4 gateway and without IPv6", () => {
    const body = internalNetworkCreateBody("cap-device-x", { a: "b" });
    expect(body).toMatchObject({
      Name: "cap-device-x-net",
      Driver: "bridge",
      Internal: true,
      EnableIPv6: false,
      Options: { "com.docker.network.bridge.inhibit_ipv4": "true" },
      Labels: { a: "b" },
    });
    expect(internalNetworkHardened({ "com.docker.network.bridge.inhibit_ipv4": "true" })).toBe(
      true,
    );
    // a network made by an earlier version (gateway on the host bridge) is not hardened
    expect(internalNetworkHardened({})).toBe(false);
    expect(internalNetworkHardened(null)).toBe(false);
  });

  it("denies the Docker host's own interface addresses when Docker is local, never loopback", () => {
    const interfaces = {
      lo0: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
      en0: [
        { address: "203.0.113.7", family: "IPv4", internal: false },
        { address: "2001:db8::7", family: "IPv6", internal: false },
        { address: "fe80::1%en0", family: "IPv6", internal: false },
      ],
    } as unknown as Parameters<typeof hostDeniedCidrs>[1];
    for (const endpoint of [
      "unix:///var/run/docker.sock",
      "/var/run/docker.sock",
      "http://127.0.0.1:2375",
      "tcp://localhost:2375",
      "http://[::1]:2375",
    ]) {
      expect(hostDeniedCidrs(endpoint, interfaces), endpoint).toEqual([
        "203.0.113.7/32",
        "2001:db8::7/128",
        "fe80::1/128",
      ]);
    }
    // a remote Docker host: its addresses are not this machine's (README: deniedCidrs)
    expect(hostDeniedCidrs("http://docker-proxy:2375", interfaces)).toEqual([]);
    expect(hostDeniedCidrs("tcp://10.0.0.5:2375", interfaces)).toEqual([]);
  });

  it("needs Docker Engine 25 or newer (the bridge option that removes the host gateway)", () => {
    expect(engineSupported("29.9.3")).toBe(true);
    expect(engineSupported("25.0.0")).toBe(true);
    expect(engineSupported("24.0.9")).toBe(false);
    expect(engineSupported("not-a-version")).toBe(false);
  });
});
