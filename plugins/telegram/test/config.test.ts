import { describe, expect, it } from "vitest";
import {
  botIdOf,
  connectionTenant,
  SENDER_TENANT,
  TelegramConnection,
  TelegramDeployment,
} from "../src/config.js";

describe("config", () => {
  it("deployment apiUrl defaults to the public Bot API", () => {
    expect(TelegramDeployment.parse({})).toEqual({ apiUrl: "https://api.telegram.org" });
  });

  it("connection takes a BotFather token and an optional webhook secret", () => {
    expect(TelegramConnection.safeParse({ botToken: "123:AbC-d_9" }).success).toBe(true);
    expect(TelegramConnection.safeParse({ botToken: "abc:def" }).success).toBe(false);
    expect(
      TelegramConnection.safeParse({ botToken: "123:x", webhookSecret: "s3cr-et_" }).success,
    ).toBe(true);
    expect(TelegramConnection.safeParse({ botToken: "123:x", webhookSecret: "a b" }).success).toBe(
      false,
    );
    expect(
      TelegramConnection.safeParse({ botToken: "123:x", webhookSecret: "a".repeat(257) }).success,
    ).toBe(false);
  });

  it("bot id and tenants", () => {
    expect(botIdOf("123456:abc")).toBe("123456");
    expect(connectionTenant(123456)).toBe("bot123456");
    expect(connectionTenant("7")).toBe("bot7");
    expect(connectionTenant(1)).not.toBe(SENDER_TENANT);
    expect(SENDER_TENANT).toBe("global");
  });
});
