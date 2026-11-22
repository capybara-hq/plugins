import { readdirSync, readFileSync } from "node:fs";
import {
  checkThemeReadability,
  mergeThemeSchemes,
  type ParsedTheme,
  parseThemeFile,
  sanitizeThemeSvg,
  THEME_LIMITS,
  themeAssetRefs,
  validateThemeAssets,
} from "@capybara-hq/plugin-sdk";
import { describe, expect, it } from "vitest";

/** The cyberpunk theme (L0: tokens, fonts, logo) as a deployment's import review reads it. */
const root = new URL("../", import.meta.url);
const bytes = (p: string) => new Uint8Array(readFileSync(new URL(p.replace(/^\.\//, ""), root)));
const text = (p: string) => readFileSync(new URL(p, root), "utf8");

function parsed(): ParsedTheme {
  const r = parseThemeFile("cyberpunk", text("themes/cyberpunk.json"));
  if ("errors" in r) throw new Error(r.errors.join("\n"));
  return r;
}

describe("cyberpunk theme", () => {
  it("parses with no errors and no readability issues", () => {
    expect(parseThemeFile("cyberpunk", text("themes/cyberpunk.json"))).not.toHaveProperty("errors");
  });

  it("is dark only, and the merged scheme passes every contrast and separation floor", () => {
    const theme = parsed();
    expect(theme.singleScheme).toBe("dark");
    const merged = mergeThemeSchemes(theme);
    expect(Object.keys(merged)).toEqual(["dark"]);
    const dark = merged.dark;
    if (dark === undefined) throw new Error("no dark scheme");
    expect(checkThemeReadability("dark", dark)).toEqual([]);
  });

  it("keeps the brand: neon yellow accent and focus, square base corners, own wordmark", () => {
    const dark = parsed().schemes.dark;
    expect(dark?.color?.accent).toBe("#FFE600");
    expect(dark?.color?.["focus-ring"]).toBe("rgba(255,230,0,0.35)");
    expect(dark?.radius).toEqual({ sm: 0, md: 2, bubble: 2 });
    expect(parsed().logo?.wordmark).toBe("CYBERBARA");
  });

  it("its fonts, logo, app icons and avatar pass the asset checks", () => {
    const theme = parsed();
    const files = new Map<string, Uint8Array>();
    for (const { ref } of themeAssetRefs(theme)) files.set(ref.replace(/^\.\//, ""), bytes(ref));
    expect(themeAssetRefs(theme).map((r) => r.field)).toEqual(
      expect.arrayContaining(["logo.appIcon", "logo.appIconMaskable", "avatars.0.file"]),
    );
    const { errors } = validateThemeAssets(theme, files);
    expect(errors).toEqual([]);
    expect(theme.fonts?.map((f) => `${f.role} ${f.family} ${f.weight}`)).toEqual([
      "mono JetBrains Mono 400",
      "mono JetBrains Mono 500",
      "mono JetBrains Mono 600",
      "mono JetBrains Mono 700",
      "prose Chakra Petch 400",
      "prose Chakra Petch 600",
      "prose Chakra Petch 700",
    ]);
    for (const f of theme.fonts ?? []) {
      expect(bytes(f.file).length).toBeLessThanOrEqual(THEME_LIMITS.fontBytes);
    }
  });

  it("offers its own capybara avatar in place of the built-in one", () => {
    const theme = parsed();
    expect(theme.hideAvatarPresets).toEqual(["capybara"]);
    expect(theme.avatars).toEqual([
      {
        id: "cyberbara",
        name: { en: "Cyberbara", zh: "赛博水豚" },
        file: "./avatars/cyberbara.svg",
      },
    ]);
  });

  it("app icons are opaque square PNGs of at least 512 px", () => {
    for (const p of [parsed().logo?.appIcon, parsed().logo?.appIconMaskable]) {
      if (p === undefined) throw new Error("app icon missing");
      const png = bytes(p);
      const view = new DataView(png.buffer, png.byteOffset);
      // IHDR: width at 16, height at 20, colour type at 25 (2 = RGB, no alpha)
      expect(view.getUint32(16)).toBe(view.getUint32(20));
      expect(view.getUint32(16)).toBeGreaterThanOrEqual(THEME_LIMITS.appIconMinSize);
      expect(png[25]).toBe(2);
    }
  });

  it("the logo survives the SVG sanitizer pixel for pixel (crisp edges, no styles)", () => {
    for (const p of ["logo.svg", "favicon.svg", "avatars/cyberbara.svg"]) {
      const r = sanitizeThemeSvg(bytes(p));
      expect(r).not.toHaveProperty("error");
      const svg = (r as { svg: string }).svg;
      expect(svg).toContain('shape-rendering="crispEdges"');
      expect(svg).toContain('fill="#FFE600"');
      expect(svg).toContain('fill="#00E5FF"');
    }
  });

  it("ships the OFL license of every font family it packs", () => {
    const licenses: Record<string, string> = {
      "JetBrains Mono": "OFL-JetBrainsMono.txt",
      "Chakra Petch": "OFL-ChakraPetch.txt",
    };
    const pkg = JSON.parse(text("package.json")) as { files: string[]; license: string };
    expect(pkg.license).toBe("Apache-2.0 AND OFL-1.1");
    for (const family of new Set(parsed().fonts?.map((f) => f.family))) {
      const file = licenses[family] ?? `no license file for ${family}`;
      expect(text(file)).toContain("SIL OPEN FONT LICENSE Version 1.1");
      expect(pkg.files).toContain(file);
    }
  });

  it("plugin.json lists the theme (the packed manifest is parsed in pack.test.ts)", () => {
    const source = JSON.parse(text(".capybara-plugin/plugin.json")) as { themes?: unknown };
    expect(source.themes).toEqual([{ path: "./themes/cyberpunk.json" }]);
  });

  it("carries no third-party game IP in its text", () => {
    const banned = /night city|kiroshi|relic|johnny|silverhand|arasaka|militech|2077|cd ?projekt/i;
    const textFiles = [
      "README.md",
      "package.json",
      ".capybara-plugin/plugin.json",
      "logo.svg",
      "favicon.svg",
      "avatars/cyberbara.svg",
      ...readdirSync(new URL("themes/", root)).map((f) => `themes/${f}`),
      ...readdirSync(new URL("src/", root)).map((f) => `src/${f}`),
      "client/styles/cyberpunk.css",
    ];
    for (const f of textFiles) expect(text(f), f).not.toMatch(banned);
  });
});
