// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { applyTheme, THEME, THEME_VARS } from "../ui-src/app/theme.js";

// Verbatim values from core packages/design/src/styles/tokens.css: the host sends every `--cb-*`
// custom property under its full name (apps/web/src/lib/embed-bridge.ts `readDesignTokens`).
const COMMON = {
  "--cb-font": '"Sarasa Mono SC", ui-monospace, monospace',
  "--cb-font-prose": '"Inter", "Source Han Sans SC", system-ui, sans-serif',
  "--cb-radius-sm": "4px",
  "--cb-radius-md": "8px",
  "--cb-space-2": "8px",
};
const DARK = {
  ...COMMON,
  "--cb-bg": "#0A0A0A",
  "--cb-panel": "#111110",
  "--cb-hover": "#171716",
  "--cb-line": "#2A2A28",
  "--cb-ink": "#E6E6E3",
  "--cb-muted": "#8E8E89",
  "--cb-accent": "#FF6A13",
  "--cb-fail": "#FF5C52",
  "--cb-scroll-thumb": "rgba(255,255,255,0.15)",
};
const LIGHT = {
  ...COMMON,
  "--cb-bg": "#FAF9F6",
  "--cb-panel": "#FFFFFF",
  "--cb-hover": "rgba(26,26,24,0.04)",
  "--cb-line": "#D9D8D2",
  "--cb-ink": "#1A1A18",
  "--cb-muted": "#5E5E5A",
  "--cb-accent": "#CC4609",
  "--cb-fail": "#C8302A",
  "--cb-scroll-thumb": "rgba(26,26,24,0.20)",
};

const get = (name: string) => document.documentElement.style.getPropertyValue(name);

describe("theme variables", () => {
  it("maps the host's --cb-* tokens to the documented variables (dark)", () => {
    applyTheme(document, "dark", DARK);
    expect(get(THEME_VARS.background)).toBe("#0A0A0A");
    expect(get(THEME_VARS.panel)).toBe("#111110");
    expect(get(THEME_VARS.hover)).toBe("#171716");
    expect(get(THEME_VARS.border)).toBe("#2A2A28");
    expect(get(THEME_VARS.foreground)).toBe("#E6E6E3");
    expect(get(THEME_VARS.mutedForeground)).toBe("#8E8E89");
    expect(get(THEME_VARS.accent)).toBe("#FF6A13");
    expect(get(THEME_VARS.danger)).toBe("#FF5C52");
    expect(get(THEME_VARS.fontMono)).toBe(COMMON["--cb-font"]);
    expect(get(THEME_VARS.radius)).toBe("4px");
  });

  it("re-maps on a theme switch without a reload (light)", () => {
    applyTheme(document, "dark", DARK);
    applyTheme(document, "light", LIGHT);
    expect(get(THEME_VARS.background)).toBe("#FAF9F6");
    expect(get(THEME_VARS.foreground)).toBe("#1A1A18");
    expect(get(THEME_VARS.accent)).toBe("#CC4609");
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
  });

  it("color-scheme and the scrollbar thumb follow the host theme, so no light track on dark", () => {
    applyTheme(document, "dark", DARK);
    expect(document.documentElement.style.colorScheme).toBe("dark");
    expect(get(THEME_VARS.scrollThumb)).toBe("rgba(255,255,255,0.15)");
    applyTheme(document, "light", LIGHT);
    expect(document.documentElement.style.colorScheme).toBe("light");
    expect(get(THEME_VARS.scrollThumb)).toBe("rgba(26,26,24,0.20)");
    // an older host without the token: the theme's own thumb
    applyTheme(document, "dark", {});
    expect(get(THEME_VARS.scrollThumb)).toBe("rgba(255,255,255,0.15)");
  });

  it("falls back to the theme's defaults for tokens the host did not send", () => {
    applyTheme(document, "dark", {});
    expect(get(THEME_VARS.background)).not.toBe("");
    expect(get(THEME_VARS.foreground)).not.toBe("");
    const dark = get(THEME_VARS.background);
    applyTheme(document, "light", {});
    expect(get(THEME_VARS.background)).not.toBe(dark);
  });

  it("ignores names outside the --cb- namespace and values that are not strings", () => {
    applyTheme(document, "dark", {
      ...DARK,
      "--cb-bg": "#123456",
      "--evil": "x",
      "a;b": "1",
    });
    expect(get(THEME_VARS.background)).toBe("#123456");
    expect(document.documentElement.style.cssText).not.toContain("evil");
    expect(document.documentElement.style.cssText).not.toContain("a;b");
  });

  it("THEME carries var() references with a system fallback for each variable", () => {
    for (const key of Object.keys(THEME_VARS) as (keyof typeof THEME_VARS)[]) {
      expect(THEME[key]).toMatch(new RegExp(`^var\\(${THEME_VARS[key]}, .+\\)$`));
    }
  });

  it("rejects hostile token values and falls back to the theme default", () => {
    applyTheme(document, "dark", {});
    const dflt = get(THEME_VARS.background);
    const hostile = [
      "url(https://evil/x)",
      "red; background: url(x)",
      "red } body { color: blue",
      "{x}",
      "@import 'x'",
      "red\\3b x",
      "expression(alert(1))",
      "a".repeat(201),
    ];
    for (const value of hostile) {
      applyTheme(document, "dark", { "--cb-bg": value });
      expect(get(THEME_VARS.background), value).toBe(dflt);
    }
    applyTheme(document, "dark", { "--cb-bg": "a".repeat(200) });
    expect(get(THEME_VARS.background)).toBe("a".repeat(200));
  });

  it("a token missing from a later payload falls back to the theme default", () => {
    applyTheme(document, "dark", { "--cb-bg": "#123456", "--cb-accent": "#abcdef" });
    expect(get(THEME_VARS.accent)).toBe("#abcdef");
    applyTheme(document, "dark", { "--cb-bg": "#654321" });
    expect(get(THEME_VARS.background)).toBe("#654321");
    expect(get(THEME_VARS.accent)).toBe("#FF6A13");
  });
});
