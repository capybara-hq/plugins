import { describe, expect, it } from "vitest";
import { chromiumLaunchPlan } from "../../daemon/chromium.js";

describe("chromium launch plan", () => {
  it("keeps the profile and browsers in the state directory and passes the proxy", () => {
    const plan = chromiumLaunchPlan({
      stateDir: "/s",
      env: { https_proxy: "http://egress:3128", NO_PROXY: "a.test,b.test" },
      platform: "linux",
    });
    expect(plan.profileDir).toBe("/s/profile");
    expect(plan.browsersPath).toBe("/s/browsers");
    expect(plan.args).toContain("--proxy-server=http://egress:3128");
    expect(plan.args).toContain("--proxy-bypass-list=a.test;b.test");
    expect(plan.args).not.toContain("--single-process");
    expect(plan.args.some((a) => a.startsWith("--remote-debugging-port"))).toBe(false);
  });

  it("runs the headless shell in one process with the mock keychain on macOS", () => {
    const plan = chromiumLaunchPlan({ stateDir: "/s", env: {}, platform: "darwin" });
    expect(plan.args).toEqual(expect.arrayContaining(["--single-process", "--use-mock-keychain"]));
    expect(plan.args.some((a) => a.startsWith("--proxy-server"))).toBe(false);
  });
});
