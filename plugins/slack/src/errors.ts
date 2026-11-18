import { ChannelSendError, type ChannelSendFailure } from "@capybara-hq/plugin-sdk";

/**
 * `@slack/web-api` 的错误 → {@link ChannelSendError}。按 `code` 鸭子类型判断（不用 instanceof）。
 * WebClient 建成「不重试、限流直接拒绝」（`retryConfig.retries = 0`、`rejectRateLimitedCalls`），重试由内核做。
 * 平台错误码见 https://docs.slack.dev/reference/methods/chat.postMessage 与
 * https://docs.slack.dev/reference/methods/chat.update （2026-10-20 查阅）。消息里只有错误码，不带凭据。
 */

const RETRYABLE: Record<string, true> = {
  ratelimited: true,
  rate_limited: true,
  internal_error: true,
  fatal_error: true,
  service_unavailable: true,
  request_timeout: true,
};

const REASONS: Record<string, ChannelSendFailure> = {
  invalid_auth: "auth",
  not_authed: "auth",
  token_revoked: "auth",
  token_expired: "auth",
  account_inactive: "auth",
  missing_scope: "auth",
  ekm_access_denied: "auth",
  channel_not_found: "target_gone",
  not_in_channel: "target_gone",
  is_archived: "target_gone",
  is_inactive: "target_gone",
  msg_too_long: "too_large",
  msg_blocks_too_long: "too_large",
};

interface SlackLikeError {
  code?: unknown;
  data?: { error?: unknown };
  statusCode?: unknown;
  retryAfter?: unknown;
}

/** Slack 平台错误码（`ok: false` 的 `error`）；不是平台错误返回 undefined。 */
export function platformErrorCode(e: unknown): string | undefined {
  const x = e as SlackLikeError | null;
  if (x?.code !== "slack_webapi_platform_error") return undefined;
  return typeof x.data?.error === "string" ? x.data.error : "unknown_error";
}

export function toChannelSendError(e: unknown): ChannelSendError {
  const x = (typeof e === "object" && e !== null ? e : {}) as SlackLikeError;
  switch (x.code) {
    case "slack_webapi_rate_limited_error": {
      const sec = typeof x.retryAfter === "number" ? x.retryAfter : undefined;
      return new ChannelSendError("Slack API rate limited", {
        retryable: true,
        ...(sec !== undefined && { retryAfterMs: sec * 1000 }),
        cause: e,
      });
    }
    case "slack_webapi_platform_error": {
      const code = platformErrorCode(e) ?? "unknown_error";
      const message = `Slack API error: ${code}`;
      if (RETRYABLE[code]) return new ChannelSendError(message, { retryable: true, cause: e });
      return new ChannelSendError(message, {
        retryable: false,
        reason: REASONS[code] ?? "rejected",
        cause: e,
      });
    }
    case "slack_webapi_http_error": {
      const status = typeof x.statusCode === "number" ? x.statusCode : 0;
      const message = `Slack API returned HTTP ${status}`;
      if (status === 429 || status >= 500) {
        return new ChannelSendError(message, { retryable: true, cause: e });
      }
      return new ChannelSendError(message, { retryable: false, reason: "rejected", cause: e });
    }
    case "slack_webapi_request_error":
      return new ChannelSendError("Slack API request failed (network)", {
        retryable: true,
        cause: e,
      });
    default:
      return new ChannelSendError("Slack API call failed", { retryable: true, cause: e });
  }
}

/** Scope and token-type errors that only mean "this app may not upload files". */
const UPLOAD_PERMISSION: Record<string, true> = {
  missing_scope: true,
  not_allowed_token_type: true,
};

/**
 * The mapping for the Web API calls of a file upload (`files.getUploadURLExternal`,
 * `files.completeUploadExternal`; the upload POST itself: {@link uploadStatusError}): the general
 * table, except that a missing `files:write` (or a token type that may not upload) is `rejected`,
 * never `auth`. `auth` would stop the
 * conversation's whole delivery, text included; `rejected` only turns this file into a link.
 */
export function toUploadSendError(e: unknown): ChannelSendError {
  const code = platformErrorCode(e);
  if (code !== undefined && UPLOAD_PERMISSION[code]) {
    return new ChannelSendError(`Slack API error: ${code}`, {
      retryable: false,
      reason: "rejected",
      cause: e,
    });
  }
  return toChannelSendError(e);
}

/**
 * A failed POST to the signed upload URL. The URL is a credential: neither the message nor a
 * `cause` carries it (or the response body), only the HTTP status.
 */
export function uploadStatusError(status: number): ChannelSendError {
  const message = `files upload failed with status ${status}`;
  if (status === 429 || status >= 500) return new ChannelSendError(message, { retryable: true });
  return new ChannelSendError(message, {
    retryable: false,
    reason: status === 413 ? "too_large" : "rejected",
  });
}

/**
 * True when a send failed because Slack refused the message's blocks or attachments
 * (`invalid_blocks`, `invalid_blocks_format`, `invalid_attachments`, e.g. a table block it does not
 * accept): the message can still go out as text.
 */
export function blocksRejected(e: unknown): boolean {
  const cause = e instanceof ChannelSendError ? e.cause : e;
  const code = platformErrorCode(cause);
  return (
    code === "invalid_blocks" || code === "invalid_blocks_format" || code === "invalid_attachments"
  );
}
