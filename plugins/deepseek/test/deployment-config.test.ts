import { describe, expect, it } from "vitest";
import type { z } from "zod";
import plugin from "../src/index.js";

/**
 * The deployment config requires the API key, so a deployment without one is "needs config" in
 * the kernel (and each org following the platform needs configuration) instead of a loaded
 * provider that fails to list.
 */
const schema = plugin.config?.deployment as z.ZodObject;

describe("deployment config", () => {
  it("is invalid without an API key", () => {
    for (const config of [{}, { apiKey: "" }, { baseUrl: "https://api.deepseek.com" }]) {
      const r = schema.safeParse(config);
      expect(r.success).toBe(false);
      expect(r.error?.issues.map((i) => i.path.join("."))).toContain("apiKey");
    }
  });

  it("is valid with an API key, the other fields defaulted", () => {
    const r = schema.safeParse({ apiKey: "sk-test" });
    expect(r.success).toBe(true);
    expect(r.data).toMatchObject({ apiKey: "sk-test", baseUrl: "https://api.deepseek.com" });
  });
});
