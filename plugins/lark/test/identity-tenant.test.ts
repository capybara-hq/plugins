import { validateTenantId } from "@capybara-hq/plugin-sdk";
import { describe, expect, it } from "vitest";
import { createLarkIdentitySource, LARK_TENANT } from "../src/identity.js";

describe("Lark identity source tenant", () => {
  it("is declared on the source, labelled as the tenant key", () => {
    expect(createLarkIdentitySource().tenant).toBe(LARK_TENANT);
    expect(LARK_TENANT.label.en).toBe("Lark tenant key");
  });

  it("accepts any non-blank tenant_key (Lark documents no format)", () => {
    expect(validateTenantId(LARK_TENANT, "2ed263bf32cf1651")).toBe("ok");
    expect(validateTenantId(LARK_TENANT, "736588c9260f175d")).toBe("ok");
    expect(validateTenantId(LARK_TENANT, "  ")).toBe("empty");
  });
});
