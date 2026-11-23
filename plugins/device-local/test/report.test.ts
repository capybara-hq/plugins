import { DEVICE_REPORT_LIMITS, parseDeviceReport } from "@capybara-hq/plugin-sdk";
import type { DeviceProjectReach } from "@capybara-hq/plugin-sdk/device-protocol";
import { describe, expect, it } from "vitest";
import {
  type Connection,
  describeLocalDevice,
  deviceReportOf,
  reportMoved,
  sharedRootsValue,
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
    expect(reachLimit(connection("machine"))).toEqual({ label, value: "machine" });
    expect(reachLimit(connection("paths"))).toEqual({ label, value: "listed directories" });
    expect(reachLimit(connection("workspace"))).toEqual({ label, value: "workspace" });
    expect(reachLimit(connection("machine", "docker"))).toEqual({ label, value: "workspace" });
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
        value: "/p/shared, /p/two",
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

  it("fits many or long shared directories in one limit value", () => {
    const max = DEVICE_REPORT_LIMITS.limitValueChars;
    const many = Array.from({ length: 20 }, (_, i) => `/home/me/projects/p${i}`);
    const value = sharedRootsValue(many);
    expect(value.length).toBeLessThanOrEqual(max);
    // a language-neutral count of the rest (the value is shown as is in every UI language)
    expect(value).toMatch(/^\/home\/me\/projects\/p0, .* \+\d+$/);
    const long = `/home/me/${"x".repeat(100)}/end`;
    expect(sharedRootsValue([long]).length).toBeLessThanOrEqual(max);
    expect(sharedRootsValue([long])).toMatch(/^….*\/end$/);
    // a root too long is skipped, the others that fit are kept whole
    expect(sharedRootsValue(["/a", long, "/p/b"].sort())).toBe("/a, /p/b +1");
    expect(sharedRootsValue([long, "/p/b"])).toBe("/p/b +1");
    // only when no root fits whole: the end of the shortest one
    const longer = `/home/me/${"y".repeat(120)}/other`;
    const both = sharedRootsValue([long, longer].sort());
    expect(both).toMatch(/^….*\/end \+1$/);
    expect(both.length).toBeLessThanOrEqual(max);
    const report = deviceReportOf(connection("paths", "os", many), null);
    expect(parseDeviceReport(report)).toEqual(report);
  });
});
