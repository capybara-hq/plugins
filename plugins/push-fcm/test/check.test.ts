import {
  type SetupCheckArgs,
  type SetupCheckResult,
  validateSetupCheckResult,
} from "@capybara-hq/plugin-sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { credentialsCheck } from "../src/check.js";
import { type FakeFcm, startFakeFcm } from "./fake-fcm.js";

let fake: FakeFcm;
beforeEach(async () => {
  fake = await startFakeFcm();
});
afterEach(async () => {
  await fake.close();
});

async function run(config: unknown): Promise<SetupCheckResult> {
  const check = credentialsCheck({ tokenUrl: fake.tokenUrl, apiBase: fake.apiBase });
  expect(check.place).toBe("extension-deployment");
  const args: SetupCheckArgs = {
    orgId: null,
    config,
    locale: "en",
    mode: null,
    target: { kind: "extension-deployment", plugin: "push-fcm", config },
    signal: new AbortController().signal,
  };
  const result = await check.run(args);
  const valid = validateSetupCheckResult(result);
  expect(valid).not.toHaveProperty("problem");
  // nothing of the service account (key, email, project) is echoed
  const text = JSON.stringify(result);
  const sa = JSON.parse(fake.serviceAccount) as Record<string, string>;
  for (const field of ["private_key", "client_email", "project_id"]) {
    expect(text).not.toContain(sa[field]);
  }
  expect(text).not.toContain(sa.private_key?.slice(40, 80));
  for (const t of fake.issued) expect(text).not.toContain(t);
  return result;
}

const config = () => ({ serviceAccount: fake.serviceAccount, applicationIds: ["com.example.app"] });

describe("setup check fcm-credentials", () => {
  it("ok when Google issues an access token; nothing is cached or sent", async () => {
    expect((await run(config())).status).toBe("ok");
    expect(fake.tokens).toHaveLength(1);
    expect(fake.sends).toHaveLength(0);
  });

  it("failing with a fix on invalid_grant", async () => {
    fake.arrangeToken("invalid_grant");
    const r = await run(config());
    expect(r.status).toBe("failing");
    expect(r.reason?.en).toContain("invalid_grant");
    expect(r.fix?.en).toBeTruthy();
  });

  it("failing on invalid_client", async () => {
    fake.arrangeToken("invalid_client");
    expect((await run(config())).status).toBe("failing");
  });

  it.each(["server_error", "network_error", "rate_limited"] as const)(
    "unknown when the token endpoint answers %s",
    async (o) => {
      fake.arrangeToken(o);
      expect((await run(config())).status).toBe("unknown");
    },
  );

  it("failing without a saved service account", async () => {
    const r = await run(null);
    expect(r.status).toBe("failing");
    expect(r.fix?.en).toContain("serviceAccount");
    expect(fake.tokens).toHaveLength(0);
  });

  it("failing on a service account that is not usable, without echoing it", async () => {
    const r = await run({ serviceAccount: '{"project_id":"x"}', applicationIds: ["a"] });
    expect(r.status).toBe("failing");
    expect(r.reason?.en).toContain("client_email");
    expect(fake.tokens).toHaveLength(0);
  });

  it("unknown when the kernel aborts it", async () => {
    const check = credentialsCheck({ tokenUrl: fake.tokenUrl, apiBase: fake.apiBase });
    const ac = new AbortController();
    ac.abort();
    const r = await check.run({
      orgId: null,
      config: config(),
      locale: "en",
      mode: null,
      target: { kind: "extension-deployment", plugin: "push-fcm", config: config() },
      signal: ac.signal,
    });
    expect(r.status).toBe("unknown");
  });
});
