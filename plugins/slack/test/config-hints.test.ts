import { configJsonSchema, validateConfigUi } from "@capybara-hq/plugin-sdk";
import { describe, expect, it } from "vitest";
import { SlackConnection } from "../src/channel.js";
import { SlackDirectoryConfig } from "../src/config.js";

type Field = {
  "x-secret"?: boolean;
  "x-ui"?: { label?: unknown; help?: { zh: string; en: string }; inboundModes?: string[] };
};
const fields = (schema: Record<string, unknown>) => schema.properties as Record<string, Field>;

describe("config UI hints", () => {
  it("channel connection fields carry zh / en labels and help, and stay secret", () => {
    const schema = configJsonSchema(SlackConnection);
    expect(validateConfigUi(schema, "connection")).toEqual([]);
    const f = fields(schema);
    expect(Object.keys(f)).toEqual(["appToken", "botToken", "signingSecret"]);
    expect(f.appToken?.["x-ui"]?.label).toEqual({ zh: "应用令牌", en: "App-level token" });
    expect(f.appToken?.["x-ui"]?.help?.zh).toContain("connections:write");
    expect(f.botToken?.["x-ui"]?.label).toEqual({ zh: "机器人令牌", en: "Bot token" });
    expect(f.botToken?.["x-ui"]?.help?.en).toContain("Bot User OAuth Token");
    expect(f.signingSecret?.["x-ui"]?.label).toEqual({ zh: "签名密钥", en: "Signing secret" });
    expect(f.signingSecret?.["x-ui"]?.help?.zh).toContain("Signing Secret");
    // each token belongs to its inbound mode: drawn and required only there
    expect(f.appToken?.["x-ui"]?.inboundModes).toEqual(["long_connection"]);
    expect(f.signingSecret?.["x-ui"]?.inboundModes).toEqual(["webhook"]);
    expect(f.botToken?.["x-ui"]?.inboundModes).toBeUndefined();
    for (const k of ["appToken", "botToken", "signingSecret"])
      expect(f[k]?.["x-secret"]).toBe(true);
  });

  it("org fields say they are optional and only for member sync", () => {
    const schema = configJsonSchema(SlackDirectoryConfig);
    expect(validateConfigUi(schema, "org")).toEqual([]);
    expect(schema.required).toBeUndefined();
    const f = fields(schema);
    expect(f.teamId?.["x-ui"]?.label).toEqual({ zh: "工作区 ID", en: "Workspace ID" });
    expect(f.teamId?.["x-ui"]?.help?.zh).toMatch(/^选填/);
    expect(f.teamId?.["x-ui"]?.help?.en).toMatch(/^Optional/);
    expect(f.botToken?.["x-ui"]?.help?.zh).toContain("渠道连接");
    expect(f.botToken?.["x-ui"]?.help?.en).toMatch(/^Optional, only for member sync/);
    expect(f.botToken?.["x-secret"]).toBe(true);
  });
});
