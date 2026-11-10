import { createHash } from "node:crypto";
import {
  type Channel,
  ChannelSendError,
  type ChannelTarget,
  type ExtensionContext,
  type InboundEvent,
  type Logger,
  secret,
  ui,
} from "@capybara-hq/plugin-sdk";
import { LogLevel, type Logger as SlackLogger, SocketModeClient } from "@slack/socket-mode";
import { type FetchFunction, WebClient } from "@slack/web-api";
import { z } from "zod";
import { parseBlockActions } from "./actions.js";
import { renderSend, renderUpdate, type SlackPost } from "./blocks.js";
import {
  ephemeral,
  escapeSlack,
  parseSlashCommand,
  SLASH_REPLIES,
  slashCommandText,
  typedCommand,
} from "./commands.js";
import { workspaceTokenProblem } from "./config.js";
import { blocksRejected, platformErrorCode, toChannelSendError } from "./errors.js";
import { eventToInbound, type SlackProfile, userInfoProfile } from "./inbound.js";
import { handleSlackWebhook, type SlackEnvelope, type SlashOutcome } from "./webhook.js";

/**
 * 渠道连接配置：应用级令牌（Socket Mode，`connections:write`）与机器人令牌。都走密钥存储。
 * `appToken` is optional in the schema because webhook mode doesn't use it; `connect` (Socket Mode)
 * refuses to start without one. `signingSecret` (Basic Information → Signing Secret) is only needed
 * in webhook inbound mode; without it every webhook request is rejected with 401. The
 * `inboundModes` hints tie each to its mode: forms draw and require it only there, and the kernel
 * refuses a connection whose mode lacks it (core channel inbound mode fields spec).
 */
export const SlackConnection = z.object({
  appToken: ui(
    secret(
      z
        .string()
        .regex(/^xapp-/, "must be an app-level token starting with xapp-")
        .optional(),
    ),
    {
      label: { zh: "应用令牌", en: "App-level token" },
      help: {
        zh: "xapp-…，Socket Mode 必填（Basic Information → App-Level Tokens，权限 connections:write）。",
        en: "xapp-…, required for Socket Mode (Basic Information → App-Level Tokens, scope connections:write).",
      },
      placeholder: "xapp-…",
      inboundModes: ["long_connection"],
    },
  ),
  botToken: ui(secret(z.string().regex(/^xoxb-/, "must be a bot token starting with xoxb-")), {
    label: { zh: "机器人令牌", en: "Bot token" },
    help: {
      zh: "xoxb-…（Install App → Bot User OAuth Token）。",
      en: "xoxb-… (Install App → Bot User OAuth Token).",
    },
    placeholder: "xoxb-…",
  }),
  signingSecret: ui(secret(z.string().min(1).optional()), {
    label: { zh: "签名密钥", en: "Signing secret" },
    help: {
      zh: "Basic Information → App Credentials → Signing Secret，用来校验 Slack 发来的每个请求。",
      en: "Basic Information → App Credentials → Signing Secret; every request from Slack is verified with it.",
    },
    inboundModes: ["webhook"],
  }),
});
type SlackConnectionConfig = z.infer<typeof SlackConnection>;

export interface SlackChannelOptions {
  /** Web API 根地址（默认 https://slack.com/api/；测试指向假 Slack）。 */
  apiUrl: string;
  log: Logger;
  /** 单次 Web API 请求超时（默认 15 秒）。 */
  requestTimeoutMs?: number;
  /** 重连退避的基数（默认 1000 毫秒；测试调小）。 */
  reconnectBaseMs?: number;
  /**
   * Plugin kv (`ctx.kv`) for the caches shared by every replica: the per-connection bot user id
   * (webhook mode), the speakers' `users.info` profiles, the bot's DM per user and slash command
   * echoes. Without it nothing is cached (every event calls `users.info`, every webhook event
   * `auth.test`).
   */
  kv?: ExtensionContext["kv"];
}

/** `connect` error for a connection without an app-level token. */
export const SOCKET_MODE_NEEDS_APP_TOKEN =
  "Socket Mode needs an app-level token (xapp-…); set one or switch this connection to webhook mode";

/** TTL of the cached bot user id (webhook mode), in seconds. */
export const BOT_USER_CACHE_TTL_SECONDS = 3600;

/**
 * 同一条消息两次编辑的最小间隔。chat.update 属 Tier 3：约 50 次/分钟、按工作区（同一 app 在该工作区的所有
 * 会话共享）计（https://docs.slack.dev/reference/methods/chat.update 、
 * https://docs.slack.dev/apis/web-api/rate-limits ，2026-10-20 查阅）。一条流式草稿 2.5 秒一次约 24 次/分钟，
 * 两个会话同时流式也不超限；更多并发时由限流（429 → 内核按 Retry-After 退避）兜底。
 */
export const MIN_EDIT_INTERVAL_MS = 2500;

/** 活不到这么久的连接算「短命」；连续这么多次短命就放弃本轮（抛错，内核记 last_error 并退避）。 */
const SHORT_LIVED_MS = 10_000;
const MAX_SHORT_LIVED = 5;
const MAX_RECONNECT_DELAY_MS = 30_000;

/**
 * TTL of a cached `users.info` profile (name, avatar, time zone, language) per team and user, in
 * seconds: a changed name or zone shows within ten minutes.
 */
export const PROFILE_CACHE_TTL_SECONDS = 600;
/**
 * Timeout of the profile lookup: Slack wants events acked within 3 seconds
 * (https://docs.slack.dev/apis/events-api/), so a slow lookup is dropped and the fields left out.
 */
const PROFILE_TIMEOUT_MS = 1500;

/** TTL of the cached bot DM channel per user (the DM channel never changes), in seconds. */
export const BOT_DM_CACHE_TTL_SECONDS = 86_400;
/** TTL of a slash command's echo ts (a Socket Mode redelivery reuses it), in seconds. */
export const COMMAND_ECHO_TTL_SECONDS = 3600;
/** Timeout of the Web API calls made before a slash command is acked (Slack wants it in 3 s). */
const COMMAND_CALL_TIMEOUT_MS = 1500;

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
 *   由本循环负责：Slack 回收连接（`disconnect` 消息）或网络断开后重新 `start()`，连续短命的连接按指数退避
 *   （带抖动）；`start()` 失败、收到 `link_disabled`（应用关闭了 Socket Mode）或连续 5 次短命时抛错（带原因），
 *   内核记 `last_error` 并退避重试。
 * - 出站：WebClient 不重试、限流直接拒绝，失败映射为 `ChannelSendError`（见 errors.ts），由内核重试。
 *   Slack 的 chat.postMessage 没有幂等参数，`idempotencyKey` 忽略（内核按事件序号续投，不靠平台去重）。
 * - 超长文本拆成多条按序发送，返回最后一条的 id；编辑超长抛 `too_large`。
 */
export function createSlackChannel(opts: SlackChannelOptions): Channel {
  const { apiUrl, log } = opts;
  const timeout = opts.requestTimeoutMs ?? 15_000;
  const reconnectBase = opts.reconnectBaseMs ?? 1000;
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

  /**
   * The speaker's profile from `users.info` (`include_locale=true`), cached in kv per team and user
   * for {@link PROFILE_CACHE_TTL_SECONDS} (shared by every replica and connection of the team;
   * nothing in process memory). `user_not_found` is cached as an empty profile; any other failure
   * (rate limit, timeout, kv down) leaves the fields out and caches nothing.
   */
  const lookupProfile = async (
    botToken: string,
    teamId: string,
    userId: string,
    signal: AbortSignal,
  ): Promise<SlackProfile | undefined> => {
    const key = `profile/${teamId}/${userId}`;
    const hit = await opts.kv?.get(key).catch(() => null);
    if (hit) {
      try {
        const cached = JSON.parse(hit) as SlackProfile;
        return Object.keys(cached).length > 0 ? cached : undefined;
      } catch {
        // a malformed entry is looked up again
      }
    }
    let profile: SlackProfile | undefined;
    try {
      const s = AbortSignal.any([signal, AbortSignal.timeout(PROFILE_TIMEOUT_MS)]);
      const r = (await web(botToken, s).apiCall("users.info", {
        user: userId,
        include_locale: true,
      })) as { user?: unknown };
      profile = userInfoProfile(r.user);
    } catch (e) {
      if (platformErrorCode(e) !== "user_not_found") return undefined;
    }
    await opts.kv
      ?.set(key, JSON.stringify(profile ?? {}), { ttlSeconds: PROFILE_CACHE_TTL_SECONDS })
      .catch(() => {});
    return profile;
  };

  const withProfile = <S extends { externalId: string; tenantId: string }>(
    sender: S,
    p: SlackProfile | undefined,
  ) => ({
    ...sender,
    ...(p?.displayName !== undefined && { displayName: p.displayName }),
    ...(p?.avatarUrl !== undefined && { avatarUrl: p.avatarUrl }),
    ...(p?.timeZone !== undefined && { timeZone: p.timeZone }),
    ...(p?.locale !== undefined && { locale: p.locale }),
  });

  /**
   * Socket Mode envelope / webhook payload → inbound event (one parser for both inbound modes, so
   * the same payload yields the same event and dedupe works across a mode switch).
   */
  const toEvent = async (
    c: SlackConnectionConfig,
    botUserId: string,
    { type, body }: SlackEnvelope,
    signal: AbortSignal,
  ): Promise<InboundEvent | null> => {
    if (type === "events_api") {
      const cand = eventToInbound(body, botUserId);
      if (!cand) return null;
      if (cand.kind === "directory") return cand.event;
      // The event's own user_profile wins for the name and avatar; users.info adds the time zone
      // and language it lacks
      const looked = await lookupProfile(
        c.botToken,
        cand.event.sender.tenantId,
        cand.userId,
        signal,
      );
      const p = looked || cand.profile ? { ...looked, ...cand.profile } : undefined;
      return { ...cand.event, sender: withProfile(cand.event.sender, p) };
    }
    const a = parseBlockActions(body);
    if (!a) return null;
    const p =
      (await lookupProfile(c.botToken, a.sender.tenantId, a.sender.externalId, signal)) ??
      (a.username !== undefined ? { displayName: a.username } : undefined);
    return {
      type: "card_action",
      messageId: a.messageId,
      eventId: a.eventId,
      target: a.target,
      sender: withProfile(a.sender, p),
      action: a.action,
    };
  };

  /** kv key of a connection's bot user id; includes a token hash so a new token misses. */
  const botUserKey = (connectionId: string, botToken: string) =>
    `bot-user/${connectionId}/${createHash("sha256").update(botToken).digest("hex").slice(0, 16)}`;
  const rememberBotUser = async (connectionId: string, botToken: string, id: string) => {
    await opts.kv
      ?.set(botUserKey(connectionId, botToken), id, { ttlSeconds: BOT_USER_CACHE_TTL_SECONDS })
      .catch(() => {});
  };
  /** The bot user id from the kv cache, or `auth.test` on a miss (then cached for an hour). */
  const botUserIdOf = async (connectionId: string, botToken: string, signal: AbortSignal) => {
    const hit = await opts.kv?.get(botUserKey(connectionId, botToken)).catch(() => null);
    if (hit) return hit;
    let id: string | undefined;
    try {
      id = ((await web(botToken, signal).apiCall("auth.test")) as { user_id?: string }).user_id;
    } catch (e) {
      throw describe(e, "auth.test");
    }
    if (!id) throw new Error("Slack auth.test returned no bot user");
    await rememberBotUser(connectionId, botToken, id);
    return id;
  };

  /**
   * Whether `channelId` is the bot's own DM with `userId` (a slash command also runs in a DM
   * between two people, where the bot cannot reply). `conversations.open` returns the bot's DM;
   * the answer is cached in kv. When the lookup fails the channel is taken as the bot's DM (a
   * wrong guess only makes the reply fail as `target_gone`).
   */
  const isBotDm = async (
    c: SlackConnectionConfig,
    connectionId: string,
    userId: string,
    channelId: string,
    signal: AbortSignal,
  ): Promise<boolean> => {
    const key = `dm/${connectionId}/${userId}`;
    const hit = await opts.kv?.get(key).catch(() => null);
    if (hit) return hit === channelId;
    try {
      const s = AbortSignal.any([signal, AbortSignal.timeout(COMMAND_CALL_TIMEOUT_MS)]);
      const r = (await web(c.botToken, s).apiCall("conversations.open", { users: userId })) as {
        channel?: { id?: string };
      };
      const id = r.channel?.id;
      if (!id) return true;
      await opts.kv?.set(key, id, { ttlSeconds: BOT_DM_CACHE_TTL_SECONDS }).catch(() => {});
      return id === channelId;
    } catch (e) {
      log.warn("slack: could not look up the bot's DM for a slash command; assuming it is", {
        connectionId,
        error: describe(e, "conversations.open").message,
      });
      return true;
    }
  };

  /**
   * Posts the visible echo of a channel slash command (`<@user>: /capybara foo bar`) and returns
   * its ts: the echo is the thread root the kernel replies under, as for an @-mention. A Socket
   * Mode redelivery of the same command (same `trigger_id`) reuses the cached echo.
   */
  const postEcho = async (
    c: SlackConnectionConfig,
    connectionId: string,
    channelId: string,
    triggerId: string,
    text: string,
    signal: AbortSignal,
  ): Promise<{ ts: string } | { error: string }> => {
    const key = `cmd-echo/${connectionId}/${createHash("sha256").update(triggerId).digest("hex").slice(0, 32)}`;
    const hit = await opts.kv?.get(key).catch(() => null);
    if (hit) return { ts: hit };
    try {
      const s = AbortSignal.any([signal, AbortSignal.timeout(COMMAND_CALL_TIMEOUT_MS)]);
      const r = (await web(c.botToken, s).apiCall("chat.postMessage", {
        channel: channelId,
        text,
      })) as { ts?: string };
      if (!r.ts) return { error: "no_ts" };
      await opts.kv?.set(key, r.ts, { ttlSeconds: COMMAND_ECHO_TTL_SECONDS }).catch(() => {});
      return { ts: r.ts };
    } catch (e) {
      return { error: platformErrorCode(e) ?? "request_failed" };
    }
  };

  /**
   * A slash command payload → the inbound message the kernel gets for the same typed text, plus
   * the ack body. DM (the bot's own): the text as a DM message, acked with an ephemeral echo of the
   * command (Slack shows no slash command in the conversation). Channel: a visible echo is posted
   * first and the event is that message, `mentionsBot: true` (as `@bot /foo bar`), so the reply
   * lands in its thread. Anything that cannot be served gets an ephemeral hint and no event.
   */
  const toCommand = async (
    c: SlackConnectionConfig,
    connectionId: string,
    body: unknown,
    signal: AbortSignal,
  ): Promise<SlashOutcome> => {
    const cmd = parseSlashCommand(body);
    if (!cmd) return { event: null, response: undefined };
    const text = slashCommandText(cmd.command, cmd.text);
    if (text === null) return { event: null, response: ephemeral(SLASH_REPLIES.usage) };
    const profile = lookupProfile(c.botToken, cmd.teamId, cmd.userId, signal).then(
      (p) => p ?? (cmd.userName !== undefined ? { displayName: cmd.userName } : undefined),
    );
    const sender = { externalId: cmd.userId, tenantId: cmd.teamId };
    if (cmd.channelId.startsWith("D")) {
      const [own, p] = await Promise.all([
        isBotDm(c, connectionId, cmd.userId, cmd.channelId, signal),
        profile,
      ]);
      if (!own) return { event: null, response: ephemeral(SLASH_REPLIES.wrongDm) };
      return {
        event: {
          type: "message",
          messageId: `${cmd.channelId}:cmd-${cmd.triggerId}`,
          target: { chatId: cmd.channelId, chatType: "dm" },
          sender: withProfile(sender, p),
          text,
          mentionsBot: false,
        },
        response: ephemeral(escapeSlack(typedCommand(cmd))),
      };
    }
    const echoText = `<@${cmd.userId}>: ${escapeSlack(typedCommand(cmd))}`;
    const [echo, p] = await Promise.all([
      postEcho(c, connectionId, cmd.channelId, cmd.triggerId, echoText, signal),
      profile,
    ]);
    if ("error" in echo) {
      const gone = ["not_in_channel", "channel_not_found", "is_archived"].includes(echo.error);
      if (!gone) {
        log.warn("slack: could not post a slash command's echo", {
          connectionId,
          error: echo.error,
        });
      }
      return {
        event: null,
        response: ephemeral(gone ? SLASH_REPLIES.notInChannel : SLASH_REPLIES.failed),
      };
    }
    return {
      event: {
        type: "message",
        messageId: `${cmd.channelId}:${echo.ts}`,
        target: { chatId: cmd.channelId, chatType: "group" },
        sender: withProfile(sender, p),
        text,
        mentionsBot: true,
      },
      response: undefined,
    };
  };

  return {
    connectionSchema: SlackConnection,
    features: { cards: true, edit: true, threads: true, minEditIntervalMs: MIN_EDIT_INTERVAL_MS },

    async verify({ config, signal }) {
      const c = parse(config);
      let r: { user_id?: string; user?: string; team_id?: string; is_enterprise_install?: boolean };
      try {
        r = (await web(c.botToken, signal).apiCall("auth.test")) as typeof r;
      } catch (e) {
        throw describe(e, "auth.test");
      }
      if (!r.user_id || !r.team_id) throw new Error("Slack auth.test returned no bot user");
      // 租户是工作区（Ruling A26）：组织级安装或企业 id 的令牌拒绝（与通讯录同一文案）
      const problem = workspaceTokenProblem(r);
      if (problem !== undefined) throw new Error(problem);
      return { botUserId: r.user_id, botName: r.user ?? r.user_id, tenantId: r.team_id };
    },

    async connect({ connectionId, config, onEvent, signal }) {
      const c = parse(config);
      // A plain Error: the supervisor records it as last_error and backs off
      if (c.appToken === undefined) throw new Error(SOCKET_MODE_NEEDS_APP_TOKEN);
      const appToken = c.appToken;
      let botUserId: string;
      try {
        const r = (await web(c.botToken, signal).apiCall("auth.test")) as { user_id?: string };
        if (!r.user_id) throw new Error("no bot user");
        botUserId = r.user_id;
      } catch (e) {
        if (signal.aborted) return;
        throw describe(e, "auth.test");
      }
      await rememberBotUser(connectionId, c.botToken, botUserId);

      const handle = async ({ ack, type, body }: SocketEnvelope) => {
        let event: InboundEvent | null = null;
        let response: Record<string, unknown> | undefined;
        try {
          if (type === "events_api" || type === "interactive") {
            event = await toEvent(c, botUserId, { type, body }, signal);
          } else if (type === "slash_commands") {
            ({ event, response } = await toCommand(c, connectionId, body, signal));
          }
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
        await ack(response).catch((e: unknown) => {
          log.warn("slack: acknowledging an event failed; Slack will redeliver it", {
            connectionId,
            error: e instanceof Error ? e.message : String(e),
          });
        });
      };

      // 中止后最多等 3 秒完成关闭握手（只建一次，不随每轮重连累积计时器）
      const abortedGrace = new Promise<void>((r) => {
        if (signal.aborted) r();
        else signal.addEventListener("abort", () => r(), { once: true });
      }).then(() => pause(3000, new AbortController().signal));
      let shortLived = 0;
      while (!signal.aborted) {
        const startedAt = Date.now();
        let disconnectReason: string | undefined;
        const client = new SocketModeClient({
          appToken,
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
        // Slack 的 disconnect 消息（refresh_requested / warning / link_disabled）SDK 不转发，自己从原始帧里读原因
        client.on("ws_message", (data: unknown) => {
          if (typeof data !== "string" || !data.includes('"disconnect"')) return;
          try {
            const m = JSON.parse(data) as { type?: unknown; reason?: unknown };
            if (m.type === "disconnect" && typeof m.reason === "string")
              disconnectReason = m.reason;
          } catch {
            // 不是 JSON：SDK 自己会忽略
          }
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
          // 中止发生在 apps.connections.open 进行中时，stop() 当时还没有 socket 可关：这里补关
          if (signal.aborted) {
            await Promise.race([client.disconnect().catch(() => {}), abortedGrace]);
            return;
          }
          await Promise.race([closed, abortedGrace]);
        } finally {
          signal.removeEventListener("abort", stop);
          client.removeAllListeners("slack_event");
          client.removeAllListeners("ws_message");
        }
        if (signal.aborted) return;
        if (disconnectReason === "link_disabled") {
          throw new Error(
            "Slack closed the Socket Mode connection: link_disabled (Socket Mode is off)",
          );
        }
        shortLived = Date.now() - startedAt < SHORT_LIVED_MS ? shortLived + 1 : 0;
        if (shortLived >= MAX_SHORT_LIVED) {
          throw new Error(
            `Slack Socket Mode connection keeps closing (${shortLived} times within ` +
              `${SHORT_LIVED_MS / 1000}s each${disconnectReason ? `, last reason ${disconnectReason}` : ""})`,
          );
        }
        log.info("slack: Socket Mode connection closed; reconnecting", {
          connectionId,
          reason: disconnectReason ?? "closed",
        });
        // 正常回收（活得够久）立即重连；短命的按 base·2^(n-1) 指数退避，乘 0.5–1 的抖动
        const delay =
          shortLived === 0
            ? 0
            : Math.min(MAX_RECONNECT_DELAY_MS, reconnectBase * 2 ** (shortLived - 1)) *
              (0.5 + Math.random() / 2);
        if (delay > 0) await pause(Math.round(delay), signal);
      }
    },

    webhook: {
      async handle({ connectionId, config, request, signal }) {
        const c = parse(config);
        return handleSlackWebhook({
          config: c,
          request,
          botUserId: () => botUserIdOf(connectionId, c.botToken, signal),
          command: async (body) => {
            try {
              return await toCommand(c, connectionId, body, signal);
            } catch (e) {
              log.warn("slack: could not read a webhook slash command; skipping it", {
                connectionId,
                error: e instanceof Error ? e.message : String(e),
              });
              return { event: null, response: ephemeral(SLASH_REPLIES.failed) };
            }
          },
          toEvent: async (envelope, botUserId) => {
            try {
              return await toEvent(c, botUserId, envelope, signal);
            } catch (e) {
              log.warn("slack: could not read a webhook event; acknowledging and skipping it", {
                connectionId,
                type: envelope.type,
                error: e instanceof Error ? e.message : String(e),
              });
              return null;
            }
          },
        });
      },
    },

    // Ruling R5: chat.postMessage has no idempotency parameter, so `idempotencyKey` is ignored. If a
    // replica dies between this send and the kernel's advance, the resend after recovery shows a
    // second copy of the card; a decision made on the first copy is not reflected back onto it.
    async send({ config, target, message, signal, locale }) {
      const c = parse(config);
      const client = web(c.botToken, signal);
      const threadTs = threadTsOf(target);
      let last: string | undefined;
      const post = async (p: SlackPost) => {
        try {
          return (await client.apiCall("chat.postMessage", {
            channel: target.chatId,
            text: p.text,
            ...(p.blocks !== undefined && { blocks: p.blocks }),
            ...(threadTs !== undefined && { thread_ts: threadTs }),
          })) as { channel?: string; ts?: string };
        } catch (e) {
          throw toChannelSendError(e);
        }
      };
      for (const p of renderSend(message, locale)) {
        const sent: { channel?: string; ts?: string }[] = [];
        try {
          sent.push(await post(p));
        } catch (e) {
          if (!p.fallback || !blocksRejected(e)) throw e;
          log.warn("slack: Slack rejected a table block; the table is sent as a list", {
            error: e instanceof Error ? e.message : String(e),
          });
          for (const f of p.fallback) sent.push(await post(f));
        }
        for (const r of sent) {
          if (!r.ts) {
            throw new ChannelSendError("Slack returned no message ts", {
              retryable: false,
              reason: "rejected",
            });
          }
          last = `${r.channel ?? target.chatId}:${r.ts}`;
        }
      }
      if (last === undefined) throw new ChannelSendError("nothing to send", { retryable: false });
      return { messageId: last };
    },

    async update({ config, messageId, message, signal, locale }) {
      const p = renderUpdate(message, locale);
      const { channel, ts } = parseMessageId(messageId);
      const c = parse(config);
      const edit = async (q: SlackPost) => {
        try {
          await web(c.botToken, signal).apiCall("chat.update", {
            channel,
            ts,
            text: q.text,
            ...(q.blocks !== undefined && { blocks: q.blocks }),
          });
        } catch (e) {
          throw toChannelSendError(e);
        }
      };
      try {
        await edit(p);
      } catch (e) {
        if (!p.fallback || !blocksRejected(e)) throw e;
        const only = p.fallback.length === 1 ? p.fallback[0] : undefined;
        if (!only) {
          throw new ChannelSendError("message too long for a single Slack message", {
            retryable: false,
            reason: "too_large",
          });
        }
        log.warn("slack: Slack rejected a table block; the table is sent as a list", {
          error: e instanceof Error ? e.message : String(e),
        });
        await edit(only);
      }
    },
  };
}
