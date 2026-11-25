import { describe, expect, it } from "vitest";
import { protectedRoot } from "../src/operations.js";

describe("device-docker protected roots", () => {
  it("refuses the device service state and run directories as read and write roots", () => {
    for (const path of [
      "/var/lib/capybara/svc",
      "/var/lib/capybara/svc/browser",
      "/var/lib/capybara/svc/browser/profile/Cookies",
      "/run/capybara-svc",
      "/run/capybara-svc/browser.browser/sock",
    ]) {
      expect(protectedRoot(path, false), path).toBe(true);
      expect(protectedRoot(path, true), path).toBe(true);
    }
    // a write root that contains them is refused too
    expect(protectedRoot("/var/lib", true)).toBe(true);
    expect(protectedRoot("/tmp", true)).toBe(true);
  });

  it("keeps ordinary roots", () => {
    expect(protectedRoot("/workspace", true)).toBe(false);
    expect(protectedRoot("/var/lib/capybara/svcx", false)).toBe(false);
    expect(protectedRoot("/run/capybara-svcx", false)).toBe(false);
  });
});
