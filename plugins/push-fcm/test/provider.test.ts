import { createHash } from "node:crypto";
import {
  checkPushResults,
  PushError,
  type PushMessage,
  type PushResult,
  type PushTarget,
} from "@capybara-hq/plugin-sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeFcmProvider } from "../src/provider.js";
import {
  type FakeFcm,
  type FakeFcmOutcome,
  memoryKv,
  otherPrivateKey,
  startFakeFcm,
} from "./fake-fcm.js";

const MESSAGE: PushMessage = {
  title: "Support agent",
  body: "finished",
  path: "/chat/c1?org=o1",
  threadId: "c1",
  collapseId: "c1-42",
  origin: "https://cap.example",
};
const TOKEN = "device-token-SECRET-abc123";
const target = (id: string, token = TOKEN): PushTarget => ({
  id,
  platform: "android",
  appId: "com.example.app",
  token,
});

let fake: FakeFcm;
let kv: ReturnType<typeof memoryKv>;

beforeEach(async () => {
  fake = await startFakeFcm();
  kv = memoryKv();
});
afterEach(async () => {
  await fake.close();
});

function provider(serviceAccount = fake.serviceAccount) {
  return makeFcmProvider({
    config: { serviceAccount, applicationIds: ["com.example.app", "com.example.beta"] },
    kv,
    endpoints: { tokenUrl: fake.tokenUrl, apiBase: fake.apiBase },
  });
}

async function sendOne(
  outcome: FakeFcmOutcome,
  message: PushMessage = MESSAGE,
): Promise<PushResult | PushError> {
  fake.arrange(TOKEN, outcome);
  try {
    const results = await provider().send({
      registrations: [target("r1")],
      message,
      signal: new AbortController().signal,
    });
    expect(checkPushResults([target("r1")], results)).toBeNull();
    return results[0] as PushResult;
  } catch (e) {
    if (e instanceof PushError) return e;
    throw e;
  }
}

describe("the FCM v1 request", () => {
  it("posts the message to the project's send endpoint with the access token", async () => {
    expect(await sendOne("delivered", { ...MESSAGE, badge: 3 })).toEqual({
      registrationId: "r1",
      status: "delivered",
    });
    expect(fake.sends).toHaveLength(1);
    const [s] = fake.sends;
    expect(s?.projectId).toBe(fake.projectId);
    expect(s?.authorization).toBe(`Bearer ${fake.issued[0]}`);
    expect(s?.body).toEqual({
      message: {
        token: TOKEN,
        notification: { title: MESSAGE.title, body: MESSAGE.body },
        data: { path: MESSAGE.path, origin: MESSAGE.origin, threadId: MESSAGE.threadId },
        android: {
          priority: "HIGH",
          ttl: "86400s",
          collapse_key: MESSAGE.collapseId,
          notification: { tag: MESSAGE.threadId, notification_count: 3 },
        },
      },
    });
  });

  it("leaves out the badge count when the message has none", async () => {
    await sendOne("delivered");
    const android = fake.sends[0]?.body.message.android as Record<string, unknown>;
    expect(android.notification).toEqual({ tag: MESSAGE.threadId });
  });

  it("signs an RS256 JWT bearer assertion for the firebase.messaging scope", async () => {
    await sendOne("delivered");
    expect(fake.tokens).toHaveLength(1);
    const [t] = fake.tokens;
    expect(t?.grantType).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
    expect(t?.signatureValid).toBe(true);
    expect(t?.header).toEqual({ alg: "RS256", typ: "JWT" });
    expect(t?.claims).toMatchObject({
      iss: fake.clientEmail,
      scope: "https://www.googleapis.com/auth/firebase.messaging",
      aud: fake.tokenUrl,
    });
    const claims = (t?.claims ?? {}) as { iat?: number; exp?: number };
    expect((claims.exp ?? 0) - (claims.iat ?? 0)).toBe(3600);
  });
});

describe("the response mapping (one case per row)", () => {
  it("200 → delivered", async () => {
    expect(await sendOne("delivered")).toEqual({ registrationId: "r1", status: "delivered" });
  });

  it("404 UNREGISTERED → unregistered", async () => {
    expect(await sendOne("unregistered")).toEqual({ registrationId: "r1", status: "unregistered" });
  });

  it("400 INVALID_ARGUMENT naming message.token → unregistered", async () => {
    expect(await sendOne("invalid_token")).toEqual({
      registrationId: "r1",
      status: "unregistered",
    });
  });

  it("401 → auth", async () => {
    expect(await sendOne("auth")).toMatchObject({ status: "failed", kind: "auth" });
  });

  it("401 THIRD_PARTY_AUTH_ERROR → auth", async () => {
    expect(await sendOne("third_party_auth")).toMatchObject({ status: "failed", kind: "auth" });
  });

  it("403 SENDER_ID_MISMATCH → auth", async () => {
    expect(await sendOne("sender_mismatch")).toMatchObject({ status: "failed", kind: "auth" });
  });

  it("429 QUOTA_EXCEEDED → rate_limited with Retry-After in ms", async () => {
    expect(await sendOne("rate_limited")).toMatchObject({
      status: "failed",
      kind: "rate_limited",
      retryAfterMs: 7000,
    });
  });

  it("429 without Retry-After → rate_limited without retryAfterMs", async () => {
    const r = await sendOne({ status: 429, body: { error: { status: "RESOURCE_EXHAUSTED" } } });
    expect(r).toMatchObject({ status: "failed", kind: "rate_limited" });
    expect(r).not.toHaveProperty("retryAfterMs");
  });

  it("another 400 → transient", async () => {
    expect(await sendOne("invalid_argument")).toMatchObject({
      status: "failed",
      kind: "transient",
    });
  });

  it("a 404 that is not UNREGISTERED → transient", async () => {
    expect(await sendOne("not_found")).toMatchObject({ status: "failed", kind: "transient" });
  });

  it.each(["transient", "server_error"] as const)("5xx (%s) → transient", async (o) => {
    expect(await sendOne(o)).toMatchObject({ status: "failed", kind: "transient" });
  });

  it("a body that is not JSON → transient", async () => {
    expect(await sendOne({ status: 502, body: "<html>bad gateway</html>" })).toMatchObject({
      status: "failed",
      kind: "transient",
    });
  });

  it("a network error → transient", async () => {
    expect(await sendOne("network_error")).toMatchObject({ status: "failed", kind: "transient" });
  });

  it("token endpoint 400 invalid_grant → a thrown auth PushError", async () => {
    fake.arrangeToken("invalid_grant");
    const e = await sendOne("delivered");
    expect(e).toBeInstanceOf(PushError);
    expect((e as PushError).kind).toBe("auth");
    expect(fake.sends).toHaveLength(0);
  });

  it("a key the token endpoint does not accept → auth", async () => {
    const sa = JSON.parse(fake.serviceAccount) as Record<string, unknown>;
    const p = provider(JSON.stringify({ ...sa, private_key: otherPrivateKey() }));
    await expect(
      p.send({
        registrations: [target("r1")],
        message: MESSAGE,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ kind: "auth" });
  });

  it.each([
    ["server_error", "transient"],
    ["network_error", "transient"],
    ["rate_limited", "rate_limited"],
    ["invalid_client", "auth"],
  ] as const)("token endpoint %s → a thrown %s PushError", async (o, kind) => {
    fake.arrangeToken(o);
    const e = await sendOne("delivered");
    expect(e).toBeInstanceOf(PushError);
    expect((e as PushError).kind).toBe(kind);
  });

  it("no message carries the device token, the access token or the key", async () => {
    const sa = JSON.parse(fake.serviceAccount) as { private_key: string };
    for (const o of [
      "unregistered",
      "invalid_token",
      "auth",
      "sender_mismatch",
      "rate_limited",
      "invalid_argument",
      "server_error",
      "network_error",
    ] as const) {
      const r = await sendOne(o);
      const msg = r instanceof PushError ? r.message : r.status === "failed" ? r.message : "";
      expect(msg).not.toContain(TOKEN);
      for (const t of fake.issued) expect(msg).not.toContain(t);
      expect(msg).not.toContain(sa.private_key.slice(40, 80));
    }
  });
});

describe("several registrations", () => {
  it("answers each registration in order with its own outcome, one token exchange", async () => {
    fake.arrange("t-ok", "delivered");
    fake.arrange("t-dead", "unregistered");
    fake.arrange("t-rate", "rate_limited");
    const regs = [target("a", "t-ok"), target("b", "t-dead"), target("c", "t-rate")];
    const results = await provider().send({
      registrations: regs,
      message: MESSAGE,
      signal: new AbortController().signal,
    });
    expect(checkPushResults(regs, results)).toBeNull();
    expect(results.map((r) => [r.registrationId, r.status])).toEqual([
      ["a", "delivered"],
      ["b", "unregistered"],
      ["c", "failed"],
    ]);
    expect(fake.tokens).toHaveLength(1);
  });
});

describe("the access token cache", () => {
  const key = () => `fcm-token-${createHash("sha256").update(fake.clientEmail).digest("hex")}`;

  it("caches the access token in kv for expires_in − 300 seconds and reuses it", async () => {
    fake.arrangeToken("ok", { expiresIn: 3599 });
    const p = provider();
    const signal = new AbortController().signal;
    await p.send({ registrations: [target("r1")], message: MESSAGE, signal });
    await p.send({ registrations: [target("r2")], message: MESSAGE, signal });
    // a second provider instance (another replica) reads the same kv
    await provider().send({ registrations: [target("r3")], message: MESSAGE, signal });
    expect(fake.tokens).toHaveLength(1);
    expect(kv.writes).toEqual([{ key: key(), value: fake.issued[0], ttlSeconds: 3299 }]);
    expect(fake.sends.map((s) => s.authorization)).toEqual(
      Array(3).fill(`Bearer ${fake.issued[0]}`),
    );
  });

  it("does not cache a token that lives 300 seconds or less", async () => {
    fake.arrangeToken("ok", { expiresIn: 300 });
    await sendOne("delivered");
    expect(kv.writes).toEqual([]);
  });

  it("drops the cached token when FCM answers 401, so the next send exchanges again", async () => {
    const signal = new AbortController().signal;
    await provider().send({ registrations: [target("r1")], message: MESSAGE, signal });
    fake.arrange(TOKEN, "auth");
    const [r] = await provider().send({ registrations: [target("r1")], message: MESSAGE, signal });
    expect(r).toMatchObject({ status: "failed", kind: "auth" });
    expect(kv.deletes).toEqual([key()]);
    fake.arrange(TOKEN, "delivered");
    await provider().send({ registrations: [target("r1")], message: MESSAGE, signal });
    expect(fake.tokens).toHaveLength(2);
  });
});

describe("abort", () => {
  it("an already aborted signal settles as transient without reaching FCM", async () => {
    const ac = new AbortController();
    ac.abort();
    const settled = await provider()
      .send({ registrations: [target("r1")], message: MESSAGE, signal: ac.signal })
      .then(
        (results) => results[0],
        (e: unknown) => e,
      );
    if (settled instanceof PushError) expect(settled.kind).toBe("transient");
    else expect(settled).toMatchObject({ status: "failed", kind: "transient" });
    expect(fake.sends).toHaveLength(0);
  });

  it("a hanging send settles as transient once the signal aborts", async () => {
    fake.arrange(TOKEN, "hang");
    const p = provider();
    const ac = new AbortController();
    // exchange the token first, so the abort lands on the hanging send
    await p.send({
      registrations: [target("warm", "warm-token")],
      message: MESSAGE,
      signal: ac.signal,
    });
    const pending = p.send({ registrations: [target("r1")], message: MESSAGE, signal: ac.signal });
    await expect.poll(() => fake.sends.length).toBe(2);
    ac.abort();
    expect(await pending).toEqual([
      expect.objectContaining({ registrationId: "r1", status: "failed", kind: "transient" }),
    ]);
  });
});

describe("apps()", () => {
  it("lists the configured application ids, the same array each time, without a request", () => {
    const p = provider();
    expect(p.apps()).toEqual(["com.example.app", "com.example.beta"]);
    expect(p.apps()).toBe(p.apps());
    expect(fake.tokens).toHaveLength(0);
  });
});
