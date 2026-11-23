import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  DEVICE_PROVIDER_EXTENSION_POINT,
  isSandboxGoneError,
  type SandboxLimits,
} from "@capybara-hq/plugin-sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import plugin, {
  createDockerSandbox,
  DeploymentConfig,
  decodeOutput,
  providerConfig,
} from "../src/index.js";
import { parseSizeMb, reportLimitLines } from "../src/provider.js";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  version: string;
};

/** Limits carrying the network contract the kernel sends (rc.22). */
const netLimits = (network: SandboxLimits["network"]): SandboxLimits => ({
  cpu: 1,
  memoryMb: 256,
  diskMb: 256,
  network,
});

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

/** The manifest and the deployment config (no Docker needed). */
describe("device-docker manifest", () => {
  it("provides device-provider@1 and declares no platform permissions", () => {
    expect(plugin.name).toBe("device-docker");
    expect(DEVICE_PROVIDER_EXTENSION_POINT).toBe("device-provider@1");
    expect(plugin.provides).toEqual([DEVICE_PROVIDER_EXTENSION_POINT]);
    expect(plugin.permissions).toEqual({});
    // the kernel checks this range against the installed SDK version; device-provider@1 is the
    // rc.51 SDK's
    expect(plugin.sdk).toBe("^0.1.0-rc.51");
  });

  it("declares networkAllowlist and ships the device-connection guide in both languages", () => {
    const sbx = createDockerSandbox(
      providerConfig(DeploymentConfig.parse({ endpoint: "tcp://x:1" })),
    );
    expect(sbx.networkAllowlist).toBe(true);
    const manifest = JSON.parse(
      readFileSync(new URL("../.capybara-plugin/plugin.json", import.meta.url), "utf8"),
    ) as { name: string; setupGuides?: unknown };
    expect(manifest.name).toBe("device-docker");
    expect(manifest.setupGuides).toEqual([{ id: "connect", place: "device-connection" }]);
    for (const file of ["connect.md", "connect.zh.md"]) {
      const text = readFileSync(new URL(`../guides/${file}`, import.meta.url), "utf8");
      expect(text.startsWith("# ")).toBe(true);
    }
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

  it("deployment config: deniedCidrs takes IPv4 / IPv6 CIDRs and reaches the provider", () => {
    const denied = ["203.0.113.0/24", "198.51.100.7/32", "2001:db8::/32"];
    const c = DeploymentConfig.parse({ endpoint: "tcp://x:1", deniedCidrs: denied });
    expect(c.deniedCidrs).toEqual(denied);
    expect(providerConfig(c).deniedCidrs).toEqual(denied);
    expect(DeploymentConfig.parse({ endpoint: "tcp://x:1" }).deniedCidrs).toBeUndefined();
    for (const bad of [
      "203.0.113.1",
      "203.0.113.0/33",
      "::/129",
      "example.com/24",
      "10.0.0.0/8 ",
    ]) {
      const r = DeploymentConfig.safeParse({ endpoint: "tcp://x:1", deniedCidrs: [bad] });
      expect(r.success, bad).toBe(false);
      expect(r.error?.issues[0]?.message).toMatch(/CIDR/);
    }
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
    ).rejects.toThrow(/extensionConfig\."device-docker"\.refuseOpenNetwork/);
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

describe("refuseOpenNetwork on resume and auto-start (stub Docker API, no Docker needed)", () => {
  const ID = "cap-device-00000000-0000-4000-8000-000000000002";
  /** Requests the stub saw, as "METHOD /path" without the API version. */
  const seen: string[] = [];
  let labels: Record<string, string> = {};
  let server: Server;
  let endpoint = "";
  beforeAll(async () => {
    server = createServer((req, res) => {
      const path = (req.url ?? "").replace(/^\/v[\d.]+/, "").split("?")[0] ?? "";
      seen.push(`${req.method} ${path}`);
      req.resume();
      res.setHeader("content-type", "application/json");
      if (req.method === "GET" && path === `/containers/${ID}/json`) {
        res.end(JSON.stringify({ State: { Running: false }, Config: { Labels: labels } }));
        return;
      }
      // a stopped container: exec answers 409 (auto-start), anything else is an error
      if (req.method === "POST" && path === `/containers/${ID}/exec`) {
        res.statusCode = 409;
        res.end(JSON.stringify({ message: `container ${ID} is not running` }));
        return;
      }
      res.statusCode = 500;
      res.end(JSON.stringify({ message: "unexpected request in this test" }));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    endpoint = `tcp://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await new Promise((r) => server.close(r));
  });
  const sbxWith = (refuseOpenNetwork: boolean) =>
    createDockerSandbox(providerConfig(DeploymentConfig.parse({ endpoint, refuseOpenNetwork })));
  const openLabels = {
    "dev.capybara.sandbox.network": "open-public",
    "dev.capybara.sandbox.allow-hosts": "[]",
  };
  const sig = () => AbortSignal.timeout(5000);

  it("an instance labelled open-public resumes as gone, starting nothing", async () => {
    labels = openLabels;
    seen.length = 0;
    expect(await sbxWith(true).resume({ id: ID }, sig())).toBe("gone");
    expect(seen).toEqual([`GET /containers/${ID}/json`]);
  });

  it("auto-start of an instance labelled open-public answers SandboxGoneError", async () => {
    labels = openLabels;
    seen.length = 0;
    const e = await sbxWith(true)
      .exec(
        { id: ID },
        {
          tag: "t",
          actor: { accountId: "a", conversationId: "c" },
          command: "true",
          timeoutMs: 1000,
          maxOutputBytes: 100,
          signal: sig(),
        },
      )
      .catch((x: unknown) => x);
    expect(isSandboxGoneError(e)).toBe(true);
    expect(seen.some((s) => s.endsWith("/start"))).toBe(false);
  });

  it("without refuseOpenNetwork, or with an allowlist label, resume goes on (reaches Docker)", async () => {
    for (const [refuse, l] of [
      [false, openLabels],
      [
        true,
        {
          "dev.capybara.sandbox.network": "allowlist",
          "dev.capybara.sandbox.allow-hosts": '["pypi.org"]',
        },
      ],
    ] as const) {
      labels = l;
      seen.length = 0;
      // the stub answers 500 to the egress proxy calls that follow: not "gone"
      await expect(sbxWith(refuse).resume({ id: ID }, sig())).rejects.toThrow();
      expect(seen.length).toBeGreaterThan(1);
    }
  });
});

describe("device report (stub Docker API, no Docker needed)", () => {
  const ID = "cap-device-00000000-0000-4000-8000-000000000003";
  let server: Server;
  let endpoint = "";
  beforeAll(async () => {
    server = createServer((req, res) => {
      const path = (req.url ?? "").replace(/^\/v[\d.]+/, "").split("?")[0] ?? "";
      req.resume();
      res.setHeader("content-type", "application/json");
      if (req.method === "GET" && path === `/containers/${ID}/json`) {
        res.end(
          JSON.stringify({ HostConfig: { NanoCpus: 1_500_000_000, Memory: 2048 * 1024 ** 2 } }),
        );
        return;
      }
      if (req.method === "GET" && path === `/volumes/${ID}-workspace`) {
        res.end(JSON.stringify({ Name: `${ID}-workspace`, Options: { size: "4096M" } }));
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ message: "no such object" }));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    endpoint = `tcp://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await new Promise((r) => server.close(r));
  });
  const sig = () => AbortSignal.timeout(5000);
  const ref = (handle: { id: string } | null) => ({ deviceId: "d1", orgId: "o1", handle });

  it("describes the container and offers reset; no limits without an instance", async () => {
    const sbx = createDockerSandbox(providerConfig(DeploymentConfig.parse({ endpoint })));
    const r = await sbx.report(ref(null), sig());
    expect(r).toMatchObject({ reset: true, home: null, limits: [] });
    expect(r.description.en).toMatch(/Docker container/);
    expect(r.description.zh).toMatch(/Docker 容器/);
    expect(r.revision).toBe(`${plugin.version}:runc:none`);
  });

  it("reads cpu and memory from the container, disk only from a sized volume driver", async () => {
    const plain = createDockerSandbox(providerConfig(DeploymentConfig.parse({ endpoint })));
    const r = await plain.report(ref({ id: ID }), sig());
    expect(r.limits).toEqual([
      { label: { en: "CPU", zh: "CPU" }, value: { en: "1.5" } },
      { label: { en: "Memory", zh: "内存" }, value: { en: "2048 MB" } },
    ]);
    expect(r.revision).toBe(`${plugin.version}:runc:${ID}:1.5-2048--`);
    const sized = createDockerSandbox(
      providerConfig(DeploymentConfig.parse({ endpoint, volumeDriver: "sized", runtime: "runsc" })),
    );
    const s = await sized.report(ref({ id: ID }), sig());
    expect(s.limits.map((l) => l.value.en)).toEqual(["1.5", "2048 MB", "4096 MB"]);
    expect(s.revision).toBe(`${plugin.version}:runsc:${ID}:1.5-2048-4096`);
  });

  it("a gone container reports no limits", async () => {
    const sbx = createDockerSandbox(providerConfig(DeploymentConfig.parse({ endpoint })));
    const r = await sbx.report(ref({ id: "cap-device-gone" }), sig());
    expect(r.limits).toEqual([]);
    expect(r.revision).toBe(`${plugin.version}:runc:cap-device-gone`);
  });

  it("parses volume sizes and formats limit lines", () => {
    expect(parseSizeMb("4096M")).toBe(4096);
    expect(parseSizeMb("2G")).toBe(2048);
    expect(parseSizeMb("512mb")).toBe(512);
    expect(parseSizeMb(undefined)).toBeNull();
    expect(parseSizeMb("lots")).toBeNull();
    expect(reportLimitLines({ cpu: null, memoryMb: null, diskMb: null })).toEqual([]);
  });
});
