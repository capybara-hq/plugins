import { readFileSync } from "node:fs";
import { SANDBOX_EXTENSION_POINT } from "@capybara-hq/plugin-sdk";
import {
  assertExtensionSecretsReachable,
  extensionDeploymentSecretValues,
} from "@capybara-hq/testing";
import { describe, expect, it } from "vitest";
import plugin, {
  DeploymentConfig,
  decodeOutput,
  exitCodeOf,
  providerConfig,
  publishedImage,
  templateAlias,
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
    // the kernel checks this range against the installed SDK version
    expect(plugin.sdk).toBe("^0.1.0-rc.22");
  });

  it("the default template comes from the image published with this plugin's version", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
      version: string;
    };
    expect(plugin.version).toBe(pkg.version);
    const c = providerConfig(DeploymentConfig.parse({ apiKey: "k" }));
    expect(c.defaultImage).toBe(`ghcr.io/capybara-hq/capybara-sandbox:${plugin.version}`);
    expect(publishedImage("0.1.0-rc.3")).toBe("ghcr.io/capybara-hq/capybara-sandbox:0.1.0-rc.3");
    expect(templateAlias(publishedImage("0.1.0-rc.3"))).toBe("capybara-sandbox-0-1-0-rc-3");
    expect(templateAlias("registry:5000/x/img:V1_2")).toBe("capybara-sandbox-v1-2");
    expect(templateAlias("img")).toBe("capybara-sandbox-latest");
  });

  it("deployment config: defaults and validation", () => {
    expect(DeploymentConfig.parse({ apiKey: "e2b_x" })).toEqual({
      apiKey: "e2b_x",
      domain: "e2b.app",
      timeoutSeconds: 3600,
      domainAllowlist: true,
      openEgress: "proxy",
    });
    const c = DeploymentConfig.parse({ apiKey: "e2b_x", template: "capybara-sandbox" });
    expect(c).toEqual({
      apiKey: "e2b_x",
      template: "capybara-sandbox",
      domain: "e2b.app",
      timeoutSeconds: 3600,
      domainAllowlist: true,
      openEgress: "proxy",
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

  it('openEgress: "off" | "proxy" | "direct"; the old allowOpenEgress points to it', () => {
    for (const openEgress of ["off", "proxy", "direct"] as const) {
      expect(DeploymentConfig.parse({ apiKey: "k", openEgress }).openEgress).toBe(openEgress);
    }
    expect(() => DeploymentConfig.parse({ apiKey: "k", openEgress: true })).toThrow();
    const r = DeploymentConfig.safeParse({ apiKey: "k", allowOpenEgress: true });
    expect(r.success).toBe(false);
    expect(r.error?.issues.map((i) => i.message).join("\n")).toMatch(
      /allowOpenEgress was replaced by openEgress/,
    );
    // any other unknown key keeps the plain message
    const other = DeploymentConfig.safeParse({ apiKey: "k", nope: 1 });
    expect(other.error?.issues[0]?.message).toMatch(/Unrecognized key/);
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
