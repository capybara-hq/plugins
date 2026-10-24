import { SANDBOX_EXTENSION_POINT } from "@capybara-hq/plugin-sdk";
import { describe, expect, it } from "vitest";
import plugin, { createDockerSandbox, DeploymentConfig, decodeOutput } from "../src/index.js";

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
  it("provides sandbox@1 and declares no platform permissions", () => {
    expect(plugin.name).toBe("sandbox-docker");
    expect(plugin.provides).toEqual([SANDBOX_EXTENSION_POINT]);
    expect(plugin.permissions).toEqual({});
  });

  it("deployment config: defaults, endpoint schemes", () => {
    const c = DeploymentConfig.parse({ endpoint: "tcp://sandbox-proxy:2375" });
    expect(c).toEqual({
      endpoint: "tcp://sandbox-proxy:2375",
      runtime: "runc",
      network: "capybara-sandbox",
      egressProxyImage: "capybara-sandbox-egress:latest",
      allowOpenEgress: false,
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

  it("test-only egress overrides cannot be set from plugin config", () => {
    expect(() =>
      DeploymentConfig.parse({
        endpoint: "tcp://x:1",
        egressTestHosts: { "a.example.com": "10.0.0.1" },
      }),
    ).toThrow();
  });
});

describe("egress open without allowOpenEgress (no Docker needed)", () => {
  it("create refuses before touching Docker, naming the plugin setting", async () => {
    const sbx = createDockerSandbox(DeploymentConfig.parse({ endpoint: "tcp://127.0.0.1:9" }));
    await expect(
      sbx.create({
        name: "cap-00000000-0000-4000-8000-000000000001",
        image: "capybara-sandbox:latest",
        limits: { cpu: 1, memoryMb: 256, diskMb: 256, egress: "open", allowHosts: [] },
        signal: AbortSignal.timeout(5000),
      }),
    ).rejects.toThrow(/pluginConfig\."sandbox-docker"\.allowOpenEgress/);
  });
});
