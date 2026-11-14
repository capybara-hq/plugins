import { describe, expect, it } from "vitest";
import {
  egressProxyEnv,
  type InstancePlan,
  planInstance,
  type SandboxNetworkLimits,
  sandboxEnv,
  updateDecision,
} from "../src/provider.js";

/**
 * The sandbox network without Docker: what `create` builds for `limits.mode` / `limits.network`
 * (proxy mode, host list, environment, shm size), the refusal of the open public network, and when
 * `update` may change only the egress proxy.
 */

const MIB = 1024 * 1024;
const L = ["registry.npmjs.org", "*.example.com"];

const OPEN: SandboxNetworkLimits["network"] = { kind: "open-public", hosts: [] };
const allow = (hosts: string[] = L): SandboxNetworkLimits["network"] => ({
  kind: "allowlist",
  hosts,
});

const limits = (
  network: SandboxNetworkLimits["network"],
  o: { memoryMb?: number; mode?: SandboxNetworkLimits["mode"] } = {},
): SandboxNetworkLimits => ({
  cpu: 1,
  memoryMb: o.memoryMb ?? 2048,
  diskMb: 1024,
  mode: o.mode ?? "auto",
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
    // the same for the sandbox mode: the container profile does not depend on it
    expect(planInstance(limits(allow(), { mode: "sandbox" }))).toMatchObject({
      mode: "allowlist",
      allowHosts: L,
    });
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
    } as unknown as SandboxNetworkLimits;
    expect(planInstance(old)).toMatchObject({ mode: "none", allowHosts: [] });
    // and a kernel that sends neither the network nor the old keys
    const absent = { cpu: 1, memoryMb: 2048, diskMb: 1024 } as unknown as SandboxNetworkLimits;
    expect(planInstance(absent)).toMatchObject({ mode: "none", allowHosts: [] });
  });

  it("rejects an unknown network kind", () => {
    expect(() =>
      planInstance(
        limits({ kind: "wide", hosts: [] } as unknown as SandboxNetworkLimits["network"]),
      ),
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

  it("test hosts go through CAPYBARA_EGRESS_TEST_HOSTS", () => {
    expect(egressProxyEnv("allowlist", [], { "a.example.com": "10.0.0.1" })).toContain(
      'CAPYBARA_EGRESS_TEST_HOSTS={"a.example.com":"10.0.0.1"}',
    );
  });
});

describe("updateDecision", () => {
  const at = (network: SandboxNetworkLimits["network"]) => planInstance(limits(network));

  it("allowlist to open-public widens: updated", () => {
    expect(updateDecision(labelsOf(at(allow())), at(OPEN))).toBe("updated");
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
