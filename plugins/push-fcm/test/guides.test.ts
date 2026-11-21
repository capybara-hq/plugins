import { readFileSync } from "node:fs";
import { renderSetupGuide, validateSetupGuide } from "@capybara-hq/plugin-sdk";
import { describe, expect, it } from "vitest";
import extension from "../src/index.js";

/** The platform setup guide `guides/fcm-service-account.md` (place `extension-deployment`). */
const doc = (locale: "en" | "zh") =>
  readFileSync(
    new URL(`../guides/fcm-service-account${locale === "zh" ? ".zh" : ""}.md`, import.meta.url),
    "utf8",
  );
const values = { pluginName: "push-fcm", pluginVersion: "0.1.0" };

describe("setup guide fcm-service-account", () => {
  it("is valid in both languages and uses only declared checks", () => {
    expect(
      validateSetupGuide({
        id: "fcm-service-account",
        place: "extension-deployment",
        en: doc("en"),
        zh: doc("zh"),
        pluginChecks: extension.permissions?.setupChecks ?? [],
      }),
    ).toEqual([]);
  });

  it.each(["en", "zh"] as const)("renders (%s) with the fcm-credentials check row", (locale) => {
    const r = renderSetupGuide(doc(locale), {
      place: "extension-deployment",
      mode: null,
      audience: "admin",
      values,
    });
    expect(r.title).toBeTruthy();
    expect(JSON.stringify(r.blocks)).toContain("fcm-credentials");
  });
});
