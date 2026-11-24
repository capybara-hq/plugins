import { configJsonSchema } from "@capybara-hq/plugin-sdk";
import { describe, expect, it } from "vitest";
import plugin from "../src/index.js";

describe("deployment config classification", () => {
  it("marks the whole deployment schema platform-only", () => {
    const schema = configJsonSchema(plugin.config?.deployment as never) as Record<string, unknown>;
    expect(schema["x-platform-only"]).toBe(true);
  });
});
