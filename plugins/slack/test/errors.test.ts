import { describe, expect, it } from "vitest";
import { toChannelSendError, toUploadSendError, uploadStatusError } from "../src/errors.js";

const platform = (error: string) =>
  Object.assign(new Error(`An API error occurred: ${error}`), {
    code: "slack_webapi_platform_error",
    data: { ok: false, error },
  });

describe("toChannelSendError", () => {
  it("rate limited (HTTP 429 with Retry-After) → retryable with retryAfterMs", () => {
    const e = toChannelSendError(
      Object.assign(new Error("rate limited"), {
        code: "slack_webapi_rate_limited_error",
        retryAfter: 7,
      }),
    );
    expect(e).toMatchObject({ name: "ChannelSendError", retryable: true, retryAfterMs: 7000 });
  });

  it("platform error ratelimited / internal errors → retryable", () => {
    for (const code of [
      "ratelimited",
      "internal_error",
      "fatal_error",
      "service_unavailable",
      "request_timeout",
    ]) {
      expect(toChannelSendError(platform(code))).toMatchObject({ retryable: true });
    }
  });

  it("HTTP 5xx and network errors → retryable; other HTTP → rejected", () => {
    const http = (statusCode: number) =>
      Object.assign(new Error("http"), { code: "slack_webapi_http_error", statusCode });
    expect(toChannelSendError(http(503))).toMatchObject({ retryable: true });
    expect(toChannelSendError(http(400))).toMatchObject({ retryable: false, reason: "rejected" });
    expect(
      toChannelSendError(
        Object.assign(new Error("ECONNRESET"), { code: "slack_webapi_request_error" }),
      ),
    ).toMatchObject({ retryable: true });
  });

  it("auth failures → reason auth", () => {
    for (const code of [
      "invalid_auth",
      "token_revoked",
      "account_inactive",
      "not_authed",
      "token_expired",
      "missing_scope",
    ]) {
      expect(toChannelSendError(platform(code))).toMatchObject({
        retryable: false,
        reason: "auth",
      });
    }
  });

  it("gone targets → reason target_gone", () => {
    for (const code of ["channel_not_found", "not_in_channel", "is_archived", "is_inactive"]) {
      expect(toChannelSendError(platform(code))).toMatchObject({
        retryable: false,
        reason: "target_gone",
      });
    }
  });

  it("too long → reason too_large", () => {
    for (const code of ["msg_too_long", "msg_blocks_too_long"]) {
      expect(toChannelSendError(platform(code))).toMatchObject({
        retryable: false,
        reason: "too_large",
      });
    }
  });

  it("anything else → rejected; the message never carries tokens", () => {
    const e = toChannelSendError(platform("invalid_blocks"));
    expect(e).toMatchObject({ retryable: false, reason: "rejected" });
    expect(e.message).toBe("Slack API error: invalid_blocks");
    const u = toChannelSendError(new Error("boom xoxb-123"));
    expect(u).toMatchObject({ retryable: true });
    expect(u.message).not.toContain("xoxb");
  });
});

describe("toUploadSendError", () => {
  it("missing_scope / not_allowed_token_type → rejected (text sends keep auth for missing_scope)", () => {
    for (const code of ["missing_scope", "not_allowed_token_type"]) {
      expect(toUploadSendError(platform(code))).toMatchObject({
        retryable: false,
        reason: "rejected",
        message: `Slack API error: ${code}`,
      });
    }
    expect(toChannelSendError(platform("missing_scope"))).toMatchObject({ reason: "auth" });
    expect(toUploadSendError(platform("invalid_auth"))).toMatchObject({ reason: "auth" });
    expect(toUploadSendError(platform("internal_error"))).toMatchObject({ retryable: true });
  });
});

describe("uploadStatusError", () => {
  it("5xx / 429 retryable, 413 too_large, other statuses rejected; the message names only the status", () => {
    expect(uploadStatusError(502)).toMatchObject({ retryable: true });
    expect(uploadStatusError(429)).toMatchObject({ retryable: true });
    expect(uploadStatusError(429, "4")).toMatchObject({ retryable: true, retryAfterMs: 4000 });
    expect(uploadStatusError(429, "soon").retryAfterMs).toBeUndefined();
    expect(uploadStatusError(413)).toMatchObject({ retryable: false, reason: "too_large" });
    expect(uploadStatusError(403)).toMatchObject({ retryable: false, reason: "rejected" });
    expect(uploadStatusError(403).message).toBe("files upload failed with status 403");
    expect(uploadStatusError(403).cause).toBeUndefined();
  });
});
