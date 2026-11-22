import {
  isProjectPathRefusedError,
  isSandboxScopeDeniedError,
  ProjectPathRefusedError,
} from "@capybara-hq/plugin-sdk";
import { parseDeviceFrame } from "@capybara-hq/plugin-sdk/device-protocol";
import { describe, expect, it } from "vitest";
import { failureOf, PROJECT_REFUSAL_TEXT, projectRefusalError } from "../src/index.js";

/** A machine's failure body as the parser hands it to the provider. */
const failure = (error: Record<string, unknown>) => {
  const res = parseDeviceFrame({ ok: false, error }, "res");
  if (res.ok) throw new Error("expected a failure");
  return res.error;
};

describe("project refusals", () => {
  it("maps each refusal code to fixed text, never the machine's message", () => {
    for (const refusal of ["other-connection", "outside-reach", "denied"] as const) {
      for (const op of ["list", "scan", "browseList", "browseScan"]) {
        const e = failureOf(
          failure({ kind: "project_refused", message: "<b>evil</b>", refusal }),
          op,
        );
        expect(e).toBeInstanceOf(ProjectPathRefusedError);
        expect(isProjectPathRefusedError(e)).toBe(true);
        expect((e as ProjectPathRefusedError).reason).toEqual(PROJECT_REFUSAL_TEXT[refusal]);
        expect(e.message).not.toContain("evil");
      }
      expect(projectRefusalError(refusal).reason).toEqual(PROJECT_REFUSAL_TEXT[refusal]);
    }
    expect(PROJECT_REFUSAL_TEXT["other-connection"]).toEqual({
      en: "This directory belongs to another connection on this machine.",
      zh: "这个目录属于本机上的另一个连接。",
    });
    expect(PROJECT_REFUSAL_TEXT["outside-reach"]).toEqual({
      en: "This directory is outside the project reach the machine's owner set for this device.",
      zh: "这个目录不在本机所有者为此设备设定的项目范围内。",
    });
    expect(PROJECT_REFUSAL_TEXT.denied).toEqual({
      en: "This directory holds secrets or the device program's own state.",
      zh: "这个目录存放密钥或设备程序自身的状态。",
    });
    for (const t of Object.values(PROJECT_REFUSAL_TEXT)) expect(t.zh).not.toMatch(/agent|企业/i);
    // a denied outcome stays the scope error
    const denied = failureOf(failure({ kind: "denied", message: "outside the scope" }), "list");
    expect(isSandboxScopeDeniedError(denied)).toBe(true);
    expect(isProjectPathRefusedError(denied)).toBe(false);
  });
});
