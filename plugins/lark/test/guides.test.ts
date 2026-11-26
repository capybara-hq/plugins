import { readFileSync } from "node:fs";
import { parsePluginManifest, renderSetupGuide, validateSetupGuide } from "@capybara-hq/plugin-sdk";
import { describe, expect, it } from "vitest";
import extension from "../src/index.js";

/** The platform setup guide `guides/lark-sign-in.md` (place `extension-deployment`). */
const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const doc = (locale: "en" | "zh") => read(`guides/lark-sign-in${locale === "zh" ? ".zh" : ""}.md`);
const values = {
  pluginName: "lark",
  pluginVersion: "0.1.0",
  publicUrl: "https://cap.example",
  signInCallbackUrl: "https://cap.example/api/v1/auth/sso/lark/callback",
};
const render = (locale: "en" | "zh", vals: Record<string, string> = values) =>
  renderSetupGuide(doc(locale), {
    place: "extension-deployment",
    mode: null,
    audience: "admin",
    values: vals,
  });

describe("setup guide lark-sign-in", () => {
  it("plugin.json declares it", () => {
    const m = JSON.parse(read(".capybara-plugin/plugin.json"));
    const parsed = parsePluginManifest(m);
    expect("errors" in parsed ? parsed.errors : []).toEqual([]);
    expect(m.setupGuides).toEqual([{ id: "lark-sign-in", place: "extension-deployment" }]);
  });

  it("is valid in both languages and uses only declared checks", () => {
    expect(
      validateSetupGuide({
        id: "lark-sign-in",
        place: "extension-deployment",
        en: doc("en"),
        zh: doc("zh"),
        pluginChecks: extension.permissions?.setupChecks ?? [],
      }),
    ).toEqual([]);
  });

  it.each(["en", "zh"] as const)(
    "renders (%s) with the callback URL, the app fields and the login source",
    (locale) => {
      const r = render(locale);
      expect(r.title).toBeTruthy();
      expect(r.unresolved).toEqual([]);
      expect(r.blocks.flatMap((b) => (b.kind === "code" ? [b.text.trim()] : []))).toEqual([
        values.signInCallbackUrl,
      ]);
      expect(r.checks.map((c) => c.id)).toEqual(["capybara:public-url"]);
      const text = JSON.stringify(r.blocks);
      for (const s of [
        "`appId`",
        "`appSecret`",
        "`open_id`",
        "`tenant:tenant:readonly`",
        "`login-sources.update`",
        locale === "zh" ? "「在登录页显示」" : "**Show on the login page**",
        locale === "zh" ? "「自动注册新账号」" : "**Create a new account**",
        "20010",
      ])
        expect(text, s).toContain(s);
    },
  );

  it("without a public URL the callback is reported unresolved", () => {
    const { signInCallbackUrl: _, ...rest } = values;
    expect(render("en", rest).unresolved).toEqual(["signInCallbackUrl"]);
  });

  it("the zh guide uses the platform terms", () => {
    const zh = doc("zh");
    expect(zh).not.toContain("企业");
    expect(zh).not.toMatch(/\bagents?\b/i);
  });
});
