import {
  type SetupCheckArgs,
  type SetupCheckResult,
  validateSetupCheckResult,
} from "@capybara-hq/plugin-sdk";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createCredentialsCheck } from "../src/jpush.js";
import { type FakeJPush, startFakeJPush } from "./fake-jpush.js";

/**
 * The `jpush-credentials` setup check: it asks JPush for a cid (GET /v3/push/cid), which needs a
 * valid appKey:masterSecret and sends nothing. Every result validates and holds no secret.
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
  fake.arrangeCid(undefined as never);
});

const check = () => createCredentialsCheck({ baseUrl: fake.url });
const args = (config: unknown): SetupCheckArgs => ({
  orgId: null,
  config,
  locale: "en",
  mode: null,
  target: { kind: "extension-deployment", plugin: "push-jpush", config },
  signal: new AbortController().signal,
});
const good = () => ({
  appKey: fake.appKey,
  masterSecret: fake.masterSecret,
  applicationIds: ["com.example.app"],
});

async function run(config: unknown, secrets: string[] = []): Promise<SetupCheckResult> {
  const def = check();
  expect(def.place).toBe("extension-deployment");
  const r = await def.run(args(config));
  const v = validateSetupCheckResult(r);
  expect("problem" in v ? v.problem : undefined).toBeUndefined();
  const texts = [r.reason?.en, r.reason?.zh, r.fix?.en, r.fix?.zh].filter(
    (t): t is string => t !== undefined,
  );
  for (const t of texts) {
    for (const s of [fake.masterSecret, ...secrets]) {
      expect(t).not.toContain(s);
      expect(t).not.toContain(s.slice(0, 4));
    }
  }
  // the check never sends a push
  expect(fake.requests.every((q) => q.method === "GET" && q.path === "/v3/push/cid")).toBe(true);
  return r;
}

describe("jpush-credentials", () => {
  it("ok when JPush accepts the credentials", async () => {
    expect((await run(good())).status).toBe("ok");
    expect(fake.requests).toHaveLength(1);
  });

  it("failing with code 1004 for a wrong master secret", async () => {
    const r = await run({ ...good(), masterSecret: "wrong-secret-value-1234" }, [
      "wrong-secret-value-1234",
    ]);
    expect(r.status).toBe("failing");
    expect(r.reason?.en).toContain("1004");
  });

  it.each([
    [1008, 400],
    [2003, 403],
    [2004, 403],
  ])("failing with code %i", async (code, status) => {
    fake.arrangeCid({ status, body: { error: { code, message: "scripted" } } });
    const r = await run(good());
    expect(r.status).toBe("failing");
    expect(r.reason?.en).toContain(String(code));
    expect(r.fix?.en).toBeTruthy();
  });

  it("failing without a request when the credentials are missing", async () => {
    const r = await run({ applicationIds: ["com.example.app"] });
    expect(r.status).toBe("failing");
    expect(fake.requests).toEqual([]);
  });

  it.each([
    [{ status: 429, body: { error: { code: 2002, message: "Rate limit exceeded" } } }],
    [{ status: 500, body: { error: { code: 1000, message: "x" } } }],
    [{ status: 503 }],
  ])("unknown when JPush cannot tell (%j)", async (answer) => {
    fake.arrangeCid(answer);
    expect((await run(good())).status).toBe("unknown");
  });

  it("unknown on a network error", async () => {
    fake.arrangeCid("network_error");
    expect((await run(good())).status).toBe("unknown");
  });
});
