import { isSecret } from "@capybara-hq/plugin-sdk";
import { describe, expect, it } from "vitest";
import { FcmDeployment, parseServiceAccount } from "../src/config.js";
import { otherPrivateKey } from "./fake-fcm.js";

const KEY = otherPrivateKey();
const SA = {
  type: "service_account",
  project_id: "acme-push",
  private_key: KEY,
  client_email: "push@acme-push.iam.gserviceaccount.com",
};
const json = (o: unknown) => JSON.stringify(o);

/** Every issue message of a refused config, joined. */
function refusal(input: unknown): string {
  const r = FcmDeployment.safeParse(input);
  expect(r.success).toBe(false);
  return r.success ? "" : r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("\n");
}

describe("deployment config", () => {
  it("accepts a service account JSON and application ids", () => {
    const r = FcmDeployment.parse({ serviceAccount: json(SA), applicationIds: ["com.acme.app"] });
    expect(r.applicationIds).toEqual(["com.acme.app"]);
    expect(parseServiceAccount(r.serviceAccount)).toEqual({
      projectId: "acme-push",
      clientEmail: "push@acme-push.iam.gserviceaccount.com",
      privateKey: KEY,
    });
  });

  it("refuses a missing or empty service account and an empty application id list", () => {
    expect(refusal({ applicationIds: ["a"] })).toContain("serviceAccount");
    expect(refusal({ serviceAccount: "", applicationIds: ["a"] })).toContain("serviceAccount");
    expect(refusal({ serviceAccount: json(SA), applicationIds: [] })).toContain("applicationIds");
  });

  it("refuses text that is not a JSON object, without echoing it", () => {
    const secretish = "not-json-SECRET-VALUE-123";
    const m = refusal({ serviceAccount: secretish, applicationIds: ["a"] });
    expect(m).toContain("not JSON");
    expect(m).not.toContain(secretish);
    expect(refusal({ serviceAccount: "[1,2]", applicationIds: ["a"] })).toContain("JSON object");
  });

  it.each(["project_id", "client_email", "private_key"])(
    "refuses a service account without %s, naming the field and never a value",
    (field) => {
      const sa: Record<string, unknown> = { ...SA };
      delete sa[field];
      const m = refusal({ serviceAccount: json(sa), applicationIds: ["a"] });
      expect(m).toContain(field);
      for (const v of Object.values(SA)) expect(m).not.toContain(v);
    },
  );

  it("refuses a private key that is not a PEM private key, without echoing it", () => {
    const bad = "-----BEGIN PRIVATE KEY-----\nAAAA-NOT-A-KEY\n-----END PRIVATE KEY-----\n";
    const m = refusal({ serviceAccount: json({ ...SA, private_key: bad }), applicationIds: ["a"] });
    expect(m).toContain("private_key");
    expect(m).not.toContain("AAAA-NOT-A-KEY");
  });

  it("marks the service account as a secret field", () => {
    expect(isSecret(FcmDeployment.shape.serviceAccount)).toBe(true);
    expect(isSecret(FcmDeployment.shape.applicationIds)).toBe(false);
  });
});
