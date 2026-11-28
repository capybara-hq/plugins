import { DEVICE_REPORT_LIMITS, parseDeviceReport } from "@capybara-hq/plugin-sdk";
import type { DeviceProjectReach } from "@capybara-hq/plugin-sdk/device-protocol";
import { describe, expect, it } from "vitest";
import {
  type Binding,
  type Connection,
  describeLocalDevice,
  deviceReportOf,
  reportMoved,
  sharedRootsValue,
  supportOf,
} from "../src/index.js";
import { OWNER_CEILING, ROOTS, SUPPORT } from "./fakes.js";

const connection = (
  projectReach: DeviceProjectReach,
  mode: "os" | "docker" = "os",
  sharedProjectRoots: string[] = [],
): Connection => ({
  deviceId: "dev-1",
  orgId: "org-1",
  machineId: "machine-1",
  connectionId: "connection-1",
  machineEpoch: 1,
  mode,
  roots: ROOTS,
  home: "/home/me",
  sessionIsolation: false,
  features: ["projects"],
  permissionSupport: SUPPORT,
  ownerReport: {
    report: { ...OWNER_CEILING, projectReach },
    observedAt: "2026-11-23T00:00:00.000Z",
    via: "hello",
  },
  sharedProjectRoots,
  instanceGeneration: null,
  runtimeIdentity: null,
});

const reachLimit = (c: Connection) =>
  deviceReportOf(c, null).limits.find((l) => l.label.en === "Project reach");

describe("the local device report", () => {
  it("says who changes the limits and how, with the connection's device id", () => {
    const report = parseDeviceReport(deviceReportOf(connection("machine"), null));
    expect(report.changeHint).toEqual({
      en: "Only the owner of the computer changes these limits, on that computer: capybara-device ceiling set -c dev-1 --outside-sandbox on|off --network open|allowlist --project-reach machine|paths|workspace",
      zh: "只有这台电脑的所有者能在电脑上更改这些限制：capybara-device ceiling set -c dev-1 --outside-sandbox on|off --network open|allowlist --project-reach machine|paths|workspace",
    });
    // a real device id (a uuid) still fits the report's limit
    const long = parseDeviceReport(
      deviceReportOf({ ...connection("machine"), deviceId: "0".repeat(36) }, null),
    );
    expect(long.changeHint?.en.length).toBeLessThanOrEqual(DEVICE_REPORT_LIMITS.changeHintChars);
    // before the machine connects there is nothing to change yet
    expect(deviceReportOf(null, null).changeHint).toBeUndefined();
  });

  it("describes each reach in en and zh", () => {
    const machine = describeLocalDevice({
      projectReach: "machine",
      outsideSandbox: false,
      mode: "os",
    });
    expect(machine).toEqual({
      en: "Reads the whole machine except secrets and other connections; writes only in the project and workspace; the machine's owner keeps every call in the sandbox",
      zh: "读取本机全部文件（密钥和其他连接除外）；只在项目和工作区写入；本机所有者让每个调用都留在沙箱内",
    });
    const outside = describeLocalDevice({
      projectReach: "machine",
      outsideSandbox: true,
      mode: "os",
    });
    expect(outside.en.endsWith("runs outside the sandbox only per approved call")).toBe(true);
    expect(outside.zh.endsWith("仅在获批的单次调用中在沙箱外运行")).toBe(true);
    const paths = describeLocalDevice({ projectReach: "paths", outsideSandbox: false, mode: "os" });
    expect(
      paths.en.startsWith("Reads only the project directories the machine's owner listed"),
    ).toBe(true);
    expect(paths.zh.startsWith("只读取本机所有者列出的项目目录")).toBe(true);
    const workspace = describeLocalDevice({
      projectReach: "workspace",
      outsideSandbox: false,
      mode: "os",
    });
    // a Docker container sees only the workspace, whatever the owner set
    const docker = describeLocalDevice({
      projectReach: "machine",
      outsideSandbox: false,
      mode: "docker",
    });
    for (const d of [workspace, docker]) {
      expect(d.en.startsWith("Reads and writes only the device's workspace")).toBe(true);
      expect(d.zh.startsWith("只读写设备的工作区")).toBe(true);
    }
    for (const d of [machine, outside, paths, workspace, docker]) {
      expect(d.zh).not.toMatch(/agent|企业/i);
    }
    // the report's description carries the same line
    expect(deviceReportOf(connection("paths"), null).description.en).toContain(paths.en);
  });

  it("lists the project reach under limits and changes the revision with it", () => {
    const label = { en: "Project reach", zh: "项目范围" };
    const workspace = { en: "workspace", zh: "工作区" };
    expect(reachLimit(connection("machine"))).toEqual({
      label,
      value: { en: "machine", zh: "整台机器" },
    });
    expect(reachLimit(connection("paths"))).toEqual({
      label,
      value: { en: "listed directories", zh: "列出的目录" },
    });
    expect(reachLimit(connection("workspace"))).toEqual({ label, value: workspace });
    expect(reachLimit(connection("machine", "docker"))).toEqual({ label, value: workspace });
    const revisions = (["machine", "paths", "workspace"] as const).map(
      (r) => deviceReportOf(connection(r), null).revision,
    );
    expect(new Set(revisions).size).toBe(3);
    expect(deviceReportOf(connection("paths"), null).revision).toBe(revisions[1]);
  });

  it("names the shared project directories in the limits, never the other connection", () => {
    const report = deviceReportOf(connection("paths", "os", ["/p/shared", "/p/two"]), null);
    const shared = report.limits.filter((l) => l.label.en.startsWith("Also used"));
    expect(shared).toEqual([
      {
        label: {
          en: "Also used by another connection on this computer",
          zh: "本机的另一个连接也在使用",
        },
        value: { en: "/p/shared, /p/two", zh: "/p/shared, /p/two" },
      },
    ]);
    // the kernel's own check passes
    expect(parseDeviceReport(report)).toEqual(report);
    // nothing in the report names a connection: only this one's directories
    expect(JSON.stringify(report)).not.toMatch(/connection-1|machine-1/);
  });

  it("an older device without shared directories shows no such line", () => {
    for (const c of [connection("paths"), connection("machine", "docker")])
      expect(deviceReportOf(c, null).limits.some((l) => l.label.en.startsWith("Also used"))).toBe(
        false,
      );
  });

  it("keeps the revision when only the shared directories change, but the report moved", () => {
    const none = connection("paths");
    const some = connection("paths", "os", ["/p/shared"]);
    expect(deviceReportOf(some, null).revision).toBe(deviceReportOf(none, null).revision);
    const rows = (c: Connection) => ({ connection: c, binding: null });
    expect(reportMoved(rows(none), rows(some))).toBe(true);
    expect(reportMoved(rows(some), rows(connection("paths", "os", ["/p/shared"])))).toBe(false);
    // a ceiling change moves both
    expect(reportMoved(rows(none), rows(connection("machine")))).toBe(true);
  });

  it("fits many or long shared directories in one limit value per language", () => {
    const max = DEVICE_REPORT_LIMITS.limitValueChars;
    const many = Array.from({ length: 20 }, (_, i) => `/home/me/projects/p${i}`);
    const value = sharedRootsValue(many);
    expect(value.en.length).toBeLessThanOrEqual(max);
    expect(value.zh.length).toBeLessThanOrEqual(max);
    // the rest is counted in words of each UI language
    expect(value.en).toMatch(/^\/home\/me\/projects\/p0, .* \+\d+ more$/);
    expect(value.zh).toMatch(/^\/home\/me\/projects\/p0, .*；另有 \d+ 个$/);
    const long = `/home/me/${"x".repeat(100)}/end`;
    // no root left out: no count, the same text in both languages
    expect(sharedRootsValue([long]).en.length).toBeLessThanOrEqual(max);
    expect(sharedRootsValue([long]).en).toMatch(/^….*\/end$/);
    expect(sharedRootsValue([long]).zh).toBe(sharedRootsValue([long]).en);
    // a root too long is skipped, the others that fit are kept whole
    expect(sharedRootsValue(["/a", long, "/p/b"].sort())).toEqual({
      en: "/a, /p/b +1 more",
      zh: "/a, /p/b；另有 1 个",
    });
    expect(sharedRootsValue([long, "/p/b"])).toEqual({ en: "/p/b +1 more", zh: "/p/b；另有 1 个" });
    // only when no root fits whole: the end of the shortest one
    const longer = `/home/me/${"y".repeat(120)}/other`;
    const both = sharedRootsValue([long, longer].sort());
    expect(both.en).toMatch(/^….*\/end \+1 more$/);
    expect(both.zh).toMatch(/^….*\/end；另有 1 个$/);
    expect(both.en.length).toBeLessThanOrEqual(max);
    expect(both.zh.length).toBeLessThanOrEqual(max);
    const report = deviceReportOf(connection("paths", "os", many), null);
    expect(parseDeviceReport(report)).toEqual(report);
  });
});

describe("loopback port support", () => {
  const HASH = (c: string) => c.repeat(64);
  const outside = { ...SUPPORT, outsideSandbox: true };
  const bindingWith = (permissionSupport: typeof SUPPORT): Binding => ({
    deviceId: "dev-1",
    instanceId: "dev-1",
    generation: "1",
    bindingId: "b-1",
    previousGeneration: null,
    status: "installed",
    installed: {
      runtimeIdentity: {
        runtimeHash: HASH("a"),
        helperHash: HASH("b"),
        imageFingerprint: HASH("c"),
        instanceGeneration: "1",
      },
      permissionSupport,
      ownerCeiling: { ...OWNER_CEILING, outsideSandbox: true },
    },
  });
  const binding = bindingWith(outside);
  /** A macOS machine (its home under /Users) with the owner ceiling `ownerOutside`. */
  const mac = (features: Connection["features"], ownerOutside = true): Connection => ({
    ...connection("machine"),
    home: "/Users/me",
    features,
    ownerReport: {
      report: { ...OWNER_CEILING, outsideSandbox: ownerOutside },
      observedAt: "2026-11-23T00:00:00.000Z",
      via: "hello",
    },
  });
  const handle = { id: "dev-1", generation: "1" };

  it("reports loopbackPorts for a macOS machine with the feature", () => {
    const s = supportOf(handle, mac(["networkReport", "projects", "loopbackPorts"]), binding);
    expect(s.network.loopbackPorts).toBe(true);
    expect(s.limitedBy?.loopbackPorts).toBeUndefined();
  });

  it("reports device-update for a macOS machine without it", () => {
    const s = supportOf(handle, mac(["networkReport", "projects"]), binding);
    expect(s.network.loopbackPorts).toBeUndefined();
    expect(s.limitedBy).toEqual({ loopbackPorts: "device-update" });
  });

  it("reports false when the owner forbids running outside the sandbox", () => {
    const s = supportOf(
      handle,
      mac(["networkReport", "projects", "loopbackPorts"], false),
      binding,
    );
    expect(s.outsideSandbox).toBe(false);
    expect(s.network.loopbackPorts).toBe(false);
    expect(s.limitedBy).toEqual({ outsideSandbox: "owner" });
  });

  it("a machine that never runs outside the sandbox reports no loopback ports", () => {
    const sandboxed = bindingWith(SUPPORT);
    const s = supportOf(handle, mac(["networkReport", "projects", "loopbackPorts"]), sandboxed);
    expect(s.network.loopbackPorts).toBe(false);
    expect(s.limitedBy).toBeUndefined();
  });

  it("a Linux or Docker machine without the feature reports as before", () => {
    const linux = { ...mac(["networkReport", "projects"]), home: "/home/me" };
    const s = supportOf(handle, linux, binding);
    expect(s.network).toEqual(SUPPORT.network);
    expect(s.limitedBy).toBeUndefined();
    const docker = { ...mac(["networkReport", "projects"]), mode: "docker" as const };
    expect(supportOf(handle, docker, binding).limitedBy).toBeUndefined();
  });
});
