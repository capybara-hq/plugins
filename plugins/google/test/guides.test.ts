import { readFileSync } from "node:fs";
import { renderSetupGuide, validateSetupGuide } from "@capybara-hq/plugin-sdk";
import { describe, expect, it } from "vitest";
import extension from "../src/index.js";

/** The platform setup guide `guides/google-sign-in.md` (place `extension-deployment`). */
const doc = (locale: "en" | "zh") =>
  readFileSync(
    new URL(`../guides/google-sign-in${locale === "zh" ? ".zh" : ""}.md`, import.meta.url),
    "utf8",
  );
const values = { pluginName: "google", pluginVersion: "0.1.0", publicUrl: "https://cap.example" };

describe("setup guide google-sign-in", () => {
  it("is valid in both languages and uses only declared checks", () => {
    expect(
      validateSetupGuide({
        id: "google-sign-in",
        place: "extension-deployment",
        en: doc("en"),
        zh: doc("zh"),
        pluginChecks: extension.permissions?.setupChecks ?? [],
      }),
    ).toEqual([]);
  });

  it.each(["en", "zh"] as const)("renders (%s) with both checks and the callback URL", (locale) => {
    const r = renderSetupGuide(doc(locale), {
      place: "extension-deployment",
      mode: null,
      audience: "admin",
      values,
    });
    expect(r.title).toBeTruthy();
    const text = JSON.stringify(r.blocks);
    expect(text).toContain("google-discovery");
    expect(text).toContain("google-client");
    expect(text).toContain("https://cap.example/api/v1/auth/sso/google/callback");
    expect(text).toContain("google:consumer");
  });

  it("the zh guide uses the platform terms", () => {
    const zh = doc("zh");
    expect(zh).not.toContain("企业");
    expect(zh).not.toMatch(/\bagents?\b/i);
  });
});
