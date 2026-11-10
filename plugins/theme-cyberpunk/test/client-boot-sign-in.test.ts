// @vitest-environment jsdom
import { type FakeHost, renderWithFakeHost } from "@capybara-hq/plugin-client/testing";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BootScreen } from "../src/overlay.js";

const STORED = "cap-ext:theme-cyberpunk:booted-sign-in";
let host: FakeHost | undefined;
const boot = () => document.querySelector(".cx-theme-cyberpunk-boot");

/** Mounts the boot screen for a sign-in (the host's `useSignIn().id`). */
function render(signInId: string): void {
  host?.unmount();
  host = renderWithFakeHost(createElement(BootScreen), {
    slot: "shell.overlay",
    plugin: "theme-cyberpunk",
    signInId,
  });
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});
afterEach(() => {
  host?.unmount();
  host = undefined;
});

describe("boot screen, once per sign-in", () => {
  it("plays for a sign-in id and records it", () => {
    render("sign-in-1");
    expect(boot()).not.toBeNull();
    expect(localStorage.getItem(STORED)).toBe("sign-in-1");
  });

  it("does not play again for the same sign-in, in a reload or a new tab", () => {
    render("sign-in-1");
    render("sign-in-1"); // a reload
    expect(boot()).toBeNull();
    sessionStorage.clear(); // a new tab of the same sign-in shares local storage
    render("sign-in-1");
    expect(boot()).toBeNull();
  });

  it("plays again after the next sign-in", () => {
    render("sign-in-1");
    render("sign-in-2");
    expect(boot()).not.toBeNull();
    expect(localStorage.getItem(STORED)).toBe("sign-in-2");
  });
});
