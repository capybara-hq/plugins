import { configJsonSchema } from "@capybara-hq/plugin-sdk";
import { describe, expect, it } from "vitest";
import plugin from "../src/index.js";

describe("deployment config classification", () => {
  it("leaves every field org-overridable (no platform-only or org marks)", () => {
    const schema = configJsonSchema(plugin.config?.deployment as never);
    expect(JSON.stringify(schema)).not.toContain("x-platform-only");
    expect(JSON.stringify(schema)).not.toContain("x-org");
  });
});
