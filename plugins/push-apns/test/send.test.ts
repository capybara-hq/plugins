import { verify } from "node:crypto";
import {
  checkPushResults,
  PushError,
  type PushMessage,
  type PushTarget,
} from "@capybara-hq/plugin-sdk";
import { describePushProviderConformance } from "@capybara-hq/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ApnsDeployment } from "../src/config.js";
import { jwtCacheKey } from "../src/jwt.js";
import { APPLE_ORIGINS, createApnsProvider, mapApnsAnswer } from "../src/send.js";
import { FAKE_APNS_CA, type FakeApns, startFakeApns } from "./fake-apns.js";
import { decodeJwt, KEY_ID, memoryKv, TEAM_ID, testConfig, testSigningKey } from "./helpers.js";

const NOW = Date.UTC(2026, 10, 21, 8, 0, 0);

describePushProviderConformance({
  plugin: "push-apns",
  async make() {
    const fake = await startFakeApns();
    const { pem } = testSigningKey();
    const provider = createApnsProvider({
      config: testConfig(pem),
      kv: memoryKv(),
      net: { origin: () => fake.url, ca: FAKE_APNS_CA },
    });
    return { provider, arrange: fake.arrange, requests: fake.requests, close: fake.close };
  },
});

const MESSAGE: PushMessage = {
  title: "Support agent",
  body: "needs your approval",
  path: "/chat/c1?org=o1",
  threadId: "c1",
  collapseId: "conv-c1-7",
  origin: "https://capybara.example.com",
};
const target = (id: string, token: string, appId = "com.example.app"): PushTarget => ({
  id,
  platform: "ios",
  appId,
  token,
});

describe("the APNs request", () => {
  let fake: FakeApns;
  let fakeProd: FakeApns;
  beforeAll(async () => {
    [fake, fakeProd] = await Promise.all([startFakeApns(), startFakeApns()]);
  });
  afterAll(async () => {
    await Promise.all([fake?.close(), fakeProd?.close()]);
  });
  beforeEach(() => {
    fake.received.length = 0;
    fakeProd.received.length = 0;
  });

  function make(config: ApnsDeployment, kv = memoryKv()) {
    return {
      kv,
      provider: createApnsProvider({
        config,
        kv,
        net: {
          origin: (env) => (env === "production" ? fakeProd.url : fake.url),
          ca: FAKE_APNS_CA,
        },
        now: () => NOW,
      }),
    };
  }

  it("posts /3/device/<token> with the bearer JWT, topic, push type, priority, expiration and collapse id", async () => {
    const { pem, publicKey } = testSigningKey();
    const { provider } = make(testConfig(pem));
    const results = await provider.send({
      registrations: [target("r1", "a1b2c3")],
      message: { ...MESSAGE, badge: 3 },
      signal: new AbortController().signal,
    });
    expect(results).toEqual([{ registrationId: "r1", status: "delivered" }]);
    const [req] = fake.received;
    expect(req?.token).toBe("a1b2c3");
    expect(req?.headers).toMatchObject({
      "apns-topic": "com.example.app",
      "apns-push-type": "alert",
      "apns-priority": "10",
      "apns-expiration": String(Math.floor(NOW / 1000) + 86400),
      "apns-collapse-id": "conv-c1-7",
    });
    expect(req?.body).toEqual({
      aps: {
        alert: { title: "Support agent", body: "needs your approval" },
        "thread-id": "c1",
        sound: "default",
        badge: 3,
      },
      path: "/chat/c1?org=o1",
      origin: "https://capybara.example.com",
    });
    const auth = req?.headers.authorization ?? "";
    expect(auth.startsWith("bearer ")).toBe(true);
    const jwt = auth.slice("bearer ".length);
    const { header, claims, sig } = decodeJwt(jwt);
    expect(header).toEqual({ alg: "ES256", kid: KEY_ID });
    expect(claims).toEqual({ iss: TEAM_ID, iat: Math.floor(NOW / 1000) });
    const signed = Buffer.from(jwt.slice(0, jwt.lastIndexOf(".")));
    expect(verify("sha256", signed, { key: publicKey, dsaEncoding: "ieee-p1363" }, sig)).toBe(true);
  });

  it("sends each bundle to its environment's host and reuses one cached JWT", async () => {
    const { pem } = testSigningKey();
    const { provider, kv } = make(
      testConfig(pem, {
        bundles: [
          { bundleId: "com.example.app", environment: "sandbox" },
          { bundleId: "com.example.prod", environment: "production" },
        ],
      }),
    );
    expect(provider.apps()).toEqual(["com.example.app", "com.example.prod"]);
    const results = await provider.send({
      registrations: [target("r1", "aa"), target("r2", "bb", "com.example.prod")],
      message: MESSAGE,
      signal: new AbortController().signal,
    });
    expect(results).toEqual([
      { registrationId: "r1", status: "delivered" },
      { registrationId: "r2", status: "delivered" },
    ]);
    expect(fake.received.map((r) => r.headers["apns-topic"])).toEqual(["com.example.app"]);
    expect(fakeProd.received.map((r) => r.headers["apns-topic"])).toEqual(["com.example.prod"]);
    expect(fake.received[0]?.headers.authorization).toBe(
      fakeProd.received[0]?.headers.authorization,
    );
    expect(kv.writes).toEqual([{ key: jwtCacheKey(KEY_ID), ttlSeconds: 2400 }]);
  });

  it("answers auth for an app id no bundle covers, without a request", async () => {
    const { pem } = testSigningKey();
    const { provider } = make(testConfig(pem));
    const regs = [target("r1", "aa", "com.other.app")];
    const results = await provider.send({
      registrations: regs,
      message: MESSAGE,
      signal: new AbortController().signal,
    });
    expect(checkPushResults(regs, results)).toBeNull();
    expect(results[0]).toMatchObject({ status: "failed", kind: "auth" });
    expect(fake.received).toHaveLength(0);
  });

  it("throws an auth PushError when the key cannot be read, without echoing it", async () => {
    const { provider } = make(
      testConfig("-----BEGIN PRIVATE KEY-----\nAAAAsecretbits\n-----END PRIVATE KEY-----"),
    );
    const error = await provider
      .send({
        registrations: [target("r1", "aa")],
        message: MESSAGE,
        signal: new AbortController().signal,
      })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PushError);
    expect((error as PushError).kind).toBe("auth");
    expect((error as PushError).message).not.toContain("secretbits");
    expect(fake.received).toHaveLength(0);
  });

  it("drops the cached JWT on 403 ExpiredProviderToken and answers transient", async () => {
    const { pem } = testSigningKey();
    const { provider, kv } = make(testConfig(pem));
    fake.respond("expired", { status: 403, reason: "ExpiredProviderToken" });
    const results = await provider.send({
      registrations: [target("r1", "expired")],
      message: MESSAGE,
      signal: new AbortController().signal,
    });
    expect(results[0]).toMatchObject({ status: "failed", kind: "transient" });
    expect(kv.dels).toEqual([jwtCacheKey(KEY_ID)]);
    expect(kv.data.has(jwtCacheKey(KEY_ID))).toBe(false);
  });

  it("passes a 429 Retry-After on as retryAfterMs", async () => {
    const { pem } = testSigningKey();
    const { provider } = make(testConfig(pem));
    fake.respond("slow", {
      status: 429,
      reason: "TooManyRequests",
      headers: { "retry-after": "7" },
    });
    const results = await provider.send({
      registrations: [target("r1", "slow")],
      message: MESSAGE,
      signal: new AbortController().signal,
    });
    expect(results[0]).toMatchObject({
      status: "failed",
      kind: "rate_limited",
      retryAfterMs: 7000,
    });
  });

  it("an already aborted signal answers transient for every registration without a request", async () => {
    const { pem } = testSigningKey();
    const { provider } = make(testConfig(pem));
    const ac = new AbortController();
    ac.abort();
    const regs = [target("r1", "aa"), target("r2", "bb")];
    const results = await provider.send({
      registrations: regs,
      message: MESSAGE,
      signal: ac.signal,
    });
    expect(checkPushResults(regs, results)).toBeNull();
    expect(results.map((r) => (r.status === "failed" ? r.kind : r.status))).toEqual([
      "transient",
      "transient",
    ]);
    expect(fake.received).toHaveLength(0);
  });

  it("an unreachable host answers transient", async () => {
    const { pem } = testSigningKey();
    const closed = await startFakeApns();
    const url = closed.url;
    await closed.close();
    const provider = createApnsProvider({
      config: testConfig(pem),
      kv: memoryKv(),
      net: { origin: () => url, ca: FAKE_APNS_CA },
    });
    const results = await provider.send({
      registrations: [target("r1", "secret-token-zz")],
      message: MESSAGE,
      signal: new AbortController().signal,
    });
    expect(results[0]).toMatchObject({ status: "failed", kind: "transient" });
    expect(JSON.stringify(results)).not.toContain("secret-token-zz");
  });

  it("an untrusted certificate answers transient (TLS is verified)", async () => {
    const { pem } = testSigningKey();
    const provider = createApnsProvider({
      config: testConfig(pem),
      kv: memoryKv(),
      net: { origin: () => fake.url },
    });
    const results = await provider.send({
      registrations: [target("r1", "aa")],
      message: MESSAGE,
      signal: new AbortController().signal,
    });
    expect(results[0]).toMatchObject({ status: "failed", kind: "transient" });
    expect(fake.received).toHaveLength(0);
  });

  it("talks to Apple's hosts by default", () => {
    expect(APPLE_ORIGINS).toEqual({
      production: "https://api.push.apple.com",
      sandbox: "https://api.sandbox.push.apple.com",
    });
  });
});

describe("mapApnsAnswer: one case per row", () => {
  it.each([
    [200, undefined, { status: "delivered" }, false],
    [410, "Unregistered", { status: "unregistered" }, false],
    [410, undefined, { status: "unregistered" }, false],
    [400, "BadDeviceToken", { status: "unregistered" }, false],
    [400, "Unregistered", { status: "unregistered" }, false],
    [403, "InvalidProviderToken", { status: "failed", kind: "auth" }, false],
    [400, "DeviceTokenNotForTopic", { status: "failed", kind: "auth" }, false],
    [400, "TopicDisallowed", { status: "failed", kind: "auth" }, false],
    [400, "BadTopic", { status: "failed", kind: "auth" }, false],
    [400, "MissingTopic", { status: "failed", kind: "auth" }, false],
    [403, "ExpiredProviderToken", { status: "failed", kind: "transient" }, true],
    [429, "TooManyRequests", { status: "failed", kind: "rate_limited" }, false],
    [429, "TooManyProviderTokenUpdates", { status: "failed", kind: "rate_limited" }, false],
    [500, "InternalServerError", { status: "failed", kind: "transient" }, false],
    [503, "ServiceUnavailable", { status: "failed", kind: "transient" }, false],
  ] as const)("%i %s", (status, reason, expected, dropToken) => {
    const mapped = mapApnsAnswer({ status, reason, retryAfter: undefined });
    expect(mapped.result).toMatchObject(expected);
    expect(mapped.dropToken).toBe(dropToken);
    if (mapped.result.status === "failed") {
      expect(mapped.result.message).toContain(String(status));
    }
  });

  it("ExpiredProviderToken says to check the server clock", () => {
    const mapped = mapApnsAnswer({
      status: 403,
      reason: "ExpiredProviderToken",
      retryAfter: undefined,
    });
    expect(mapped.result.status === "failed" && mapped.result.message).toMatch(/clock/);
  });

  it("names only a well-formed reason code in the message", () => {
    const mapped = mapApnsAnswer({
      status: 500,
      reason: "<script>tok=abc</script>",
      retryAfter: undefined,
    });
    expect(mapped.result.status === "failed" && mapped.result.message).not.toContain("tok=abc");
  });
});
