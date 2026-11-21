import { describe, expect, it } from "vitest";
import { ApnsDeployment } from "../src/config.js";
import { testConfig, testSigningKey } from "./helpers.js";

describe("ApnsDeployment", () => {
  const { pem } = testSigningKey();

  it("accepts a key, a 10-character key id and team id, and one bundle", () => {
    expect(ApnsDeployment.safeParse(testConfig(pem)).success).toBe(true);
  });

  it.each([
    ["a key id of 9 characters", { keyId: "ABC123DEF" }],
    ["a key id of 11 characters", { keyId: "ABC123DEFGH" }],
    ["a team id of 9 characters", { teamId: "TEAM12345" }],
    ["an empty key", { key: "" }],
    ["no bundle", { bundles: [] }],
  ])("refuses %s", (_label, over) => {
    expect(ApnsDeployment.safeParse(testConfig(pem, over)).success).toBe(false);
  });

  it("refuses an unknown environment", () => {
    const bad = { ...testConfig(pem), bundles: [{ bundleId: "com.x", environment: "dev" }] };
    expect(ApnsDeployment.safeParse(bad).success).toBe(false);
  });
});
