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

  it("guide parses for place device-connection with the shell action and publicUrl", () => {
    expect(
      validateSetupGuide({
        id: "connect",
        place: "device-connection",
        en: doc("en"),
        zh: doc("zh"),
      }),
    ).toEqual([]);
    for (const [locale, label] of [
      ["en", "Connect this machine"],
      ["zh", "连接本机"],
    ] as const) {
      const parsed = parseSetupGuide(doc(locale));
      expect(parsed.issues).toEqual([]);
      expect(parsed.shellActions).toMatchObject([{ action: "connect-this-machine", label }]);
      expect(parsed.shellActions[0]?.line).toBe(3);
      const commands = parsed.codeBlocks.map((b) => b.text.trim());
      expect(commands).toEqual([
        "npm install -g @capybara-hq/device@next",
        "capybara-device login --url {{publicUrl}}",
        "capybara-device service install\ncapybara-device service start",
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
      expect(text).toContain("connect-this-machine");
      expect(text).toContain("@local");
    },
  );
});
