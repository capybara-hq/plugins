import { validateTenantId } from "@capybara-hq/plugin-sdk";
import { describe, expect, it } from "vitest";
import { createSlackIdentitySource, SLACK_TENANT } from "../src/identity.js";

describe("Slack identity source tenant", () => {
  it("is declared on the source", () => {
    expect(createSlackIdentitySource().tenant).toBe(SLACK_TENANT);
    expect(SLACK_TENANT.placeholder).toBe("T0123ABCD");
  });

  it("accepts a workspace id and refuses an Enterprise Grid id or a lowercase one", () => {
    expect(validateTenantId(SLACK_TENANT, "T0123ABCD")).toBe("ok");
    expect(validateTenantId(SLACK_TENANT, " T0123ABCD ")).toBe("ok");
    expect(validateTenantId(SLACK_TENANT, "E0123")).toBe("pattern");
    expect(validateTenantId(SLACK_TENANT, "t0123abcd")).toBe("pattern");
    expect(validateTenantId(SLACK_TENANT, " ")).toBe("empty");
  });

  it("matches its own placeholder", () => {
    expect(validateTenantId(SLACK_TENANT, SLACK_TENANT.placeholder ?? "")).toBe("ok");
  });
});
