import { describe, expect, it } from "vitest";
import { LarkApiError, LarkNetworkError } from "../src/api.js";
import { describeError, toChannelSendError } from "../src/errors.js";

const api = (status: number, code?: number, retryAfterMs?: number) =>
  new LarkApiError({
    status,
    ...(code !== undefined && { code }),
    ...(retryAfterMs !== undefined && { retryAfterMs }),
  });

describe("toChannelSendError", () => {
  it("rate limits are retryable with the reset hint", () => {
    const e = toChannelSendError(api(429, 99991400, 52_000));
    expect(e).toMatchObject({ retryable: true, retryAfterMs: 52_000 });
    expect(toChannelSendError(api(400, 99991400))).toMatchObject({ retryable: true });
    expect(toChannelSendError(api(400, 230020))).toMatchObject({ retryable: true });
  });

  it("network errors, 5xx and transient platform codes are retryable", () => {
    expect(toChannelSendError(new LarkNetworkError("timeout"))).toMatchObject({ retryable: true });
    expect(toChannelSendError(api(503))).toMatchObject({ retryable: true });
    expect(toChannelSendError(api(500, 5000))).toMatchObject({ retryable: true });
    expect(toChannelSendError(api(400, 230049))).toMatchObject({ retryable: true });
    expect(toChannelSendError(new Error("weird"))).toMatchObject({ retryable: true });
  });

  it("auth / app disabled / missing scope → auth", () => {
    for (const code of [
      99991663, 99991665, 99991677, 99991672, 99991673, 99991401, 10014, 10015, 230006, 230027,
    ]) {
      expect(toChannelSendError(api(400, code)), String(code)).toMatchObject({
        retryable: false,
        reason: "auth",
      });
    }
    expect(toChannelSendError(api(401))).toMatchObject({ retryable: false, reason: "auth" });
    expect(toChannelSendError(api(403))).toMatchObject({ retryable: false, reason: "auth" });
  });

  it("bot not in chat / chat gone / user unreachable → target_gone", () => {
    for (const code of [230002, 10002, 232009, 230013, 230029, 230053, 230034, 230035, 230019]) {
      expect(toChannelSendError(api(400, code)), String(code)).toMatchObject({
        retryable: false,
        reason: "target_gone",
      });
    }
  });

  it("content too long → too_large; everything else → rejected", () => {
    expect(toChannelSendError(api(400, 230025))).toMatchObject({
      retryable: false,
      reason: "too_large",
    });
    for (const code of [230001, 230099, 230022, 230028, 230031, 230011, 230072, 9499]) {
      expect(toChannelSendError(api(400, code)), String(code)).toMatchObject({
        retryable: false,
        reason: "rejected",
      });
    }
  });

  it("messages carry only codes", () => {
    const e = toChannelSendError(api(400, 230002));
    expect(e.message).toBe("Lark API error 230002 (HTTP 400)");
    expect(e.name).toBe("ChannelSendError");
  });
});

describe("describeError", () => {
  it("names the step and the code, nothing else", () => {
    expect(describeError(api(200, 10014), "tenant token").message).toBe(
      "Lark tenant token failed: code 10014 (HTTP 200)",
    );
    expect(describeError(new LarkNetworkError("ECONNREFUSED 1.2.3.4"), "bot info").message).toBe(
      "Lark bot info failed: network error",
    );
    expect(describeError(new Error("secret in here"), "x").message).toBe("Lark x failed");
  });
});
