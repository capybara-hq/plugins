import { readFileSync } from "node:fs";
import {
  PUSH_PROVIDER_EXTENSION_POINT,
  renderSetupGuide,
  validateSetupGuide,
} from "@capybara-hq/plugin-sdk";
import { describe, expect, it } from "vitest";
import plugin, { JPushDeployment } from "../src/index.js";

/** The manifest, the config schema and the platform setup guide. */
const root = new URL("../", import.meta.url);
const read = (p: string) => readFileSync(new URL(p, root), "utf8");

describe("push-jpush manifest", () => {
  it("provides push-provider@1, names JPush's host and declares its one setup check", () => {
    expect(plugin.name).toBe("push-jpush");
    expect(plugin.provides).toEqual([PUSH_PROVIDER_EXTENSION_POINT]);
    expect(plugin.permissions?.network).toEqual(["api.jpush.cn"]);
    expect(plugin.permissions?.setupChecks).toEqual(["jpush-credentials"]);
    expect(plugin.config?.org).toBeUndefined();
  });

  it("keeps the master secret secret and accepts a minimal config", () => {
    const shape = JPushDeployment.shape;
    expect(shape.masterSecret.meta()?.secret).toBe(true);
    expect(shape.appKey.meta()?.secret).not.toBe(true);
    expect(
      JPushDeployment.safeParse({ appKey: "k", masterSecret: "s", applicationIds: ["com.a.b"] })
        .success,
    ).toBe(true);
    expect(
      JPushDeployment.safeParse({ appKey: "k", masterSecret: "s", applicationIds: [] }).success,
    ).toBe(false);
    expect(
      JPushDeployment.safeParse({
        appKey: "k",
        masterSecret: "s",
        applicationIds: ["com.a.b"],
        oppo: { notifyLevel: 16 },
      }).success,
    ).toBe(false);
  });

  it("the guide validates in both languages and runs the credentials check", () => {
    const en = read("guides/jpush-app.md");
    const zh = read("guides/jpush-app.zh.md");
    expect(
      validateSetupGuide({
        place: "extension-deployment",
        en,
        zh,
        pluginChecks: plugin.permissions?.setupChecks ?? [],
        id: "jpush-app",
      }),
    ).toEqual([]);
    const r = renderSetupGuide(en, {
      place: "extension-deployment",
      mode: null,
      audience: "admin",
      values: { pluginName: "push-jpush", pluginVersion: "0.1.0", publicUrl: "https://c.example" },
    });
    expect(JSON.stringify(r)).toContain("jpush-credentials");
  });
});
