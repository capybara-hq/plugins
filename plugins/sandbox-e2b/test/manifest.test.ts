import { SANDBOX_EXTENSION_POINT } from "@capybara-hq/plugin-sdk";
import {
  assertExtensionSecretsReachable,
  extensionDeploymentSecretValues,
} from "@capybara-hq/testing";
import { describe, expect, it } from "vitest";
import plugin, {
  DEFAULT_IMAGE,
  DeploymentConfig,
  decodeOutput,
  exitCodeOf,
  SANDBOX_DOCKER_VERSION,
  TEMPLATE_ALIAS,
} from "../src/index.js";

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

/** The manifest and the deployment config. */
describe("sandbox-e2b manifest", () => {
  it("provides sandbox@2 and declares no platform permissions", () => {
    expect(plugin.name).toBe("sandbox-e2b");
    expect(SANDBOX_EXTENSION_POINT).toBe("sandbox@2");
    expect(plugin.provides).toEqual([SANDBOX_EXTENSION_POINT]);
    expect(plugin.permissions).toEqual({});
  });

  it("the default template comes from the image published with sandbox-docker's version", () => {
    expect(SANDBOX_DOCKER_VERSION).toMatch(/^\d+\.\d+\.\d+(-[a-z]+\.\d+)?$/);
    expect(DEFAULT_IMAGE).toBe(`ghcr.io/capybara-hq/capybara-sandbox:${SANDBOX_DOCKER_VERSION}`);
    expect(TEMPLATE_ALIAS).toBe(`capybara-sandbox-${SANDBOX_DOCKER_VERSION.replaceAll(".", "-")}`);
    // E2B aliases: lowercase letters, digits and dashes
    expect(TEMPLATE_ALIAS).toMatch(/^[a-z0-9-]+$/);
  });

  it("deployment config: defaults and validation", () => {
    expect(DeploymentConfig.parse({ apiKey: "e2b_x" })).toEqual({
      apiKey: "e2b_x",
      domain: "e2b.app",
      timeoutSeconds: 3600,
      domainAllowlist: true,
      allowOpenEgress: false,
    });
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
    expect(() => DeploymentConfig.parse({ apiKey: "k", template: "" })).toThrow();
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
    assertExtensionSecretsReachable(plugin);
    expect(
      extensionDeploymentSecretValues(plugin, { apiKey: "e2b_secret_value", template: "t" }),
    ).toEqual(["e2b_secret_value"]);
  });

  it("test-only options cannot be set from plugin config", () => {
    expect(() =>
      DeploymentConfig.parse({ apiKey: "k", template: "t", envdUrl: "http://127.0.0.1:1" }),
    ).toThrow();
  });
});
