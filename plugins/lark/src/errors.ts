import { ChannelSendError, type ChannelSendFailure } from "@capybara-hq/plugin-sdk";
import { LarkApiError, LarkNetworkError } from "./api.js";

/**
 * Lark OpenAPI 错误 → {@link ChannelSendError}。错误码依据（均 2026-10-20 查阅）：
 * - 发送消息：https://open.larksuite.com/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message/create
 * - 回复消息：https://open.larksuite.com/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message/reply
 * - 更新卡片：https://open.larksuite.com/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message/patch
 * - 通用错误码：https://open.larksuite.com/document/ukTMukTMukTM/ugjM14COyUjL4ITN
 * - 频控：https://open.larksuite.com/document/ukTMukTMukTM/uUzN04SN3QjL1cDN
 * 消息里只有错误码与 HTTP 状态，不带凭据。
 */

/** 可重试：频控、平台内部错误、「消息正在发送中」。 */
const RETRYABLE: Record<number, true> = {
  99991400: true, // request trigger frequency limit（HTTP 429，旧接口 400）
  230020: true, // 当前操作触发限频（同一会话 / 同一消息的频控）
  230049: true, // 消息正在发送中，请稍后
  5000: true, // internal error
  4006: true, // service exception
};

const REASONS: Record<number, ChannelSendFailure> = {
  // 凭据失效 / 应用停用 / 权限
  99991661: "auth", // Need a token
  99991663: "auth", // tenant token invalid（已重取一次仍失败）
  99991664: "auth",
  99991665: "auth",
  99991668: "auth",
  99991677: "auth", // token expire
  99991672: "auth", // 未申请相关权限（scope）
  99991673: "auth", // 应用状态不可用
  99991401: "auth", // IP 白名单
  99991543: "auth", // app_id 或 app_secret 不存在
  10005: "auth",
  10013: "auth",
  10014: "auth", // 应用状态不可用 / app id 不存在
  10015: "auth", // app secret 错误
  230006: "auth", // 机器人能力未启用
  230027: "auth", // 缺少必要权限
  // 目标不在了：机器人不在群、群解散、用户不可达
  230002: "target_gone", // 机器人不在对应群组中
  10002: "target_gone", // Bot can NOT be out of the chat
  232009: "target_gone", // 群组已被解散
  230013: "target_gone", // 机器人对用户没有可用性
  230029: "target_gone", // 用户已离职
  230053: "target_gone", // 用户已设置不再接收机器人消息
  230034: "target_gone", // receive_id 不合法
  230035: "target_gone", // 没有发送消息的权限（禁言、被屏蔽）
  230019: "target_gone", // 话题不存在
  // 内容过大
  230025: "too_large", // 消息体长度超出限制（卡片 / 富文本 30 KB）
};

export function toChannelSendError(e: unknown): ChannelSendError {
  if (e instanceof LarkNetworkError) {
    return new ChannelSendError(e.message, { retryable: true, cause: e });
  }
  if (e instanceof LarkApiError) {
    const opts = { cause: e };
    if (e.status === 429 || (e.code !== undefined && RETRYABLE[e.code]) || e.status >= 500) {
      return new ChannelSendError(e.message, {
        retryable: true,
        ...(e.retryAfterMs !== undefined && { retryAfterMs: e.retryAfterMs }),
        ...opts,
      });
    }
    const reason =
      (e.code !== undefined ? REASONS[e.code] : undefined) ??
      (e.status === 401 || e.status === 403 ? "auth" : "rejected");
    return new ChannelSendError(e.message, { retryable: false, reason, ...opts });
  }
  if (e instanceof ChannelSendError) return e;
  return new ChannelSendError("Lark API call failed", { retryable: true, cause: e });
}

/** 校验 / 连接失败的说明（只带步骤与错误码，不带凭据）。 */
export function describeError(e: unknown, what: string): Error {
  // `cause` 只放本插件自己的错误（只带错误码 / HTTP 状态），便于调用方按错误码区分，不会带出凭据
  if (e instanceof LarkApiError) {
    return new Error(
      e.code !== undefined
        ? `Lark ${what} failed: code ${e.code} (HTTP ${e.status})`
        : `Lark ${what} failed: HTTP ${e.status}`,
      { cause: e },
    );
  }
  if (e instanceof LarkNetworkError) {
    return new Error(`Lark ${what} failed: network error`, { cause: e });
  }
  return new Error(`Lark ${what} failed`);
}
