import { validateTenantId } from "@capybara-hq/plugin-sdk";
import { describe, expect, it } from "vitest";
import { CONSUMER_TENANT } from "../src/claims.js";
import { createGoogleIdentitySource, GOOGLE_TENANT } from "../src/identity.js";

describe("Google identity source tenant", () => {
  it("is declared on the source", () => {
    expect(createGoogleIdentitySource().tenant).toBe(GOOGLE_TENANT);
    expect(GOOGLE_TENANT.placeholder).toBe("example.com");
  });

  it("accepts a primary domain and refuses what is not one", () => {
    expect(validateTenantId(GOOGLE_TENANT, "example.com")).toBe("ok");
    expect(validateTenantId(GOOGLE_TENANT, "corp.example.co.uk")).toBe("ok");
    expect(validateTenantId(GOOGLE_TENANT, "Example.com")).toBe("pattern");
    expect(validateTenantId(GOOGLE_TENANT, "localhost")).toBe("pattern");
    expect(validateTenantId(GOOGLE_TENANT, "")).toBe("empty");
  });

  it("never trusts the consumer tenant", () => {
    // the domain pattern already refuses it; neverTrusted keeps it refused on its own
    expect(GOOGLE_TENANT.neverTrusted).toEqual([CONSUMER_TENANT]);
    expect(validateTenantId(GOOGLE_TENANT, CONSUMER_TENANT)).not.toBe("ok");
    const { pattern: _pattern, ...withoutPattern } = GOOGLE_TENANT;
    expect(validateTenantId(withoutPattern, CONSUMER_TENANT)).toBe("never_trusted");
  });

  it("matches its own placeholder", () => {
    expect(validateTenantId(GOOGLE_TENANT, GOOGLE_TENANT.placeholder ?? "")).toBe("ok");
  });
});
