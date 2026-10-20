import {
  type Channel,
  ChannelSendError,
  type ChannelTarget,
  type InboundEvent,
  type Logger,
  secret,
} from "@capybara-hq/plugin-sdk";
import {
  type EventDispatcher,
  type HttpInstance,
  LoggerLevel,
  WSClient,
} from "@larksuiteoapi/node-sdk";
import { z } from "zod";
import { type ChatKind, parseCardAction } from "./actions.js";
import { createLarkApi, type LarkCredentials } from "./api.js";
import { checkSize, renderSend, renderUpdate } from "./cards.js";
import { describeError, toChannelSendError } from "./errors.js";
import { eventToInbound } from "./inbound.js";

/**
 * 渠道连接配置：自建应用的 App ID 与 App Secret（开发者后台「凭证与基础信息」）。Secret 走密钥存储。
 * App ID 的格式按 SDK `WSClient.start()` 的校验（`cli_` + 16 位十六进制；不符时它只打日志、什么也不做）。
 */
export const LarkConnection = z.object({
  appId: z
    .string()
    .regex(/^cli_[0-9a-fA-F]{16}$/, "must be a Lark App ID such as cli_a1b2c3d4e5f60718"),
  appSecret: secret(z.string().min(1)),
});
type LarkConnectionConfig = z.infer<typeof LarkConnection>;

export interface LarkChannelOptions {
  /** 开放平台根地址（默认 https://open.larksuite.com；测试指向假 Lark）。 */
  apiUrl: string;
  log: Logger;
  /** 单次 OpenAPI 请求超时（默认 15 秒）。 */
  requestTimeoutMs?: number;
  /** 重连退避的基数（默认 1000 毫秒；测试调小）。 */
  reconnectBaseMs?: number;
  /** 检查长连接是否仍然连着的间隔（默认 1000 毫秒；测试调小）。 */
  statusPollMs?: number;
  /** 等待一次连接建立（取接入点 + 握手）的上限（默认 30 秒）。 */
  connectTimeoutMs?: number;
}

/**
 * 同一条消息两次编辑的最小间隔。更新卡片（PATCH）的频控：单条消息 5 QPS，接口整体每应用每租户
 * 1000 次/分钟、50 次/秒（https://open.larksuite.com/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message/patch 、
 * https://open.larksuite.com/document/ukTMukTMukTM/uUzN04SN3QjL1cDN ，2026-10-20 查阅）。真正的约束是整体的
 * 1000 次/分钟：一条流式草稿 1.5 秒一次约 40 次/分钟，约 25 个会话同时流式也不超限；更多并发时由限流
 * （99991400 → 内核按 `x-ogw-ratelimit-reset` 退避）兜底。PATCH 没有每条消息的总次数上限（文本消息的
 * 「编辑消息」才有 20 次上限，本插件不用它）；若某次更新被拒（如超过 14 天 230031、消息已撤回 230011），
 * 映射为不可重试的 `rejected`，内核改为把完整文本作为新消息发送。
 */
export const MIN_EDIT_INTERVAL_MS = 1500;

/** 活不到这么久的连接算「短命」；连续这么多次失败 / 短命就放弃本轮（抛错，内核记 last_error 并退避）。 */
const SHORT_LIVED_MS = 10_000;
const MAX_FAILURES = 5;
const MAX_RECONNECT_DELAY_MS = 30_000;

/** 用户资料的进程内缓存：纯性能缓存（不是共享状态），每个渠道实例最多 1000 项、10 分钟过期。 */
const PROFILE_TTL_MS = 10 * 60_000;
const PROFILE_CACHE_MAX = 1000;
/**
 * 查资料的超时：长连接要求 3 秒内处理完（卡片回调同样 3 秒内响应），资料查不到就不带
 * （https://open.larksuite.com/document/ukTMukTMukTM/uYDNxYjL2QTM24iN0EjN/event-subscription-configure-/use-websocket ）。
 */
const PROFILE_TIMEOUT_MS = 1000;

interface Profile {
  displayName?: string;
  avatarUrl?: string;
}

/**
 * 可中止的等待（只用于本次连接循环内，随 signal 结束）。插件不能用 setTimeout（`pnpm check:plugin-state` 的
 * plugin-timer 规则），所以用 `AbortSignal.timeout` 计时；不建 `AbortSignal.any` 组合信号（每秒一次的状态轮询会
 * 不断在 signal 上挂依赖），两个监听都在结束时摘掉。
 */
const pause = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const timer = AbortSignal.timeout(ms);
    const done = () => {
      signal.removeEventListener("abort", done);
      timer.removeEventListener("abort", done);
      resolve();
    };
    signal.addEventListener("abort", done, { once: true });
    timer.addEventListener("abort", done, { once: true });
  });

const MESSAGE_ID = /^om_[A-Za-z0-9_-]+$/;
const chatKind = (t: ChannelTarget): ChatKind => (t.chatType === "dm" ? "d" : "g");
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * 给 SDK `WSClient` 取长连接接入点用的 HTTP 实现（代替它默认的 axios：带上本轮连接的 AbortSignal，错误里
 * 不带请求体——请求体里有 AppSecret）。`WSClient` 只用 `request`，按 axios 拦截器的约定返回响应体。
 */
function wsHttp(signal: AbortSignal): HttpInstance {
  const request = async (o: {
    url?: string;
    method?: string;
    data?: unknown;
    headers?: Record<string, unknown>;
    timeout?: number;
  }) => {
    const s = AbortSignal.any([signal, AbortSignal.timeout(o.timeout ?? 15_000)]);
    const headers: Record<string, string> = { "content-type": "application/json; charset=utf-8" };
    for (const [k, v] of Object.entries(o.headers ?? {})) if (typeof v === "string") headers[k] = v;
    const res = await fetch(o.url ?? "", {
      method: (o.method ?? "GET").toUpperCase(),
      headers,
      ...(o.data !== undefined && { body: JSON.stringify(o.data) }),
      signal: s,
      redirect: "error",
    });
    const body: unknown = await res.json().catch(() => undefined);
    if (body === undefined) throw new Error(`endpoint returned HTTP ${res.status}`);
    return body;
  };
  const via =
    (method: string) =>
    (url: string, ...rest: unknown[]) =>
      request({ url, method, ...(rest[0] !== undefined && { data: rest[0] }) });
  return {
    request,
    get: via("GET"),
    delete: via("DELETE"),
    head: via("HEAD"),
    options: via("OPTIONS"),
    post: via("POST"),
    put: via("PUT"),
    patch: via("PATCH"),
  } as unknown as HttpInstance;
}

/**
 * Lark `channel@1`：入站走长连接（官方 SDK `WSClient`），出站走 OpenAPI（见 api.ts）。
 *
 * 长连接（https://open.larksuite.com/document/ukTMukTMukTM/uYDNxYjL2QTM24iN0EjN/event-subscription-configure-/use-websocket 、
 * 卡片回调 https://open.larksuite.com/document/uAjLw4CM/ukTMukTMukTM/event-subscription-guide/callback-subscription/configure-callback-request-address ，
 * 2026-10-20 查阅）：仅企业自建应用；每应用最多 50 条连接；推送为集群模式（多个客户端时只有随机一个收到）；
 * 收到消息后须在 3 秒内处理完「且不抛出异常，否则会触发超时重推」。新版卡片回调 `card.action.trigger`
 * 也走长连接（旧版卡片回调不支持）。
 *
 * - 确认：SDK 在事件处理函数返回后自动回一个响应帧——resolve 回 `code: 200`（返回值作为回调响应的 `data`），
 *   throw 回 `code: 500`。所以处理函数 `await onEvent(…)`：resolve 后才返回（= 确认）；reject 时**重新抛出**，
 *   SDK 回 500，Lark 视为处理失败并重推（不会有 200）。忽略的事件直接返回（= 确认）。
 * - 卡片回调：同一机制，返回 undefined（空响应 = 卡片保持不变）；卡片之后由内核经 `update`（PATCH）更新。
 * - 重连：SDK 的自动重连按服务端下发的间隔（默认 2 分钟量级）静默重试，重试失败不会回到调用方，取接入点
 *   回「internal error」（如 App ID 不存在时真实返回 1000040343）时还会无限重试。所以关闭 SDK 自动重连
 *   （`autoReconnect: false`），由本循环负责：连上后每 `statusPollMs` 查一次连接状态，断开就关闭该客户端、
 *   重新建一个；连接前先取 tenant token 与机器人信息，凭据错误立即抛错（不进入重连）。连接失败或连续短命按指数
 *   退避（带抖动），连续 5 次、或接入点明确拒绝（如超过连接数上限 1000040350）时抛错（带原因，不带凭据），
 *   内核记 `last_error` 并退避。ping 与存活检测仍由 SDK 管（`pingTimeout` 30 秒）。
 * - 出站：失败映射为 `ChannelSendError`（见 errors.ts），由内核重试。`idempotencyKey` 原样作为 Lark 的 `uuid`
 *   （1 小时内同一 uuid 至多发出一条）；拆成多条时第 i 条（i ≥ 1）用 `<key>-<i>`（不超过 50 字符）。
 * - 群聊话题：带 `threadId`（根消息 id）时用「回复消息」并 `reply_in_thread: true`，回复进以该消息为根的话题；
 *   私聊与没有话题的群聊直接发到会话。
 */
export function createLarkChannel(opts: LarkChannelOptions): Channel {
  const { log } = opts;
  const api = createLarkApi({ baseUrl: opts.apiUrl, timeoutMs: opts.requestTimeoutMs ?? 15_000 });
  const domain = opts.apiUrl.replace(/\/+$/, "");
  const reconnectBase = opts.reconnectBaseMs ?? 1000;
  const statusPoll = opts.statusPollMs ?? 1000;
  const connectTimeout = opts.connectTimeoutMs ?? 30_000;
  const parse = (config: unknown): LarkConnectionConfig => LarkConnection.parse(config);
  const creds = (c: LarkConnectionConfig): LarkCredentials => ({
    appId: c.appId,
    appSecret: c.appSecret,
  });

  // SDK 的错误日志多为可恢复的连接问题（本循环会重连并在放弃时抛错），按 warn 记；info 以下丢弃（含消息正文）
  const sdkLogger = {
    error: (...m: unknown[]) => log.warn(`lark: ${m.map(String).join(" ")}`),
    warn: (...m: unknown[]) => log.warn(`lark: ${m.map(String).join(" ")}`),
    info: () => {},
    debug: () => {},
    trace: () => {},
  };

  const botInfo = async (c: LarkCredentials, signal: AbortSignal) => {
    const r = await api.call<{ bot?: { open_id?: unknown; app_name?: unknown } }>(
      c,
      "/open-apis/bot/v3/info",
      { signal },
    );
    const openId = typeof r.bot?.open_id === "string" ? r.bot.open_id : "";
    if (openId === "")
      throw new Error("Lark bot info returned no open_id (is the bot ability enabled?)");
    return {
      openId,
      name: typeof r.bot?.app_name === "string" && r.bot.app_name !== "" ? r.bot.app_name : openId,
    };
  };

  const profiles = new Map<string, { at: number; profile: Profile | undefined }>();
  const lookupProfile = async (
    c: LarkCredentials,
    scope: string,
    openId: string,
    signal: AbortSignal,
  ): Promise<Profile | undefined> => {
    const key = `${scope}\u0000${openId}`;
    const hit = profiles.get(key);
    if (hit && Date.now() - hit.at < PROFILE_TTL_MS) return hit.profile;
    let profile: Profile | undefined;
    try {
      // https://open.larksuite.com/document/uAjLw4CM/ukTMukTMukTM/reference/contact-v3/user/get （需要通讯录权限与可见范围）
      const r = await api.call<{
        data?: { user?: { name?: unknown; avatar?: { avatar_72?: unknown } } };
      }>(c, `/open-apis/contact/v3/users/${encodeURIComponent(openId)}`, {
        query: { user_id_type: "open_id" },
        signal,
        timeoutMs: PROFILE_TIMEOUT_MS,
      });
      const u = r.data?.user;
      const displayName = typeof u?.name === "string" && u.name !== "" ? u.name : undefined;
      const avatar = u?.avatar?.avatar_72;
      const avatarUrl = typeof avatar === "string" && avatar !== "" ? avatar : undefined;
      profile =
        displayName !== undefined || avatarUrl !== undefined
          ? {
              ...(displayName !== undefined && { displayName }),
              ...(avatarUrl !== undefined && { avatarUrl }),
            }
          : undefined;
    } catch (e) {
      // 网络 / 超时 / 限流不缓存（下次再试）；平台明确拒绝（没有权限、不在可见范围）缓存为「没有资料」
      const definitive =
        typeof (e as { code?: unknown }).code === "number" &&
        (e as { status: number }).status !== 429;
      if (!definitive) return undefined;
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
    p: Profile | undefined,
  ) => ({
    ...sender,
    ...(p?.displayName !== undefined && { displayName: p.displayName }),
    ...(p?.avatarUrl !== undefined && { avatarUrl: p.avatarUrl }),
  });

  const uuidFor = (key: string | undefined, i: number) =>
    key === undefined ? undefined : i === 0 ? key : `${key}-${i}`.slice(0, 50);

  return {
    connectionSchema: LarkConnection,
    features: { cards: true, edit: true, threads: true, minEditIntervalMs: MIN_EDIT_INTERVAL_MS },

    async verify({ config, signal }) {
      const c = creds(parse(config));
      try {
        await api.token(c, signal);
      } catch (e) {
        throw describeError(e, "tenant access token");
      }
      let bot: { openId: string; name: string };
      try {
        bot = await botInfo(c, signal);
      } catch (e) {
        if (e instanceof Error && e.message.startsWith("Lark bot info returned")) throw e;
        throw describeError(e, "bot info");
      }
      let tenantKey: string;
      try {
        // https://open.larksuite.com/document/uAjLw4CM/ukTMukTMukTM/tenant-v2/tenant/query （需要权限 tenant:tenant:readonly）
        const r = await api.call<{ data?: { tenant?: { tenant_key?: unknown } } }>(
          c,
          "/open-apis/tenant/v2/tenant/query",
          { signal },
        );
        const k = r.data?.tenant?.tenant_key;
        if (typeof k !== "string" || k === "") throw new Error("no tenant_key");
        tenantKey = k;
      } catch (e) {
        throw describeError(e, "tenant query (needs scope tenant:tenant:readonly)");
      }
      return { botUserId: bot.openId, botName: bot.name, tenantId: tenantKey };
    },

    async connect({ connectionId, config, onEvent, signal }) {
      const c = creds(parse(config));
      let botOpenId: string;
      try {
        await api.token(c, signal);
        botOpenId = (await botInfo(c, signal)).openId;
      } catch (e) {
        if (signal.aborted) return;
        if (e instanceof Error && e.message.startsWith("Lark bot info returned")) throw e;
        throw describeError(e, "credentials check");
      }

      const toEvent = async (raw: unknown): Promise<InboundEvent | null> => {
        const a = parseCardAction(raw);
        if (a) {
          const p = await lookupProfile(c, connectionId, a.sender.externalId, signal);
          return {
            type: "card_action",
            messageId: a.messageId,
            ...(a.eventId !== undefined && { eventId: a.eventId }),
            target: a.target,
            sender: withProfile(a.sender, p),
            action: a.action,
          };
        }
        const cand = eventToInbound(raw, botOpenId);
        if (!cand) return null;
        if (cand.kind === "directory") return cand.event;
        const p = await lookupProfile(c, connectionId, cand.openId, signal);
        return { ...cand.event, sender: withProfile(cand.event.sender, p) };
      };

      /** SDK 事件处理入口：resolve = 确认（code 200），throw = 不确认（code 500，Lark 重推）。 */
      const dispatcher = {
        invoke: async (raw: unknown): Promise<undefined> => {
          let event: InboundEvent | null = null;
          try {
            event = await toEvent(raw);
          } catch (e) {
            log.warn("lark: could not read an event; acknowledging and skipping it", {
              connectionId,
              error: errorText(e),
            });
          }
          if (!event) return undefined;
          try {
            await onEvent(event);
          } catch (e) {
            log.warn("lark: event not accepted; failing it so Lark redelivers", {
              connectionId,
              error: errorText(e),
            });
            throw e;
          }
          return undefined;
        },
      } as unknown as EventDispatcher;

      let failures = 0;
      while (!signal.aborted) {
        const startedAt = Date.now();
        const attempt = new AbortController();
        const loopSignal = AbortSignal.any([signal, attempt.signal]);
        let settle: (r: { ok: true } | { ok: false; error: string }) => void = () => {};
        const settled = new Promise<{ ok: true } | { ok: false; error: string }>((r) => {
          settle = r;
        });
        const client = new WSClient({
          appId: c.appId,
          appSecret: c.appSecret,
          domain,
          autoReconnect: false,
          logger: sdkLogger,
          loggerLevel: LoggerLevel.warn,
          httpInstance: wsHttp(loopSignal),
          handshakeTimeoutMs: 10_000,
          wsConfig: { pingTimeout: 30 },
          source: "capybara",
          onReady: () => settle({ ok: true }),
          onError: (err: Error) => settle({ ok: false, error: err.message }),
        });
        let reason: string | undefined;
        try {
          void client.start({ eventDispatcher: dispatcher }).catch((e: unknown) => {
            settle({ ok: false, error: errorText(e) });
          });
          const aborted = new Promise<"aborted">((r) => {
            if (loopSignal.aborted) r("aborted");
            else loopSignal.addEventListener("abort", () => r("aborted"), { once: true });
          });
          const timedOut = pause(connectTimeout, loopSignal).then(() => "timeout" as const);
          const first = await Promise.race([settled, aborted, timedOut]);
          if (signal.aborted) return;
          if (first === "timeout" || first === "aborted") {
            reason = "timed out connecting";
          } else if (!first.ok) {
            // 接入点明确拒绝（非「internal error」）：配置 / 权限问题，不重试本轮
            if (/pullConnectConfig failed/.test(first.error)) {
              const code = /code=(\d+)/.exec(first.error)?.[1];
              throw new Error(
                `Lark long connection refused by the endpoint${code !== undefined ? `: code ${code}` : ""}`,
              );
            }
            reason = "could not connect";
          } else {
            // 连着：定期查看连接状态，直到断开或中止
            while (!signal.aborted && client.getConnectionStatus().state === "connected") {
              await pause(statusPoll, signal);
            }
            if (signal.aborted) return;
            reason = "connection closed";
          }
        } finally {
          attempt.abort();
          client.close({ force: true });
        }
        const shortLived =
          reason !== "connection closed" || Date.now() - startedAt < SHORT_LIVED_MS;
        failures = shortLived ? failures + 1 : 0;
        if (failures >= MAX_FAILURES) {
          throw new Error(
            `Lark long connection keeps closing (${failures} times within ${SHORT_LIVED_MS / 1000}s each, last: ${reason})`,
          );
        }
        log.info("lark: long connection lost; reconnecting", { connectionId, reason });
        // 正常断开（活得够久）立即重连；失败 / 短命的按 base·2^(n-1) 指数退避，乘 0.5–1 的抖动
        const delay =
          failures === 0
            ? 0
            : Math.min(MAX_RECONNECT_DELAY_MS, reconnectBase * 2 ** (failures - 1)) *
              (0.5 + Math.random() / 2);
        if (delay > 0) await pause(Math.round(delay), signal);
      }
    },

    async send({ config, target, message, signal, locale, idempotencyKey }) {
      const c = creds(parse(config));
      const cards = renderSend(message, locale, chatKind(target));
      for (const card of cards) checkSize(card);
      // 群聊话题 id 必须是根消息的 message_id（om_…）；不合法时不悄悄改发到群里顶层
      if (
        target.chatType === "group" &&
        target.threadId !== undefined &&
        !MESSAGE_ID.test(target.threadId)
      ) {
        throw new ChannelSendError("malformed Lark thread id (expected the root message_id om_…)", {
          retryable: false,
          reason: "rejected",
        });
      }
      const root = target.chatType === "group" ? target.threadId : undefined;
      let last: string | undefined;
      for (const [i, card] of cards.entries()) {
        const uuid = uuidFor(idempotencyKey, i);
        const body = {
          msg_type: "interactive",
          content: JSON.stringify(card),
          ...(uuid !== undefined && { uuid }),
        };
        let r: { data?: { message_id?: unknown } };
        try {
          r =
            root !== undefined
              ? await api.call(c, `/open-apis/im/v1/messages/${encodeURIComponent(root)}/reply`, {
                  method: "POST",
                  body: { ...body, reply_in_thread: true },
                  signal,
                })
              : await api.call(c, "/open-apis/im/v1/messages", {
                  method: "POST",
                  query: { receive_id_type: "chat_id" },
                  body: { receive_id: target.chatId, ...body },
                  signal,
                });
        } catch (e) {
          throw toChannelSendError(e);
        }
        const id = r.data?.message_id;
        if (typeof id !== "string" || id === "") {
          throw new ChannelSendError("Lark returned no message_id", {
            retryable: false,
            reason: "rejected",
          });
        }
        last = id;
      }
      if (last === undefined) throw new ChannelSendError("nothing to send", { retryable: false });
      return { messageId: last };
    },

    async update({ config, target, messageId, message, signal, locale }) {
      const card = renderUpdate(message, locale, chatKind(target));
      if (!MESSAGE_ID.test(messageId)) {
        throw new ChannelSendError("malformed Lark message id", {
          retryable: false,
          reason: "rejected",
        });
      }
      const c = creds(parse(config));
      try {
        await api.call(c, `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}`, {
          method: "PATCH",
          body: { content: JSON.stringify(card) },
          signal,
        });
      } catch (e) {
        throw toChannelSendError(e);
      }
    },
  };
}
