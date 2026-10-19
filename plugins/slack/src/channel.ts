import {
  type Channel,
  ChannelSendError,
  type ChannelTarget,
  type InboundEvent,
  type Logger,
  secret,
} from "@capybara-hq/plugin-sdk";
import { LogLevel, type Logger as SlackLogger, SocketModeClient } from "@slack/socket-mode";
import { type FetchFunction, WebClient } from "@slack/web-api";
import { z } from "zod";
import { parseBlockActions } from "./actions.js";
import { renderSend, renderUpdate } from "./blocks.js";
import { platformErrorCode, toChannelSendError } from "./errors.js";
import { eventToInbound, profileOf, type SlackProfile } from "./inbound.js";

/** 渠道连接配置：应用级令牌（Socket Mode，`connections:write`）与机器人令牌。都走密钥存储。 */
export const SlackConnection = z.object({
  appToken: secret(z.string().regex(/^xapp-/, "must be an app-level token starting with xapp-")),
  botToken: secret(z.string().regex(/^xoxb-/, "must be a bot token starting with xoxb-")),
});
type SlackConnectionConfig = z.infer<typeof SlackConnection>;

export interface SlackChannelOptions {
  /** Web API 根地址（默认 https://slack.com/api/；测试指向假 Slack）。 */
  apiUrl: string;
  log: Logger;
  /** 单次 Web API 请求超时（默认 15 秒）。 */
  requestTimeoutMs?: number;
}

/**
 * 同一条消息两次编辑的最小间隔。chat.update 属 Tier 3（50+ 次/分钟，按工作区计），chat.postMessage 对同一频道
 * 一般每秒 1 条（https://docs.slack.dev/reference/methods/chat.update 、
 * https://docs.slack.dev/reference/methods/chat.postMessage ，2026-10-20 查阅）。流式草稿 1.2 秒一次，
 * 同时有若干会话在流式回复时仍留出余量。
 */
export const MIN_EDIT_INTERVAL_MS = 1200;

/** users.info 结果的进程内缓存：纯性能缓存（不是共享状态），每个渠道实例最多 1000 项、10 分钟过期。 */
const PROFILE_TTL_MS = 10 * 60_000;
const PROFILE_CACHE_MAX = 1000;
/** 查资料的超时：Slack 要求 3 秒内确认事件，资料查不到就不带（https://docs.slack.dev/apis/events-api/ ）。 */
const PROFILE_TIMEOUT_MS = 1500;

/** 可中止的等待（只用于本次连接循环内，随 signal 结束）。 */
const pause = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const s = AbortSignal.any([signal, AbortSignal.timeout(ms)]);
    if (s.aborted) resolve();
    else s.addEventListener("abort", () => resolve(), { once: true });
  });

/** 群聊目标的 thread_ts：threadId 是话题根消息 id（`<频道>:<ts>`），取冒号后的 ts。 */
function threadTsOf(target: ChannelTarget): string | undefined {
  if (target.chatType !== "group" || target.threadId === undefined) return undefined;
  const ts = target.threadId.slice(target.threadId.lastIndexOf(":") + 1);
  return /^\d+\.\d+$/.test(ts) ? ts : undefined;
}

/** 消息 id `<频道>:<ts>` → 频道与 ts。 */
function parseMessageId(id: string): { channel: string; ts: string } {
  const i = id.lastIndexOf(":");
  const channel = id.slice(0, i);
  const ts = id.slice(i + 1);
  if (i <= 0 || !/^\d+\.\d+$/.test(ts)) {
    throw new ChannelSendError("malformed Slack message id", {
      retryable: false,
      reason: "rejected",
    });
  }
  return { channel, ts };
}

/** 连接 / 校验失败的说明（只带错误码，不带凭据）。 */
function describe(e: unknown, what: string): Error {
  const code = platformErrorCode(e);
  if (code !== undefined) return new Error(`Slack ${what} failed: ${code}`);
  const x = e as { code?: unknown; statusCode?: unknown } | undefined;
  if (x?.code === "slack_webapi_http_error") {
    return new Error(`Slack ${what} failed: HTTP ${String(x.statusCode)}`);
  }
  if (x?.code === "slack_webapi_rate_limited_error")
    return new Error(`Slack ${what} failed: ratelimited`);
  if (x?.code === "slack_webapi_request_error")
    return new Error(`Slack ${what} failed: network error`);
  return new Error(`Slack ${what} failed`);
}

interface SocketEnvelope {
  ack: (response?: Record<string, unknown>) => Promise<void>;
  type: string;
  body: unknown;
}

/**
 * Slack `channel@1`：入站走 Socket Mode（`@slack/socket-mode`，显式 ack），出站走 Web API（`@slack/web-api`）。
 *
 * - 确认：每个信封在 `onEvent` resolve 之后才 ack；`onEvent` reject 时不 ack（Slack 重投：立即、约 1 分钟、
 *   约 5 分钟后共 3 次，https://docs.slack.dev/apis/events-api/ ）；忽略的事件直接 ack。
 * - 重连：关闭 SDK 自带的自动重连（其重连路径里 `apps.connections.open` 失败会成为未处理的 Promise 拒绝），
 *   由本循环负责：Slack 回收连接（`disconnect` 消息）或网络断开后重新 `start()`；`start()` 失败抛错，内核记
 *   `last_error` 并退避重试。
 * - 出站：WebClient 不重试、限流直接拒绝，失败映射为 `ChannelSendError`（见 errors.ts），由内核重试。
 *   Slack 的 chat.postMessage 没有幂等参数，`idempotencyKey` 忽略（内核按事件序号续投，不靠平台去重）。
 * - 超长文本拆成多条按序发送，返回最后一条的 id；编辑超长抛 `too_large`。
 */
export function createSlackChannel(opts: SlackChannelOptions): Channel {
  const { apiUrl, log } = opts;
  const timeout = opts.requestTimeoutMs ?? 15_000;
  const slackLogger: SlackLogger = {
    debug() {},
    info: (...m: unknown[]) => log.info(`slack: ${m.map(String).join(" ")}`),
    warn: (...m: unknown[]) => log.warn(`slack: ${m.map(String).join(" ")}`),
    error: (...m: unknown[]) => log.error(`slack: ${m.map(String).join(" ")}`),
    setLevel() {},
    getLevel: () => LogLevel.INFO,
    setName() {},
  };
  const clientOptions = {
    slackApiUrl: apiUrl,
    retryConfig: { retries: 0 },
    rejectRateLimitedCalls: true,
    timeout,
  };
  const web = (token: string, signal?: AbortSignal) => {
    const fetchWithSignal: FetchFunction | undefined = signal
      ? (url, init) =>
          fetch(url, {
            ...init,
            signal: init?.signal ? AbortSignal.any([init.signal, signal]) : signal,
          })
      : undefined;
    return new WebClient(token, {
      ...clientOptions,
      logger: slackLogger,
      ...(fetchWithSignal !== undefined && { fetch: fetchWithSignal }),
    });
  };
  const parse = (config: unknown): SlackConnectionConfig => SlackConnection.parse(config);

  const profiles = new Map<string, { at: number; profile: SlackProfile | undefined }>();
  const lookupProfile = async (
    botToken: string,
    scope: string,
    userId: string,
    signal: AbortSignal,
  ): Promise<SlackProfile | undefined> => {
    const key = `${scope}\u0000${userId}`;
    const hit = profiles.get(key);
    if (hit && Date.now() - hit.at < PROFILE_TTL_MS) return hit.profile;
    let profile: SlackProfile | undefined;
    try {
      const s = AbortSignal.any([signal, AbortSignal.timeout(PROFILE_TIMEOUT_MS)]);
      const r = (await web(botToken, s).apiCall("users.info", { user: userId })) as {
        user?: { name?: string; real_name?: string; profile?: unknown };
      };
      profile =
        profileOf(r.user?.profile) ??
        profileOf({ real_name: r.user?.real_name, name: r.user?.name });
    } catch (e) {
      // 查不到（user_not_found、限流、超时）就不带资料，不耽误确认；不缓存失败
      const code = platformErrorCode(e);
      if (code !== "user_not_found") return undefined;
    }
    profiles.delete(key);
    profiles.set(key, { at: Date.now(), profile });
    if (profiles.size > PROFILE_CACHE_MAX) {
      const oldest = profiles.keys().next().value;
      if (oldest !== undefined) profiles.delete(oldest);
    }
    return profile;
  };

  const withProfile = <S extends { externalId: string; tenantId: string }>(
    sender: S,
    p: SlackProfile | undefined,
  ) => ({
    ...sender,
    ...(p?.displayName !== undefined && { displayName: p.displayName }),
    ...(p?.avatarUrl !== undefined && { avatarUrl: p.avatarUrl }),
  });

  return {
    connectionSchema: SlackConnection,
    features: { cards: true, edit: true, threads: true, minEditIntervalMs: MIN_EDIT_INTERVAL_MS },

    async verify({ config, signal }) {
      const c = parse(config);
      try {
        const r = (await web(c.botToken, signal).apiCall("auth.test")) as {
          user_id?: string;
          user?: string;
          team_id?: string;
        };
        if (!r.user_id || !r.team_id) throw new Error("Slack auth.test returned no bot user");
        return { botUserId: r.user_id, botName: r.user ?? r.user_id, tenantId: r.team_id };
      } catch (e) {
        throw describe(e, "auth.test");
      }
    },

    async connect({ connectionId, config, onEvent, signal }) {
      const c = parse(config);
      let botUserId: string;
      try {
        const r = (await web(c.botToken, signal).apiCall("auth.test")) as { user_id?: string };
        if (!r.user_id) throw new Error("no bot user");
        botUserId = r.user_id;
      } catch (e) {
        if (signal.aborted) return;
        throw describe(e, "auth.test");
      }

      const toEvent = async (type: string, body: unknown): Promise<InboundEvent | null> => {
        if (type === "events_api") {
          const cand = eventToInbound(body, botUserId);
          if (!cand) return null;
          if (cand.kind === "directory") return cand.event;
          const p =
            cand.profile ?? (await lookupProfile(c.botToken, connectionId, cand.userId, signal));
          return { ...cand.event, sender: withProfile(cand.event.sender, p) };
        }
        if (type === "interactive") {
          const a = parseBlockActions(body);
          if (!a) return null;
          const p =
            (await lookupProfile(c.botToken, connectionId, a.sender.externalId, signal)) ??
            (a.username !== undefined ? { displayName: a.username } : undefined);
          return {
            type: "card_action",
            messageId: a.messageId,
            eventId: a.eventId,
            target: a.target,
            sender: withProfile(a.sender, p),
            action: a.action,
          };
        }
        return null;
      };

      const handle = async ({ ack, type, body }: SocketEnvelope) => {
        let event: InboundEvent | null = null;
        try {
          event = await toEvent(type, body);
        } catch (e) {
          log.warn("slack: could not read an event; acknowledging and skipping it", {
            connectionId,
            type,
            error: e instanceof Error ? e.message : String(e),
          });
        }
        if (event) {
          try {
            await onEvent(event);
          } catch (e) {
            log.warn("slack: event not accepted; leaving it unacknowledged so Slack redelivers", {
              connectionId,
              error: e instanceof Error ? e.message : String(e),
            });
            return;
          }
        }
        await ack().catch((e: unknown) => {
          log.warn("slack: acknowledging an event failed; Slack will redeliver it", {
            connectionId,
            error: e instanceof Error ? e.message : String(e),
          });
        });
      };

      const aborted = new Promise<void>((r) => {
        if (signal.aborted) r();
        else signal.addEventListener("abort", () => r(), { once: true });
      });
      while (!signal.aborted) {
        const startedAt = Date.now();
        const client = new SocketModeClient({
          appToken: c.appToken,
          autoReconnectEnabled: false,
          logger: slackLogger,
          clientOptions: { ...clientOptions },
        });
        const closed = new Promise<void>((r) => {
          client.on("disconnected", () => r());
        });
        client.on("slack_event", (env: SocketEnvelope) => {
          void handle(env);
        });
        const stop = () => {
          void client.disconnect().catch(() => {});
        };
        signal.addEventListener("abort", stop, { once: true });
        try {
          try {
            await client.start();
          } catch (e) {
            if (signal.aborted) return;
            await client.disconnect().catch(() => {});
            throw describe(e, "Socket Mode connection");
          }
          // 中止后最多等 3 秒完成关闭握手
          await Promise.race([
            closed,
            aborted.then(() => pause(3000, new AbortController().signal)),
          ]);
        } finally {
          signal.removeEventListener("abort", stop);
          client.removeAllListeners("slack_event");
        }
        if (signal.aborted) return;
        log.info("slack: Socket Mode connection closed; reconnecting", { connectionId });
        // 连接活得太短时稍等再连，避免空转（apps.connections.open 有频率限制）
        await pause(Date.now() - startedAt < 10_000 ? 2000 : 100, signal);
      }
    },

    async send({ config, target, message, signal, locale }) {
      const c = parse(config);
      const client = web(c.botToken, signal);
      const threadTs = threadTsOf(target);
      let last: string | undefined;
      for (const p of renderSend(message, locale)) {
        let r: { channel?: string; ts?: string };
        try {
          r = (await client.apiCall("chat.postMessage", {
            channel: target.chatId,
            text: p.text,
            ...(p.blocks !== undefined && { blocks: p.blocks }),
            ...(threadTs !== undefined && { thread_ts: threadTs }),
          })) as typeof r;
        } catch (e) {
          throw toChannelSendError(e);
        }
        if (!r.ts) throw new ChannelSendError("Slack returned no message ts", { retryable: true });
        last = `${r.channel ?? target.chatId}:${r.ts}`;
      }
      if (last === undefined) throw new ChannelSendError("nothing to send", { retryable: false });
      return { messageId: last };
    },

    async update({ config, messageId, message, signal, locale }) {
      const p = renderUpdate(message, locale);
      const { channel, ts } = parseMessageId(messageId);
      const c = parse(config);
      try {
        await web(c.botToken, signal).apiCall("chat.update", {
          channel,
          ts,
          text: p.text,
          ...(p.blocks !== undefined && { blocks: p.blocks }),
        });
      } catch (e) {
        throw toChannelSendError(e);
      }
    },
  };
}
