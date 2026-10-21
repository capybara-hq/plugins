import { SANDBOX_CAPABILITY } from "@capybara-hq/plugin-sdk";
import { describe, expect, it } from "vitest";
import plugin, { DeploymentConfig } from "../src/index.js";

/** 清单与部署配置（不需要 Docker）。 */
describe("sandbox-docker manifest", () => {
  it("provides sandbox@1 and declares no platform permissions", () => {
    expect(plugin.name).toBe("sandbox-docker");
    expect(plugin.provides).toEqual([SANDBOX_CAPABILITY]);
    expect(plugin.permissions).toEqual({});
  });

  it("deployment config: defaults, endpoint schemes", () => {
    const c = DeploymentConfig.parse({ endpoint: "tcp://sandbox-proxy:2375" });
    expect(c).toEqual({
      endpoint: "tcp://sandbox-proxy:2375",
      runtime: "runc",
      network: "capybara-sandbox",
      egressProxyImage: "capybara-sandbox-egress:latest",
    });
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
