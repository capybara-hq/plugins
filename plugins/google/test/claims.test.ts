import { isIdentitySourceRefused } from "@capybara-hq/plugin-sdk";
import { describe, expect, it } from "vitest";
import {
  CONSUMER_TENANT,
  emailIsAuthoritative,
  hostedDomainGate,
  toExternalIdentity,
} from "../src/claims.js";

const listed = { allowedDomains: ["example.com"], allowConsumerAccounts: false };
const anyWorkspace = { allowedDomains: [], allowConsumerAccounts: false };
const anyone = { allowedDomains: [], allowConsumerAccounts: true };

function refusal(fn: () => unknown): Error {
  try {
    fn();
  } catch (e) {
    return e as Error;
  }
  throw new Error("expected a refusal");
}

describe("hostedDomainGate", () => {
  it.each([
    ["listed hd", { hd: "example.com" }, listed, "example.com"],
    ["listed hd in upper case", { hd: "Example.COM" }, listed, "example.com"],
    ["any hd, empty list", { hd: "other.example" }, anyWorkspace, "other.example"],
    ["any hd, empty list, consumers allowed", { hd: "other.example" }, anyone, "other.example"],
    ["no hd, empty list, consumers allowed", {}, anyone, undefined],
    ["empty hd, consumers allowed", { hd: "" }, anyone, undefined],
    ["numeric hd, consumers allowed", { hd: 42 }, anyone, undefined],
  ] as const)("allows %s", (_name, claims, policy, expected) => {
    expect(
      hostedDomainGate(claims, { ...policy, allowedDomains: [...policy.allowedDomains] }),
    ).toBe(expected);
  });

  it.each([
    ["an unlisted hd", { hd: "other.example" }, listed, "other.example"],
    ["no hd with a list", {}, listed, "none"],
    [
      "no hd with a list even when consumers are allowed",
      {},
      { ...listed, allowConsumerAccounts: true },
      "none",
    ],
    ["no hd, empty list, consumers refused", {}, anyWorkspace, "none"],
    ["an empty hd, consumers refused", { hd: "" }, anyWorkspace, "none"],
    ["a non-string hd, consumers refused", { hd: 42 }, anyWorkspace, "none"],
    ["an array hd with a list", { hd: ["example.com"] }, listed, "none"],
  ] as const)("refuses %s", (_name, claims, policy, shown) => {
    const err = refusal(() =>
      hostedDomainGate(
        { ...claims, email: "victim@example.com" },
        { ...policy, allowedDomains: [...policy.allowedDomains] },
      ),
    );
    expect(isIdentitySourceRefused(err)).toBe(true);
    expect(err.message).toBe(`Google account not allowed: hosted domain ${shown} is not permitted`);
    expect(err.message).not.toContain("victim");
  });

  it("does not let a suffix or a lookalike pass", () => {
    for (const hd of ["evil-example.com", "example.com.evil", "sub.example.com"]) {
      expect(isIdentitySourceRefused(refusal(() => hostedDomainGate({ hd }, listed)))).toBe(true);
    }
  });

  it("refuses an hd that is not a domain name, so it can never become the consumer tenant", () => {
    for (const hd of ["consumer", "a b.example", "example.com:443"]) {
      const err = refusal(() => hostedDomainGate({ hd }, anyone));
      expect(isIdentitySourceRefused(err)).toBe(true);
      expect(err.message).toContain("(invalid)");
    }
  });

  it("caps a long hd in the refusal message", () => {
    const err = refusal(() => hostedDomainGate({ hd: `${"a".repeat(500)}.example` }, listed));
    expect(err.message.length).toBeLessThan(400);
  });
});

describe("emailIsAuthoritative", () => {
  it.each([
    ["hd + verified", { hd: "example.com", email: "a@example.com", email_verified: true }, true],
    [
      "hd + verified, secondary domain",
      { hd: "example.com", email: "a@example.org", email_verified: true },
      true,
    ],
    ["gmail + verified", { email: "a@gmail.com", email_verified: true }, true],
    ["GMail upper case + verified", { email: "A@GMail.com", email_verified: true }, true],
    ["consumer on another domain", { email: "alice@customer.com", email_verified: true }, false],
    [
      "hd + not verified",
      { hd: "example.com", email: "a@example.com", email_verified: false },
      false,
    ],
    [
      "verified as a string",
      { hd: "example.com", email: "a@example.com", email_verified: "true" },
      false,
    ],
    ["gmail with a string flag", { email: "a@gmail.com", email_verified: "true" }, false],
    ["no email", { hd: "example.com", email_verified: true }, false],
    ["empty hd counts as none", { hd: "", email: "a@customer.com", email_verified: true }, false],
    ["gmail as a subdomain is not gmail", { email: "a@x.gmail.com", email_verified: true }, false],
    ["gmail lookalike", { email: "a@notgmail.com", email_verified: true }, false],
  ] as const)("%s -> %s", (_name, claims, expected) => {
    expect(emailIsAuthoritative(claims)).toBe(expected);
  });
});

describe("toExternalIdentity", () => {
  it("maps a Workspace account", () => {
    expect(
      toExternalIdentity(
        {
          sub: "1001",
          hd: "Example.com",
          email: "Alice@Example.com",
          email_verified: true,
          name: "Alice A",
          picture: "https://lh3.googleusercontent.com/a",
        },
        "example.com",
      ),
    ).toEqual({
      source: "google:example.com",
      externalId: "1001",
      tenantId: "example.com",
      email: "alice@example.com",
      emailVerified: true,
      displayName: "Alice A",
      avatarUrl: "https://lh3.googleusercontent.com/a",
    });
  });

  it("maps a consumer account to the consumer tenant", () => {
    const id = toExternalIdentity(
      { sub: "2002", email: "bob@customer.com", email_verified: true },
      undefined,
    );
    expect(CONSUMER_TENANT).toBe("consumer");
    expect(id.tenantId).toBe("consumer");
    expect(id.source).toBe("google:consumer");
    expect(id.emailVerified).toBe(false);
  });

  it("is never verified without an email", () => {
    const id = toExternalIdentity(
      { sub: "3", hd: "example.com", email_verified: true },
      "example.com",
    );
    expect(id.email).toBeUndefined();
    expect(id.emailVerified).toBe(false);
  });

  it("falls back for the display name in order", () => {
    const at = (claims: Record<string, unknown>) =>
      toExternalIdentity({ sub: "9", ...claims }, "example.com").displayName;
    expect(at({ name: "N", given_name: "G", family_name: "F", email: "e@example.com" })).toBe("N");
    expect(at({ name: " ", given_name: "G", family_name: "F" })).toBe("G F");
    expect(at({ given_name: "G" })).toBe("G");
    expect(at({ family_name: "F" })).toBe("F");
    expect(at({ email: "local.part@example.com" })).toBe("local.part");
    expect(at({})).toBe("9");
    expect(at({ name: "x".repeat(300) })).toHaveLength(200);
  });

  it.each(["http://x/y.png", "javascript:alert(1)", "not a url", 42])(
    "drops the avatar %j",
    (picture) => {
      expect(toExternalIdentity({ sub: "1", picture }, "example.com").avatarUrl).toBeUndefined();
    },
  );

  it("refuses claims without a subject", () => {
    expect(() => toExternalIdentity({ sub: "" }, "example.com")).toThrow(/sub/);
    expect(() => toExternalIdentity({}, "example.com")).toThrow(/sub/);
  });
});
