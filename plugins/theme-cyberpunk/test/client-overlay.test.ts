// @vitest-environment jsdom
import { act, createElement } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// = @capybara-hq/plugin-client/testing, through package.json "imports" (see README, Tests)
import { type FakeHost, renderWithFakeHost } from "#client-testing";
import { Brand, brandPanel, GlitchBrand, Hero } from "../src/brand.js";
import { BOOT_OUT_ANIMATION, Boot, BootScreen, Scanlines } from "../src/overlay.js";

const BOOTED = "cap-ext:theme-cyberpunk:booted";
let host: FakeHost | undefined;

function render(
  element: Parameters<typeof renderWithFakeHost>[0],
  reducedMotion = false,
): FakeHost {
  host?.unmount();
  host = renderWithFakeHost(element, {
    slot: "shell.overlay",
    plugin: "theme-cyberpunk",
    reducedMotion,
  });
  return host;
}

const boot = () => document.querySelector(".cx-theme-cyberpunk-boot");

/**
 * Fires the end of a CSS animation on `el`. jsdom has no AnimationEvent, so React listens to the
 * prefixed name there (it picks the name the browser supports).
 */
function animationEnd(el: Element | null | undefined, animationName: string): void {
  const type = "AnimationEvent" in window ? "animationend" : "webkitAnimationEnd";
  const e = new Event(type, { bubbles: true });
  Object.assign(e, { animationName });
  el?.dispatchEvent(e);
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});

afterEach(() => {
  host?.unmount();
  host = undefined;
});

describe("boot screen", () => {
  it("plays once per session: the first mount shows it and marks the session", () => {
    render(createElement(BootScreen));
    expect(boot()).not.toBeNull();
    expect(sessionStorage.getItem(BOOTED)).toBe("1");
    render(createElement(BootScreen));
    expect(boot()).toBeNull();
  });

  it("is skipped under reduced motion (and the session is not marked)", () => {
    render(createElement(BootScreen), true);
    expect(boot()).toBeNull();
    expect(sessionStorage.getItem(BOOTED)).toBeNull();
  });

  it("is decorative: lines hidden from assistive tech, only Skip is interactive", () => {
    render(createElement(BootScreen));
    expect(
      document.querySelector(".cx-theme-cyberpunk-boot-screen")?.getAttribute("aria-hidden"),
    ).toBe("true");
    const skip = document.querySelector<HTMLButtonElement>(".cx-theme-cyberpunk-boot-skip");
    expect(skip?.hasAttribute("data-cap-interactive")).toBe(true);
    expect(skip?.getAttribute("aria-label")).toBe("Skip the boot animation");
  });

  it("ends on Skip, on Escape and when its exit animation ends", () => {
    render(createElement(BootScreen));
    act(() => document.querySelector<HTMLButtonElement>(".cx-theme-cyberpunk-boot-skip")?.click());
    expect(boot()).toBeNull();

    sessionStorage.clear();
    render(createElement(BootScreen));
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(boot()).toBeNull();

    sessionStorage.clear();
    render(createElement(BootScreen));
    const el = boot();
    act(() =>
      animationEnd(el?.querySelector(".cx-theme-cyberpunk-boot-line"), "cx-theme-cyberpunk-show"),
    );
    expect(boot()).not.toBeNull(); // a line's animation does not end the screen
    act(() => animationEnd(el, BOOT_OUT_ANIMATION));
    expect(boot()).toBeNull();
  });

  it("the overlay components draw nothing while another theme is active", () => {
    // the fake host's theme is the built-in one (key null)
    render(createElement(Boot));
    expect(boot()).toBeNull();
    expect(sessionStorage.getItem(BOOTED)).toBeNull();
    render(createElement(Scanlines));
    expect(document.querySelector(".cx-theme-cyberpunk-scanlines")).toBeNull();
  });
});

describe("brand and hero", () => {
  const builtin = createElement("span", { "data-testid": "builtin" }, "official");

  it("render the built-in while another theme is active", () => {
    render(
      createElement(Brand, {
        plugin: "theme-cyberpunk",
        contribution: "brand",
        slot: "shell.brand",
        builtin,
        collapsed: false,
      }),
    );
    expect(document.querySelector('[data-testid="builtin"]')).not.toBeNull();
    render(
      createElement(Hero, {
        plugin: "theme-cyberpunk",
        contribution: "hero",
        slot: "conversation.empty",
        builtin,
        agentId: null,
        greeting: "Good evening",
      }),
    );
    expect(document.querySelector('[data-testid="builtin"]')).not.toBeNull();
  });

  it("the brand follows the panel it is drawn in", () => {
    expect(brandPanel({ collapsed: true })).toBe("rail");
    expect(brandPanel({ collapsed: false })).toBe("full");
    expect(brandPanel({ collapsed: false, panel: "rail" })).toBe("rail");
    expect(brandPanel({ collapsed: true, panel: "drawer" })).toBe("full");

    render(createElement(GlitchBrand, { panel: "rail", builtin }));
    expect(
      document.querySelector(".cx-theme-cyberpunk-brand-rail [data-testid=builtin]"),
    ).not.toBeNull();

    render(createElement(GlitchBrand, { panel: "full", builtin }));
    const brand = document.querySelector(".cx-theme-cyberpunk-brand");
    expect(brand?.getAttribute("role")).toBe("img");
    expect(brand?.getAttribute("aria-label")).toBe("CYBERBARA");
    expect(brand?.querySelector(".cx-theme-cyberpunk-glitch-base")?.textContent).toBe("CYBERBARA");
  });
});
