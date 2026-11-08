import { describe, expect, it } from "vitest";
import { signV4, xDate } from "../src/sign.js";

/*
 * A fixed vector: computed with the Step 0 probe signer, whose signed ListFoundationModels /
 * ListEndpoints calls Ark accepted live on 2026-11-08, and checked piece by piece here.
 */
const input = {
  method: "POST",
  host: "ark.cn-beijing.volcengineapi.com",
  path: "/",
  // unsorted on purpose: the canonical query sorts it
  query: { Version: "2024-01-01", Action: "ListEndpoints" },
  body: '{"PageNumber":1,"PageSize":100}',
  accessKeyId: "AKLTEXAMPLE",
  secretAccessKey: "c2VjcmV0LWV4YW1wbGU=",
  region: "cn-beijing",
  service: "ark",
  now: new Date("2026-11-08T01:02:03.456Z"),
};
const PAYLOAD = "058d32c09f9efb08808431ec9c1f0868f6306c9d7b8d68e88a18583010150af3";
const SIGNATURE = "978c2a8abf05958ba5919a095a442e8b44fac10336af30af43c7e92bde59ea31";

describe("ark V4 signing", () => {
  it("formats X-Date", () => {
    expect(xDate(input.now)).toBe("20261108T010203Z");
  });

  it("builds the canonical request, string to sign and signature", () => {
    const s = signV4(input);
    expect(s.canonicalRequest).toBe(
      [
        "POST",
        "/",
        "Action=ListEndpoints&Version=2024-01-01",
        "content-type:application/json\nhost:ark.cn-beijing.volcengineapi.com\n" +
          `x-content-sha256:${PAYLOAD}\nx-date:20261108T010203Z\n`,
        "content-type;host;x-content-sha256;x-date",
        PAYLOAD,
      ].join("\n"),
    );
    const lines = s.stringToSign.split("\n");
    expect(lines.slice(0, 3)).toEqual([
      "HMAC-SHA256",
      "20261108T010203Z",
      "20261108/cn-beijing/ark/request",
    ]);
    expect(lines[3]).toMatch(/^[0-9a-f]{64}$/);
    expect(s.signature).toBe(SIGNATURE);
    expect(s.headers).toEqual({
      "content-type": "application/json",
      "x-content-sha256": PAYLOAD,
      "x-date": "20261108T010203Z",
      authorization:
        "HMAC-SHA256 Credential=AKLTEXAMPLE/20261108/cn-beijing/ark/request, " +
        `SignedHeaders=content-type;host;x-content-sha256;x-date, Signature=${SIGNATURE}`,
    });
  });

  it("changes the signature with the body, the region and the secret", () => {
    const base = signV4(input).signature;
    expect(signV4({ ...input, body: "{}" }).signature).not.toBe(base);
    expect(signV4({ ...input, region: "cn-shanghai" }).signature).not.toBe(base);
    expect(signV4({ ...input, secretAccessKey: "other" }).signature).not.toBe(base);
  });

  it("encodes the query per RFC 3986", () => {
    const s = signV4({ ...input, query: { a: "x y!*", B: "1" } });
    expect(s.canonicalRequest.split("\n")[2]).toBe("B=1&a=x%20y%21%2A");
  });
});
