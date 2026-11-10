import { defineExtension, type UiRenderArgs } from "@capybara-hq/plugin-sdk";
import { describe, expect, it } from "vitest";
import extension, { hudData } from "../src/index.js";
import { parseHudData } from "../src/shared.js";

/** The extension manifest (server side); the packed plugin.json is checked in pack.test.ts. */
describe("theme-cyberpunk extension", () => {
  it("declares client code and its five components, each in its slot", () => {
    const m = defineExtension(extension);
    expect(m.permissions?.client).toBe(true);
    expect(m.permissions?.ui?.components).toEqual([
      "run-hud",
      "scanlines",
      "boot",
      "brand",
      "hero",
    ]);
    expect(m.ui?.map((c) => [c.id, c.slot, c.kind])).toEqual([
      ["run-hud", "conversation.properties.section", "component"],
      ["scanlines", "shell.overlay", "component"],
      ["boot", "shell.overlay", "component"],
      ["brand", "shell.brand", "component"],
      ["hero", "conversation.empty", "component"],
    ]);
    expect(m.ui?.find((c) => c.id === "run-hud")?.after).toBe("context");
  });

  it("the HUD view data carries the viewer's role and the render time", () => {
    const args = {
      role: "member",
      orgId: "org_1",
      conversationId: "conv_1",
    } as unknown as UiRenderArgs;
    const data = hudData(args, new Date("2026-11-10T08:00:00.000Z"));
    expect(data).toEqual({ operator: "member", uplink: "2026-11-10T08:00:00.000Z" });
    expect(parseHudData(data)).toEqual(data);
    expect(parseHudData({ operator: 1 })).toBeNull();
    expect(JSON.stringify(data).length).toBeLessThan(32_768);
  });
});
