import { readFileSync } from "node:fs";
import { parseSetupGuide, renderSetupGuide, validateSetupGuide } from "@capybara-hq/plugin-sdk";
import { describe, expect, it } from "vitest";

/** The member guide `guides/connect.md` (place `device-connection`). */
const doc = (locale: "en" | "zh") =>
  readFileSync(
    new URL(`../guides/connect${locale === "zh" ? ".zh" : ""}.md`, import.meta.url),
    "utf8",
  );
const manifest = JSON.parse(
  readFileSync(new URL("../.capybara-plugin/plugin.json", import.meta.url), "utf8"),
) as { setupGuides: { id: string; place: string }[] };

describe("setup guide connect", () => {
  it("is the plugin's device-connection guide", () => {
    expect(manifest.setupGuides).toEqual([{ id: "connect", place: "device-connection" }]);
  });

  it("guide parses for place device-connection with the publicUrl", () => {
    expect(
      validateSetupGuide({
        id: "connect",
        place: "device-connection",
        en: doc("en"),
        zh: doc("zh"),
      }),
    ).toEqual([]);
    for (const locale of ["en", "zh"] as const) {
      const parsed = parseSetupGuide(doc(locale));
      expect(parsed.issues).toEqual([]);
      const commands = parsed.codeBlocks.map((b) => b.text.trim());
      expect(commands).toEqual([
        "npm install -g @capybara-hq/device@next",
        "capybara-device login --url {{publicUrl}}",
        "capybara-device service install -c <device id>",
      ]);
    }
  });

  it.each(["en", "zh"] as const)(
    "renders (%s) for a member with the deployment's URL",
    (locale) => {
      const r = renderSetupGuide(doc(locale), {
        place: "device-connection",
        mode: null,
        audience: "member",
        values: {
          publicUrl: "https://cap.example.com",
          orgId: "org-1",
          orgName: "Org",
          pluginName: "device-local",
        },
      });
      const text = JSON.stringify(r.blocks);
      expect(text).toContain("capybara-device login --url https://cap.example.com");
      expect(text).not.toContain("desktop");
      expect(text).toContain("@local");
    },
  );
});
