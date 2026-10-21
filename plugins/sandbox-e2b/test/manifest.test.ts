import { SANDBOX_CAPABILITY } from "@capybara-hq/plugin-sdk";
import { assertPluginSecretsReachable, pluginDeploymentSecretValues } from "@capybara-hq/testing";
import { describe, expect, it } from "vitest";
import plugin, { DeploymentConfig, decodeOutput, exitCodeOf } from "../src/index.js";

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

describe("exitCodeOf", () => {
  it("maps envd end events", () => {
    expect(exitCodeOf({ exited: true, exitCode: 3, status: "exit status 3" })).toBe(3);
    expect(exitCodeOf({ exited: true, status: "exit status 0" })).toBe(0);
    expect(exitCodeOf({ exitCode: -1, status: "signal: killed" })).toBe(137);
    expect(exitCodeOf({ exitCode: -1, status: "signal: segmentation fault (core dumped)" })).toBe(
      139,
    );
    expect(exitCodeOf({ exitCode: -1, status: "signal: terminated" })).toBe(143);
    expect(exitCodeOf({ exitCode: -1, status: "signal: something new" })).toBeNull();
    expect(exitCodeOf({})).toBeNull();
  });
});

/** 清单与部署配置。 */
describe("sandbox-e2b manifest", () => {
  it("provides sandbox@1 and declares no platform permissions", () => {
    expect(plugin.name).toBe("sandbox-e2b");
    expect(plugin.provides).toEqual([SANDBOX_CAPABILITY]);
    expect(plugin.permissions).toEqual({});
  });

  it("deployment config: defaults and validation", () => {
    const c = DeploymentConfig.parse({ apiKey: "e2b_x", template: "capybara-sandbox" });
    expect(c).toEqual({
      apiKey: "e2b_x",
      template: "capybara-sandbox",
      domain: "e2b.app",
      timeoutSeconds: 3600,
      domainAllowlist: true,
      allowOpenEgress: false,
    });
    expect(
      DeploymentConfig.parse({
        apiKey: "k",
        template: "t",
        apiUrl: "https://e2b-api.internal.example.com",
        domain: "sbx.example.com",
      }),
    ).toMatchObject({ apiUrl: "https://e2b-api.internal.example.com", domain: "sbx.example.com" });
    expect(() => DeploymentConfig.parse({ template: "t" })).toThrow();
    expect(() => DeploymentConfig.parse({ apiKey: "k" })).toThrow();
    expect(() =>
      DeploymentConfig.parse({ apiKey: "k", template: "t", apiUrl: "ftp://x" }),
    ).toThrow();
    expect(() =>
      DeploymentConfig.parse({ apiKey: "k", template: "t", domain: "https://e2b.app" }),
    ).toThrow();
    expect(() =>
      DeploymentConfig.parse({ apiKey: "k", template: "t", timeoutSeconds: 10 }),
    ).toThrow();
    expect(() =>
      DeploymentConfig.parse({ apiKey: "k", template: "t", timeoutSeconds: 90_000 }),
    ).toThrow();
  });

  it("apiKey is a secret the kernel can reach and redact", () => {
    assertPluginSecretsReachable(plugin);
    expect(
      pluginDeploymentSecretValues(plugin, { apiKey: "e2b_secret_value", template: "t" }),
    ).toEqual(["e2b_secret_value"]);
  });

  it("test-only options cannot be set from plugin config", () => {
    expect(() =>
      DeploymentConfig.parse({ apiKey: "k", template: "t", envdUrl: "http://127.0.0.1:1" }),
    ).toThrow();
  });
});
