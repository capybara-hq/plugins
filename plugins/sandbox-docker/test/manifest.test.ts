import { readFileSync } from "node:fs";
import { SANDBOX_EXTENSION_POINT, type SandboxLimits } from "@capybara-hq/plugin-sdk";
import { describe, expect, it } from "vitest";
import plugin, {
  createDockerSandbox,
  DeploymentConfig,
  decodeOutput,
  providerConfig,
  type SandboxNetwork,
} from "../src/index.js";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  version: string;
};

/**
 * Limits carrying the newer network contract; the installed SDK predates it, so the test passes
 * the shape the kernel sends (rc.22) through a cast.
 */
const netLimits = (network: SandboxNetwork): SandboxLimits =>
  ({ cpu: 1, memoryMb: 256, diskMb: 256, mode: "auto", network }) as unknown as SandboxLimits;

/** The open public network. */
const OPEN = netLimits({ kind: "open-public", hosts: [] });

/** The allowlist network (empty: no network). */
const ALLOWLIST = netLimits({ kind: "allowlist", hosts: [] });

describe("decodeOutput", () => {
  const zh = Buffer.from("a中", "utf8"); // 61 e4 b8 ad
  it("drops an incomplete trailing character only when truncated", () => {
    expect(decodeOutput(zh.subarray(0, 3), true)).toBe("a");
    expect(decodeOutput(zh.subarray(0, 2), true)).toBe("a");
    expect(decodeOutput(zh, true)).toBe("a中");
    expect(decodeOutput(Buffer.from("abc"), true)).toBe("abc");
    expect(decodeOutput(zh.subarray(0, 3), false)).toBe("a�");
  });
});

/** 清单与部署配置（不需要 Docker）。 */
describe("sandbox-docker manifest", () => {
  it("provides sandbox@2 and declares no platform permissions", () => {
    expect(plugin.name).toBe("sandbox-docker");
    expect(SANDBOX_EXTENSION_POINT).toBe("sandbox@2");
    expect(plugin.provides).toEqual(["sandbox@2"]);
    expect(plugin.permissions).toEqual({});
    // the kernel checks this range against the installed SDK version; the network contract
    // itself needs the auto-mode SDK (the provider falls back safely with an older one)
    expect(plugin.sdk).toBe("^0.1.0-rc.3");
  });

  it("deployment config: defaults, endpoint schemes", () => {
    const c = DeploymentConfig.parse({ endpoint: "tcp://sandbox-proxy:2375" });
    expect(c).toEqual({
      endpoint: "tcp://sandbox-proxy:2375",
      runtime: "runc",
      network: "capybara-sandbox",
      refuseOpenNetwork: false,
    });
    expect(() => DeploymentConfig.parse({ endpoint: "tcp://x:1", network: "sandboxes" })).toThrow(
      /start with 'cap'/,
    );
    expect(DeploymentConfig.parse({ endpoint: "unix:///run/sandbox-proxy.sock" }).endpoint).toBe(
      "unix:///run/sandbox-proxy.sock",
    );
    expect(() => DeploymentConfig.parse({ endpoint: "https://x:2376" })).toThrow();
    expect(() => DeploymentConfig.parse({ endpoint: "tcp://x" })).toThrow();
    expect(() => DeploymentConfig.parse({ endpoint: "tcp://x:1", runtime: "kata" })).toThrow();
    expect(
      DeploymentConfig.parse({ endpoint: "tcp://x:1", runtime: "runsc", volumeDriver: "rexray" }),
    ).toMatchObject({ runtime: "runsc", volumeDriver: "rexray" });
  });

  it("create without image uses the versioned default; egressProxyImage defaults to its own version", () => {
    expect(plugin.version).toBe(pkg.version);
    const c = providerConfig(DeploymentConfig.parse({ endpoint: "tcp://x:1" }));
    expect(c.defaultImage).toBe(`ghcr.io/capybara-hq/capybara-sandbox:${plugin.version}`);
    expect(c.egressProxyImage).toBe(
      `ghcr.io/capybara-hq/capybara-sandbox-egress:${plugin.version}`,
    );
    // the egressProxyImage setting overrides the published egress image
    expect(
      providerConfig(DeploymentConfig.parse({ endpoint: "tcp://x:1", egressProxyImage: "e:1" }))
        .egressProxyImage,
    ).toBe("e:1");
  });

  it("deployment config: refuseOpenNetwork; the old egress keys are gone", () => {
    expect(
      DeploymentConfig.parse({ endpoint: "tcp://x:1", refuseOpenNetwork: true }).refuseOpenNetwork,
    ).toBe(true);
    expect(() => DeploymentConfig.parse({ endpoint: "tcp://x:1", refuseOpenNetwork: 1 })).toThrow();
    // no compatibility: the tier-era settings are unknown keys
    for (const key of ["openEgress", "allowOpenEgress"]) {
      const r = DeploymentConfig.safeParse({ endpoint: "tcp://x:1", [key]: true });
      expect(r.success).toBe(false);
      expect(r.error?.issues[0]?.message).toMatch(/Unrecognized key/);
    }
    const other = DeploymentConfig.safeParse({ endpoint: "tcp://x:1", foo: 1 });
    expect(other.error?.issues[0]?.message).toMatch(/Unrecognized key/);
  });

  it("the provider declares update and limitsApplyAt instance", () => {
    const sbx = createDockerSandbox(
      providerConfig(DeploymentConfig.parse({ endpoint: "tcp://127.0.0.1:9" })),
    );
    expect(sbx.limitsApplyAt).toBe("instance");
    expect(typeof sbx.update).toBe("function");
  });

  it("test-only egress overrides cannot be set from plugin config", () => {
    expect(() =>
      DeploymentConfig.parse({
        endpoint: "tcp://x:1",
        egressTestHosts: { "a.example.com": "10.0.0.1" },
      }),
    ).toThrow();
  });
});

describe("open-public with refuseOpenNetwork (no Docker needed)", () => {
  it("create and update refuse before touching Docker, naming the plugin setting", async () => {
    const sbx = createDockerSandbox(
      providerConfig(
        DeploymentConfig.parse({ endpoint: "tcp://127.0.0.1:9", refuseOpenNetwork: true }),
      ),
    );
    await expect(
      sbx.create({
        name: "cap-00000000-0000-4000-8000-000000000001",
        image: "capybara-sandbox:latest",
        limits: { ...OPEN },
        fileSystem: { id: "cap-00000000-0000-4000-8000-000000000001" },
        signal: AbortSignal.timeout(5000),
      }),
    ).rejects.toThrow(/extensionConfig\."sandbox-docker"\.refuseOpenNetwork/);
    await expect(
      sbx.update(
        { id: "cap-00000000-0000-4000-8000-000000000001" },
        { ...OPEN },
        AbortSignal.timeout(5000),
      ),
    ).rejects.toThrow(/refuseOpenNetwork is true/);
  });

  it("the allowlist is still accepted when refuseOpenNetwork is on", async () => {
    const sbx = createDockerSandbox({
      endpoint: "tcp://127.0.0.1:9",
      runtime: "runc",
      network: "capybara-sandbox",
      egressProxyImage: "e:1",
      refuseOpenNetwork: true,
    });
    // it fails on Docker (nothing listens on the endpoint), not on the network refusal
    await expect(
      sbx.create({
        name: "cap-device-00000000-0000-4000-8000-000000000001",
        image: "capybara-sandbox:latest",
        limits: { ...ALLOWLIST },
        fileSystem: { id: "cap-device-00000000-0000-4000-8000-000000000001" },
        signal: AbortSignal.timeout(5000),
      }),
    ).rejects.not.toThrow(/refuseOpenNetwork/);
  });

  it("create without image and without a default image refuses before touching Docker", async () => {
    const sbx = createDockerSandbox({
      endpoint: "tcp://127.0.0.1:9",
      runtime: "runc",
      network: "capybara-sandbox",
      egressProxyImage: "e:1",
    });
    await expect(
      sbx.create({
        name: "cap-device-00000000-0000-4000-8000-000000000001",
        limits: { ...ALLOWLIST },
        fileSystem: { id: "cap-device-00000000-0000-4000-8000-000000000001" },
        signal: AbortSignal.timeout(5000),
      }),
    ).rejects.toThrow(/no image/);
  });
});
