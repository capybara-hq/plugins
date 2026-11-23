import { readFileSync } from "node:fs";
import { DEVICE_PROVIDER_EXTENSION_POINT, parseDeviceReport } from "@capybara-hq/plugin-sdk";
import {
  assertExtensionSecretsReachable,
  extensionDeploymentSecretValues,
} from "@capybara-hq/testing";
import { describe, expect, it } from "vitest";
import plugin, {
  createE2BSandbox,
  DeploymentConfig,
  decodeOutput,
  exitCodeOf,
  providerConfig,
  publishedImage,
  templateAlias,
} from "../src/index.js";

const silent = { debug() {}, info() {}, warn() {}, error() {} } as unknown as Parameters<
  typeof createE2BSandbox
>[1]["log"];

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
describe("device-e2b manifest", () => {
  it("provides device-provider@1 and declares no platform permissions", () => {
    expect(plugin.name).toBe("device-e2b");
    expect(DEVICE_PROVIDER_EXTENSION_POINT).toBe("device-provider@1");
    expect(plugin.provides).toEqual([DEVICE_PROVIDER_EXTENSION_POINT]);
    expect(plugin.permissions).toEqual({});
    // the kernel checks this range against the installed SDK version; device-provider@1 is the
    // rc.51 SDK's
    expect(plugin.sdk).toBe("^0.1.0-rc.64");
  });

  it("declares networkAllowlist (also without domainAllowlist) and ships the device-connection guide", () => {
    for (const domainAllowlist of [true, false]) {
      const sbx = createE2BSandbox(
        providerConfig(DeploymentConfig.parse({ apiKey: "k", domainAllowlist })),
        { log: silent },
      );
      expect(sbx.networkAllowlist).toBe(true);
    }
    const manifest = JSON.parse(
      readFileSync(new URL("../.capybara-plugin/plugin.json", import.meta.url), "utf8"),
    ) as { name: string; setupGuides?: unknown };
    expect(manifest.name).toBe("device-e2b");
    expect(manifest.setupGuides).toEqual([{ id: "connect", place: "device-connection" }]);
    for (const file of ["connect.md", "connect.zh.md"]) {
      const text = readFileSync(new URL(`../guides/${file}`, import.meta.url), "utf8");
      expect(text.startsWith("# ")).toBe(true);
    }
  });

  it("report describes the microVM, names the metadata residual and offers reset", async () => {
    const sig = AbortSignal.timeout(5000);
    const sbx = createE2BSandbox(providerConfig(DeploymentConfig.parse({ apiKey: "k" })), {
      log: silent,
    });
    const alias = templateAlias(publishedImage(plugin.version));
    const none = await sbx.report({ deviceId: "d1", orgId: "o1", handle: null }, sig);
    expect(none).toMatchObject({ reset: true, home: null, limits: [] });
    expect(none.revision).toBe(`${plugin.version}:${alias}:none`);
    expect(none.description.en).toMatch(/E2B sandbox \(microVM\).*metadata service/);
    expect(none.description.zh).toMatch(/元数据端点/);
    expect(none.changeHint).toEqual({
      en: "CPU, memory and disk come from the E2B template in this extension's deployment config (a super admin's); the network is this device's network setting, within the organization's and the platform's limits. The microVM is the whole sandbox: nothing runs outside it.",
      zh: "CPU、内存和磁盘来自本扩展部署配置中的 E2B 模板（由超级管理员设置）；网络是这台设备的网络设置，在组织和平台的限制之内。虚拟机就是整个沙箱，没有命令在它之外运行。",
    });
    expect(parseDeviceReport(none)).toEqual(none);
    const own = createE2BSandbox(
      providerConfig(DeploymentConfig.parse({ apiKey: "k", template: "my-template" })),
      { log: silent },
    );
    const withHandle = await own.report(
      { deviceId: "d1", orgId: "o1", handle: { id: "sbx1" } },
      sig,
    );
    expect(withHandle.revision).toBe(`${plugin.version}:my-template:sbx1`);
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
    });
    const c = DeploymentConfig.parse({ apiKey: "e2b_x", template: "capybara-sandbox" });
    expect(c).toEqual({
      apiKey: "e2b_x",
      template: "capybara-sandbox",
      domain: "e2b.app",
      timeoutSeconds: 3600,
      domainAllowlist: true,
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

  it("the removed openEgress / allowOpenEgress point at the network policy", () => {
    for (const key of ["openEgress", "allowOpenEgress"]) {
      const r = DeploymentConfig.safeParse({ apiKey: "k", [key]: "proxy" });
      expect(r.success).toBe(false);
      expect(r.error?.issues.map((i) => i.message).join("\n")).toMatch(
        /the org cloud network decides/,
      );
    }
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
