import { describe, expect, it } from "vitest";
import { createS3ObjectStore, type S3StoreConfig } from "../src/index.js";

describe("uri", () => {
  const config: S3StoreConfig = {
    endpoint: "http://127.0.0.1:8333",
    region: "us-east-1",
    bucket: "capybara",
    accessKeyId: "k",
    secretAccessKey: "s",
    forcePathStyle: true,
  };

  it("names the object it holds, unsigned and stable", () => {
    const store = createS3ObjectStore(config);
    expect(store.uri?.("kernel/org-1/attachments/abc")).toBe(
      "s3://capybara/kernel/org-1/attachments/abc",
    );
    // no credentials, no signature, no public endpoint: a plain object identifier
    expect(store.uri?.("kernel/org-1/attachments/abc")).not.toContain("?");
  });

  it("follows the configured bucket", () => {
    const store = createS3ObjectStore({ ...config, bucket: "other" });
    expect(store.uri?.("deployment/logo.svg")).toBe("s3://other/deployment/logo.svg");
  });
});
