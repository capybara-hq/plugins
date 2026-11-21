import type { PushMessage, PushResult, PushTarget } from "@capybara-hq/plugin-sdk";
import { checkPushResults } from "@capybara-hq/plugin-sdk";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { JPushDeploymentConfig } from "../src/config.js";
import { createJPushProvider, notifyIdOf } from "../src/jpush.js";
import { type FakeAnswer, type FakeJPush, startFakeJPush } from "./fake-jpush.js";

/**
 * The JPush request a send builds and how every documented JPush answer maps to a push result
 * (https://docs.jiguang.cn/jpush/server/push/rest_api_v3_push, error codes).
 */
let fake: FakeJPush;
beforeAll(async () => {
  fake = await startFakeJPush();
});
afterAll(async () => {
  await fake?.stop();
});
beforeEach(() => {
  fake.requests.length = 0;
});

const MESSAGE: PushMessage = {
  title: "Support agent",
  body: "needs your approval",
  path: "/chat/c1?org=o1",
  threadId: "c1",
  collapseId: "conv-c1-7",
  origin: "https://capybara.example.com",
};
const target = (id: string, token: string): PushTarget => ({
  id,
  platform: "android",
  appId: "com.example.app",
  token,
});
const config = (over: Partial<JPushDeploymentConfig> = {}): JPushDeploymentConfig => ({
  appKey: fake.appKey,
  masterSecret: fake.masterSecret,
  applicationIds: ["com.example.app", "com.example.app.beta"],
  ...over,
});
const provider = (over: Partial<JPushDeploymentConfig> = {}) =>
  createJPushProvider(config(over), { baseUrl: fake.url });

async function sendOne(token: string, answer?: FakeAnswer, over = {}): Promise<PushResult> {
  if (answer) fake.arrange(token, answer);
  const regs = [target("r1", token)];
  const results = await provider(over).send({
    registrations: regs,
    message: MESSAGE,
    signal: new AbortController().signal,
  });
  expect(checkPushResults(regs, results)).toBeNull();
  const r = results[0] as PushResult;
  if (r.status === "failed") {
    expect(r.message).not.toContain(token);
    expect(r.message).not.toContain(fake.masterSecret);
  }
  return r;
}

const jpushError = (
  status: number,
  code: number,
  headers?: Record<string, string>,
  message = "scripted",
) => ({
  status,
  body: { error: { code, message } },
  ...(headers && { headers }),
});

/** The parts of a `/v3/push` body the assertions read. */
interface JPushBody {
  platform: unknown;
  audience: unknown;
  notification: unknown;
  options: { third_party_channel: unknown };
}

const pushBodies = () =>
  fake.requests.filter((r) => r.path === "/v3/push").map((r) => r.body as JPushBody);

describe("the JPush request", () => {
  it("sends one Android notification per registration with the message in extras", async () => {
    expect(await sendOne("1a0018970af5e4a8a8b")).toEqual({
      registrationId: "r1",
      status: "delivered",
    });
    const [req] = fake.requests;
    expect(req?.method).toBe("POST");
    expect(req?.authorization).toBe(
      `Basic ${Buffer.from(`${fake.appKey}:${fake.masterSecret}`).toString("base64")}`,
    );
    const body = req?.body as JPushBody;
    expect(body.platform).toEqual(["android"]);
    expect(body.audience).toEqual({ registration_id: ["1a0018970af5e4a8a8b"] });
    expect(body.notification).toEqual({
      android: {
        alert: MESSAGE.body,
        title: MESSAGE.title,
        intent: { url: "intent:#Intent;action=android.intent.action.MAIN;end" },
        extras: {
          path: MESSAGE.path,
          origin: MESSAGE.origin,
          threadId: MESSAGE.threadId,
          collapseId: MESSAGE.collapseId,
        },
      },
    });
  });

  it("marks the message as a service message on JPush and every vendor channel", async () => {
    await sendOne("1a0018970af5e4a8a8b");
    const options = pushBodies()[0]?.options;
    const id = notifyIdOf(MESSAGE.collapseId);
    expect(options).toEqual({
      classification: 1,
      third_party_channel: {
        huawei: { importance: "NORMAL", notify_id: id },
        honor: { importance: "NORMAL", notify_id: id },
        xiaomi: { notify_id: id },
        oppo: { notify_id: id },
        vivo: { notify_id: id },
      },
    });
  });

  it("carries the deployer's vendor classification fields and fills templates with title and body", async () => {
    await sendOne("1a0018970af5e4a8a8b", undefined, {
      xiaomi: { channelId: "mi-private-1", templateId: "mi-tpl-1" },
      oppo: { channelId: "oppo-im", category: "IM", notifyLevel: 16 },
      vivo: { category: "IM", templateId: "4711" },
      huawei: { category: "IM" },
    });
    const tpc = pushBodies()[0]?.options.third_party_channel;
    const id = notifyIdOf(MESSAGE.collapseId);
    expect(tpc).toEqual({
      huawei: { importance: "NORMAL", notify_id: id, category: "IM" },
      honor: { importance: "NORMAL", notify_id: id },
      xiaomi: {
        notify_id: id,
        channel_id: "mi-private-1",
        mi_template_id: "mi-tpl-1",
        mi_template_param: JSON.stringify({ title: MESSAGE.title, body: MESSAGE.body }),
      },
      oppo: { notify_id: id, channel_id: "oppo-im", category: "IM", notify_level: 16 },
      vivo: {
        notify_id: id,
        category: "IM",
        vivo_push_type: 4,
        vivo_template_id: "4711",
        vivo_template_param: { title: MESSAGE.title, body: MESSAGE.body },
      },
    });
  });

  it("derives the vendor notify id from the collapse id: stable, positive 31-bit, distinct", () => {
    const a = notifyIdOf("conv-c1-7");
    expect(notifyIdOf("conv-c1-7")).toBe(a);
    expect(notifyIdOf("conv-c1-8")).not.toBe(a);
    for (const c of ["a", "conv-c1-7", "x".repeat(64), "A.b_c-9"]) {
      const n = notifyIdOf(c);
      expect(Number.isInteger(n)).toBe(true);
      expect(n).toBeGreaterThanOrEqual(1);
      expect(n).toBeLessThanOrEqual(2 ** 31 - 1);
    }
  });

  it("apps() lists the configured application ids without a request", () => {
    const p = provider();
    expect(p.apps()).toEqual(["com.example.app", "com.example.app.beta"]);
    expect(p.apps()).toBe(p.apps());
    expect(fake.requests).toEqual([]);
  });
});

describe("JPush answers", () => {
  it.each([
    [1011, "cannot find user by this audience"],
    [1003, "Invalid registration_id"],
    [1003, "audience value must be JSON Array format!"],
  ])("code %i (%s) is unregistered", async (code, message) => {
    expect(await sendOne("1a0018970af5e4a8a8b", jpushError(400, code, undefined, message))).toEqual(
      { registrationId: "r1", status: "unregistered" },
    );
  });

  it.each([
    "third_party_channel.oppo.category is invalid",
    "mi_template_param must be json string",
    "",
  ])("1003 for another parameter (%j) keeps the registration: transient", async (message) => {
    const r = await sendOne("1a0018970af5e4a8a8b", jpushError(400, 1003, undefined, message));
    expect(r).toMatchObject({ status: "failed", kind: "transient" });
    const text = r.status === "failed" ? r.message : "";
    expect(text).toContain("vendor channel fields");
    if (message !== "") expect(text).not.toContain(message);
  });

  it("an id that can never be a JPush registration id is unregistered without a request", async () => {
    for (const token of ["has space", "tab\tid", "ünïcode"]) {
      expect(await sendOne(token)).toEqual({ registrationId: "r1", status: "unregistered" });
    }
    expect(fake.requests).toEqual([]);
  });

  it.each([
    [1004, 401],
    [1008, 400],
    [2003, 403],
    [2004, 403],
  ])("code %i is auth", async (code, status) => {
    const r = await sendOne("1a0018970af5e4a8a8b", jpushError(status, code));
    expect(r).toMatchObject({ status: "failed", kind: "auth" });
    expect(r.status === "failed" && r.message).toContain(String(code));
  });

  it("a 401 or 403 without a JPush code is auth", async () => {
    for (const status of [401, 403]) {
      const r = await sendOne("1a0018970af5e4a8a8b", { status, body: "denied" });
      expect(r).toMatchObject({ status: "failed", kind: "auth" });
    }
  });

  it("2002 (HTTP 429) is rate_limited with X-Rate-Limit-Reset as the wait", async () => {
    const r = await sendOne(
      "1a0018970af5e4a8a8b",
      jpushError(429, 2002, { "X-Rate-Limit-Reset": "7" }),
    );
    expect(r).toEqual({
      registrationId: "r1",
      status: "failed",
      kind: "rate_limited",
      message: expect.any(String),
      retryAfterMs: 7000,
    });
  });

  it("Retry-After wins over X-Rate-Limit-Reset", async () => {
    const r = await sendOne(
      "1a0018970af5e4a8a8b",
      jpushError(429, 2002, { "Retry-After": "3", "X-Rate-Limit-Reset": "7" }),
    );
    expect(r).toMatchObject({ kind: "rate_limited", retryAfterMs: 3000 });
  });

  it.each([
    [1012, 400],
    [2005, 403],
    [2008, 400],
  ])("code %i is rate_limited", async (code, status) => {
    const r = await sendOne("1a0018970af5e4a8a8b", jpushError(status, code));
    expect(r).toMatchObject({ status: "failed", kind: "rate_limited" });
    expect(r.status === "failed" && r.retryAfterMs).toBeFalsy();
  });

  it("a 429 without a body is rate_limited", async () => {
    const r = await sendOne("1a0018970af5e4a8a8b", { status: 429 });
    expect(r).toMatchObject({ status: "failed", kind: "rate_limited" });
  });

  it.each([
    [1000, 500],
    [1030, 503],
    [1005, 400],
    [1002, 400],
    [2009, 400],
    [2010, 400],
  ])("code %i is transient", async (code, status) => {
    const r = await sendOne("1a0018970af5e4a8a8b", jpushError(status, code));
    expect(r).toMatchObject({ status: "failed", kind: "transient" });
  });

  it("a 5xx without a body and a non-JSON body are transient", async () => {
    for (const a of [{ status: 502 }, { status: 400, body: "<html>" }]) {
      const r = await sendOne("1a0018970af5e4a8a8b", a);
      expect(r).toMatchObject({ status: "failed", kind: "transient" });
    }
  });

  it("an error object in a 200 answer is not delivered", async () => {
    const r = await sendOne("1a0018970af5e4a8a8b", jpushError(200, 1011));
    expect(r).toEqual({ registrationId: "r1", status: "unregistered" });
  });
});

describe("several registrations", () => {
  const regs = [target("r1", "1a01aaaa"), target("r2", "1a02bbbb"), target("r3", "1a03cccc")];

  it.each([
    ["auth", jpushError(401, 1004)],
    ["rate_limited", jpushError(429, 2002, { "X-Rate-Limit-Reset": "5" })],
  ] as const)("after %s the rest fail the same way without a request", async (kind, answer) => {
    fake.arrange("1a01aaaa", answer);
    const results = await provider().send({
      registrations: regs,
      message: MESSAGE,
      signal: new AbortController().signal,
    });
    expect(checkPushResults(regs, results)).toBeNull();
    expect(results.map((r) => r.status === "failed" && r.kind)).toEqual([kind, kind, kind]);
    expect(pushBodies()).toHaveLength(1);
    fake.arrange("1a01aaaa", "delivered");
  });

  it("a vendor quota (1012) does not stop the others", async () => {
    fake.arrange("1a01aaaa", jpushError(400, 1012));
    const results = await provider().send({
      registrations: regs,
      message: MESSAGE,
      signal: new AbortController().signal,
    });
    expect(results.map((r) => (r.status === "failed" ? r.kind : r.status))).toEqual([
      "rate_limited",
      "delivered",
      "delivered",
    ]);
    expect(pushBodies()).toHaveLength(3);
    fake.arrange("1a01aaaa", "delivered");
  });

  it("a transient failure does not stop the others", async () => {
    fake.arrange("1a01aaaa", "transient");
    const results = await provider().send({
      registrations: regs,
      message: MESSAGE,
      signal: new AbortController().signal,
    });
    expect(results.map((r) => r.status)).toEqual(["failed", "delivered", "delivered"]);
    expect(pushBodies()).toHaveLength(3);
    fake.arrange("1a01aaaa", "delivered");
  });

  it("an already aborted signal sends nothing and answers transient", async () => {
    const ac = new AbortController();
    ac.abort();
    const results = await provider().send({
      registrations: regs,
      message: MESSAGE,
      signal: ac.signal,
    });
    expect(checkPushResults(regs, results)).toBeNull();
    expect(results.every((r) => r.status === "failed" && r.kind === "transient")).toBe(true);
    expect(fake.requests).toEqual([]);
  });
});
