import { IDENTITY_SOURCE_EXTENSION_POINT } from "@capybara-hq/plugin-sdk";
import { describe, expect, it } from "vitest";
import extension from "../src/index.js";

describe("google extension manifest", () => {
  it("provides exactly identity-source@1", () => {
    expect(extension.name).toBe("google");
    expect(extension.provides).toEqual([IDENTITY_SOURCE_EXTENSION_POINT]);
  });

  it("declares exactly the checks it registers, and nothing it does not need", async () => {
    const provided: unknown[] = [];
    const checks: string[] = [];
    const ctx = {
      config: {},
      provide: (point: unknown, impl: unknown) => provided.push([point, impl]),
      setup: { check: (id: string) => checks.push(id) },
    };
    await extension.setup(ctx as never);
    expect(provided).toHaveLength(1);
    expect(checks.sort()).toEqual([...(extension.permissions?.setupChecks ?? [])].sort());
    const permissions = extension.permissions as Record<string, unknown>;
    for (const key of ["secrets", "hooks", "ui", "policyHooks", "models", "kv", "tools"]) {
      expect(permissions[key]).toBeUndefined();
    }
    expect(extension.permissions?.network).toEqual([
      "accounts.google.com",
      "oauth2.googleapis.com",
      "www.googleapis.com",
    ]);
  });

  it("has deployment config only", () => {
    expect(Object.keys(extension.config ?? {})).toEqual(["deployment"]);
  });
});
