import type { SandboxLimits } from "@capybara-hq/plugin-sdk";
import { describe, expect, it } from "vitest";
import {
  egressProxyEnv,
  type InstancePlan,
  planInstance,
  type SandboxTier,
  sandboxEnv,
  type TierLimits,
  updateDecision,
} from "../src/provider.js";

/**
 * Sandbox tiers without Docker: what `create` builds for each tier and egress (network mode,
 * proxy mode, environment, shm size) and when `update` may change only the egress proxy.
 */

const MIB = 1024 * 1024;
const L = ["registry.npmjs.org", "*.example.com"];

const limits = (
  egress: SandboxLimits["egress"],
  tier?: SandboxTier,
  o: { memoryMb?: number; allowHosts?: string[] } = {},
): SandboxLimits => {
  const l: TierLimits = {
    cpu: 1,
    memoryMb: o.memoryMb ?? 2048,
    diskMb: 1024,
    egress,
    allowHosts: o.allowHosts ?? (egress === "allowlist" ? L : []),
    ...(tier !== undefined && { tier }),
  };
  return l;
};

/** The labels `create` puts on a container for a plan (as provider.ts planLabels does). */
const labelsOf = (egress: SandboxLimits["egress"], p: InstancePlan): Record<string, string> => ({
  "dev.capybara.sandbox.egress": egress,
  "dev.capybara.sandbox.tier": p.tier,
  "dev.capybara.sandbox.egress-mode": p.mode,
  "dev.capybara.sandbox.allow-hosts": JSON.stringify(p.allowHosts),
  "dev.capybara.sandbox.shm": String(p.shmBytes ?? 0),
});

describe("planInstance", () => {
  it("absent tier is strict: allowlist through the strict proxy, Docker's default shm", () => {
    expect(planInstance(limits("allowlist"))).toEqual({
      tier: "strict",
      mode: "strict",
      allowHosts: L,
      shmBytes: null,
    });
  });

  it("allowlist: strict mode in strict, dev mode (any port, SOCKS) in dev and open", () => {
    expect(planInstance(limits("allowlist", "strict")).mode).toBe("strict");
    expect(planInstance(limits("allowlist", "dev"))).toMatchObject({ mode: "dev", allowHosts: L });
    expect(planInstance(limits("allowlist", "open"))).toMatchObject({ mode: "dev", allowHosts: L });
  });

  it("egress none is no network in every tier", () => {
    for (const t of ["strict", "dev", "open"] as const) {
      expect(planInstance(limits("none", t))).toMatchObject({ mode: "none", allowHosts: [] });
    }
  });

  it("open egress follows openEgress: proxy (default) / direct / off refuses", () => {
    expect(planInstance(limits("open", "open"))).toMatchObject({ mode: "open", allowHosts: [] });
    expect(planInstance(limits("open", "open"), "proxy").mode).toBe("open");
    expect(planInstance(limits("open", "open"), "direct").mode).toBe("direct");
    // an SDK without tiers may still send egress open (tier absent)
    expect(planInstance(limits("open"), "direct")).toMatchObject({
      tier: "strict",
      mode: "direct",
    });
    expect(() => planInstance(limits("open", "open"), "off")).toThrow(
      /openEgress is "off".*extensionConfig\."sandbox-docker"\.openEgress/,
    );
    // off only refuses open egress
    expect(planInstance(limits("allowlist", "dev"), "off").mode).toBe("dev");
  });

  it("shm: min(1 GiB, memoryMb / 4) in dev and open, default in strict", () => {
    expect(planInstance(limits("none", "dev", { memoryMb: 2048 })).shmBytes).toBe(512 * MIB);
    expect(planInstance(limits("none", "open", { memoryMb: 8192 })).shmBytes).toBe(1024 * MIB);
    expect(planInstance(limits("none", "dev", { memoryMb: 512 })).shmBytes).toBe(128 * MIB);
    expect(planInstance(limits("none", "dev", { memoryMb: 2 })).shmBytes).toBe(MIB);
    expect(planInstance(limits("none", "strict", { memoryMb: 8192 })).shmBytes).toBeNull();
  });

  it("rejects an unknown tier", () => {
    expect(() =>
      planInstance({ ...limits("none"), tier: "wide" } as unknown as SandboxLimits),
    ).toThrow(/unknown sandbox tier/);
  });
});

describe("sandboxEnv", () => {
  const name = "cap-device-x";
  const proxy = "http://cap-device-x-egress:3128";

  it("none and direct: no proxy variables", () => {
    expect(sandboxEnv(name, "none")).toEqual(["HOME=/workspace", "LANG=C.UTF-8"]);
    expect(sandboxEnv(name, "direct")).toEqual(["HOME=/workspace", "LANG=C.UTF-8"]);
  });

  it("strict: HTTP(S)_PROXY only (no SOCKS, no ssh)", () => {
    const env = sandboxEnv(name, "strict");
    expect(env).toContain(`HTTPS_PROXY=${proxy}`);
    expect(env).toContain(`http_proxy=${proxy}`);
    expect(env).toContain("NO_PROXY=localhost,127.0.0.1,::1");
    expect(env.some((e) => /^(ALL_PROXY|GRPC_PROXY|GIT_SSH_COMMAND)=/i.test(e))).toBe(false);
  });

  it("dev and open: ALL_PROXY / GRPC_PROXY on the CONNECT port, ssh through SOCKS5 1080", () => {
    for (const mode of ["dev", "open"] as const) {
      const env = sandboxEnv(name, mode);
      expect(env).toEqual(
        expect.arrayContaining([
          `HTTP_PROXY=${proxy}`,
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
    expect(sandboxEnv(name, "dev")).toEqual(sandboxEnv(name, "open"));
  });
});

describe("egressProxyEnv", () => {
  it("strict: MODE and the host list, no SOCKS port", () => {
    expect(egressProxyEnv("strict", L)).toEqual([
      "MODE=strict",
      "PORT=3128",
      `ALLOW_HOSTS=${JSON.stringify(L)}`,
    ]);
  });

  it("dev: the host list plus SOCKS_PORT; open: no host list", () => {
    expect(egressProxyEnv("dev", L)).toEqual([
      "MODE=dev",
      "PORT=3128",
      `ALLOW_HOSTS=${JSON.stringify(L)}`,
      "SOCKS_PORT=1080",
    ]);
    expect(egressProxyEnv("open", [])).toEqual(["MODE=open", "PORT=3128", "SOCKS_PORT=1080"]);
  });

  it("test hosts go through CAPYBARA_EGRESS_TEST_HOSTS", () => {
    expect(egressProxyEnv("strict", [], { "a.example.com": "10.0.0.1" })).toContain(
      'CAPYBARA_EGRESS_TEST_HOSTS={"a.example.com":"10.0.0.1"}',
    );
  });
});

describe("updateDecision", () => {
  const at = (egress: SandboxLimits["egress"], tier: SandboxTier, o = {}) => {
    const l = limits(egress, tier, o);
    return { labels: labelsOf(egress, planInstance(l)), plan: planInstance(l) };
  };

  it("dev to open through the proxy (same env and shm): updated", () => {
    expect(updateDecision(at("allowlist", "dev").labels, at("open", "open").plan)).toBe("updated");
  });

  it("open to dev narrows what the labels record: recreate", () => {
    expect(updateDecision(at("open", "open").labels, at("allowlist", "dev").plan)).toBe("recreate");
  });

  it("same mode: a host list keeping every recorded host is updated, a narrower one recreates", () => {
    const from = at("allowlist", "dev").labels;
    const wider = at("allowlist", "dev", { allowHosts: [...L, "pypi.org"] }).plan;
    const narrower = at("allowlist", "dev", { allowHosts: ["pypi.org"] }).plan;
    expect(updateDecision(from, wider)).toBe("updated");
    expect(updateDecision(from, narrower)).toBe("recreate");
    expect(updateDecision(from, at("allowlist", "dev").plan)).toBe("updated");
  });

  it("strict and dev differ in environment and shm: recreate both ways", () => {
    expect(updateDecision(at("allowlist", "strict").labels, at("allowlist", "dev").plan)).toBe(
      "recreate",
    );
    expect(updateDecision(at("allowlist", "dev").labels, at("allowlist", "strict").plan)).toBe(
      "recreate",
    );
  });

  it("a different shm size (memory changed with the tier): recreate", () => {
    const from = at("allowlist", "dev", { memoryMb: 1024 }).labels;
    expect(updateDecision(from, at("open", "open", { memoryMb: 2048 }).plan)).toBe("recreate");
  });

  it("none and direct cannot change in place: recreate", () => {
    expect(updateDecision(at("none", "dev").labels, at("allowlist", "dev").plan)).toBe("recreate");
    expect(updateDecision(at("allowlist", "dev").labels, at("none", "dev").plan)).toBe("recreate");
    const direct = labelsOf("open", planInstance(limits("open", "open"), "direct"));
    expect(updateDecision(direct, at("open", "open").plan)).toBe("recreate");
  });

  it("a container labelled before tiers reads as strict (allowlist) or direct (open)", () => {
    const old = {
      "dev.capybara.sandbox.egress": "allowlist",
      "dev.capybara.sandbox.allow-hosts": JSON.stringify(L),
    };
    expect(updateDecision(old, at("allowlist", "strict").plan)).toBe("updated");
    expect(updateDecision(old, at("allowlist", "dev").plan)).toBe("recreate");
    expect(updateDecision({ "dev.capybara.sandbox.egress": "open" }, at("open", "open").plan)).toBe(
      "recreate",
    );
  });
});
