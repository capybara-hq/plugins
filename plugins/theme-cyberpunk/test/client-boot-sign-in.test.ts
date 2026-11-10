// @vitest-environment jsdom
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// = @capybara-hq/plugin-client/testing, through package.json "imports" (see README, Tests)
import { type FakeHost, renderWithFakeHost } from "#client-testing";

/** The host's sign-in id, as the next plugin-client's useSignIn() gives it. */
const signIn = vi.hoisted(() => ({ id: "sign-in-1" as string | null }));
vi.mock("../src/sign-in.js", () => ({ useSignInId: () => signIn.id }));

const { BootScreen, bootDue, markBooted } = await import("../src/overlay.js");

const STORED = "cap-ext:theme-cyberpunk:booted-sign-in";
let host: FakeHost | undefined;
const boot = () => document.querySelector(".cx-theme-cyberpunk-boot");
function render(): void {
  host?.unmount();
  host = renderWithFakeHost(createElement(BootScreen), {
    slot: "shell.overlay",
    plugin: "theme-cyberpunk",
  });
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  signIn.id = "sign-in-1";
});
afterEach(() => {
  host?.unmount();
  host = undefined;
});

describe("boot screen, once per sign-in", () => {
  it("plays for a new sign-in id and not again for the same one, in any tab", () => {
    render();
    expect(boot()).not.toBeNull();
    expect(localStorage.getItem(STORED)).toBe("sign-in-1");
    sessionStorage.clear(); // a new tab of the same sign-in
    render();
    expect(boot()).toBeNull();
  });

  it("plays again after the next sign-in", () => {
    render();
    signIn.id = "sign-in-2";
    render();
    expect(boot()).not.toBeNull();
    expect(localStorage.getItem(STORED)).toBe("sign-in-2");
  });

  it("falls back to once per browser session where the host has no sign-in id", () => {
    const store = {
      data: new Map<string, string>(),
      get(k: string, scope = "local") {
        return this.data.get(`${scope}:${k}`) ?? null;
      },
      set(k: string, v: string | null, scope = "local") {
        if (v === null) this.data.delete(`${scope}:${k}`);
        else this.data.set(`${scope}:${k}`, v);
      },
    };
    expect(bootDue(store, null)).toBe(true);
    markBooted(store, null);
    expect(bootDue(store, null)).toBe(false);
    expect(store.get("booted", "session")).toBe("1");
    // the sign-in gate ignores the session mark
    expect(bootDue(store, "sign-in-9")).toBe(true);
  });
});
