import type { DeviceProjectReach } from "@capybara-hq/plugin-sdk/device-protocol";
import { describe, expect, it } from "vitest";
import { type Connection, describeLocalDevice, deviceReportOf } from "../src/index.js";
import { OWNER_CEILING, ROOTS, SUPPORT } from "./fakes.js";

const connection = (
  projectReach: DeviceProjectReach,
  mode: "os" | "docker" = "os",
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
  instanceGeneration: null,
  runtimeIdentity: null,
});

const reachLimit = (c: Connection) =>
  deviceReportOf(c, null).limits.find((l) => l.label.en === "Project reach");

describe("the local device report", () => {
  it("describes each reach in en and zh", () => {
    const machine = describeLocalDevice({
      projectReach: "machine",
      outsideSandbox: false,
      mode: "os",
    });
    expect(machine).toEqual({
      en: "Reads the whole machine except secrets and other connections; writes only in the project and workspace; never runs outside the sandbox",
      zh: "读取本机全部文件（密钥和其他连接除外）；只在项目和工作区写入；从不在沙箱外运行",
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
});
