import { readFileSync } from "node:fs";
import { renderSetupGuide, validateSetupGuide } from "@capybara-hq/plugin-sdk";
import { describe, expect, it } from "vitest";
import plugin from "../src/index.js";

/** The platform setup guide `guides/apns-key.md` (place `extension-deployment`) and its zh copy. */
const root = new URL("../", import.meta.url);
const read = (p: string) => readFileSync(new URL(p, root), "utf8");
const manifest = JSON.parse(read(".capybara-plugin/plugin.json")) as {
  setupGuides: { id: string; place: string }[];
};

describe("setup guide apns-key", () => {
  it("is declared once at the extension-deployment place", () => {
    expect(manifest.setupGuides).toEqual([{ id: "apns-key", place: "extension-deployment" }]);
  });

  it("validates in both languages with the plugin's own check", () => {
    const checks = plugin.permissions?.setupChecks ?? [];
    expect(checks).toEqual(["apns-credentials"]);
    const issues = validateSetupGuide({
      id: "apns-key",
      place: "extension-deployment",
      en: read("guides/apns-key.md"),
      zh: read("guides/apns-key.zh.md"),
      pluginChecks: checks,
    });
    expect(issues).toEqual([]);
  });

  it.each(["en", "zh"] as const)("renders in %s with the check row", (locale) => {
    const doc = renderSetupGuide(
      read(locale === "en" ? "guides/apns-key.md" : "guides/apns-key.zh.md"),
      {
        place: "extension-deployment",
        mode: null,
        audience: "admin",
        values: { pluginName: "push-apns", pluginVersion: "0.1.0", publicUrl: "https://c.example" },
      },
    );
    expect(JSON.stringify(doc.blocks)).toContain("apns-credentials");
  });
});
