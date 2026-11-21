import { configJsonSchema } from "@capybara-hq/plugin-sdk";
import { describe, expect, it } from "vitest";
import { GOOGLE_ENDPOINTS, GoogleDeployment, loginConfig } from "../src/config.js";

const base = { clientId: "123.apps.googleusercontent.com", clientSecret: "s3cr3t-value" };

function messageOf(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error("expected a throw");
}

describe("GoogleDeployment", () => {
  it("has the documented defaults", () => {
    const c = loginConfig(base);
    expect(c.allowedDomains).toEqual([]);
    expect(c.allowConsumerAccounts).toBe(false);
    expect(c.endpoints).toEqual(GOOGLE_ENDPOINTS);
  });

  it("pins Google's endpoints", () => {
    expect(GOOGLE_ENDPOINTS).toEqual({
      authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenUrl: "https://oauth2.googleapis.com/token",
      jwksUrl: "https://www.googleapis.com/oauth2/v3/certs",
      issuers: ["https://accounts.google.com", "accounts.google.com"],
      discoveryUrl: "https://accounts.google.com/.well-known/openid-configuration",
    });
    expect(Object.isFrozen(GOOGLE_ENDPOINTS)).toBe(true);
  });

  it("lowercases and deduplicates allowedDomains", () => {
    const c = loginConfig({ ...base, allowedDomains: ["Example.COM", "example.com", "b.example"] });
    expect(c.allowedDomains).toEqual(["example.com", "b.example"]);
  });

  it.each(["gmail.com", "GoogleMail.com"])(
    "refuses %s in allowedDomains, pointing at allowConsumerAccounts",
    (d) => {
      const r = GoogleDeployment.safeParse({ ...base, allowedDomains: [d] });
      expect(r.success).toBe(false);
      expect(JSON.stringify(r.error?.issues)).toContain("allowConsumerAccounts");
      expect(messageOf(() => loginConfig({ ...base, allowedDomains: [d] }))).toContain(
        "allowConsumerAccounts",
      );
    },
  );

  it.each([["not a domain"], ["-bad.example"], ["example"], ["a..example.com"]])(
    "refuses the domain %j",
    (d) => {
      expect(GoogleDeployment.safeParse({ ...base, allowedDomains: [d] }).success).toBe(false);
    },
  );

  it("refuses more than 50 domains", () => {
    const many = Array.from({ length: 51 }, (_, i) => `d${i}.example.com`);
    expect(GoogleDeployment.safeParse({ ...base, allowedDomains: many }).success).toBe(false);
    expect(GoogleDeployment.safeParse({ ...base, allowedDomains: many.slice(0, 50) }).success).toBe(
      true,
    );
  });

  it("trims a pasted client id and secret", () => {
    const c = loginConfig({
      clientId: " 123.apps.googleusercontent.com\n",
      clientSecret: "\ts3cr3t-value \n",
    });
    expect(c.clientId).toBe("123.apps.googleusercontent.com");
    expect(c.clientSecret).toBe("s3cr3t-value");
  });

  it("is not configured without a client id or secret", () => {
    for (const cfg of [{}, undefined, null, { clientId: base.clientId }, { clientSecret: "x" }]) {
      expect(messageOf(() => loginConfig(cfg))).toBe(
        "Sign in with Google is not configured: set clientId and clientSecret in the google plugin's platform config",
      );
    }
  });

  it("never puts a value into a validation error", () => {
    const msg = messageOf(() =>
      loginConfig({ ...base, clientSecret: 42, allowedDomains: ["s3cr3t-value"] }),
    );
    expect(msg).toContain("allowedDomains");
    expect(msg).not.toContain("s3cr3t-value");
    const msg2 = messageOf(() =>
      loginConfig({ ...base, endpoints: { tokenUrl: "http://s3cr3t-value.example/token" } }),
    );
    expect(msg2).toContain("endpoints.tokenUrl");
    expect(msg2).not.toContain("s3cr3t-value");
  });

  it("accepts https endpoints and loopback http only", () => {
    expect(
      GoogleDeployment.safeParse({ ...base, endpoints: { tokenUrl: "http://evil.example/token" } })
        .success,
    ).toBe(false);
    expect(
      GoogleDeployment.safeParse({ ...base, endpoints: { tokenUrl: "ftp://127.0.0.1/token" } })
        .success,
    ).toBe(false);
    const c = loginConfig({
      ...base,
      endpoints: { tokenUrl: "http://127.0.0.1:9/token", jwksUrl: "http://localhost:9/jwks" },
    });
    expect(c.endpoints.tokenUrl).toBe("http://127.0.0.1:9/token");
    expect(c.endpoints.jwksUrl).toBe("http://localhost:9/jwks");
    expect(c.endpoints.authorizationUrl).toBe(GOOGLE_ENDPOINTS.authorizationUrl);
    expect(c.endpoints.issuers).toEqual(GOOGLE_ENDPOINTS.issuers);
  });

  it("is platform-only: no field carries an org level", () => {
    const schema = configJsonSchema(GoogleDeployment);
    expect(JSON.stringify(schema)).not.toContain("x-org");
    expect(JSON.stringify(schema)).toContain("x-secret");
  });
});
