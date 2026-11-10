import {
  type Channel,
  type ChannelSendArgs,
  ChannelSendError,
  type ChannelTarget,
  type ExtensionContext,
  type Logger,
} from "@capybara-hq/plugin-sdk";
import { cardTokenStore } from "./actions.js";
import { TelegramApiError, telegramApi } from "./api.js";
import { cardHeadline, renderCards, type TelegramPost } from "./cards.js";
import { botIdOf, connectionTenant, TelegramConnection } from "./config.js";
import { toChannelSendError } from "./errors.js";
import { fitHtml, markdownToTelegramHtml, splitHtml } from "./html.js";
import { chatMigration, updateToInbound } from "./inbound.js";
import { runLongPolling } from "./poll.js";
import { markdownToRichHtml } from "./rich.js";
import { threadStore } from "./threads.js";
import { answerWebhookCallback, handleTelegramWebhook, webhookBotIdentity } from "./webhook.js";

/** Telegram allows about 20 messages a minute in a group; edits count (spec "Send, update"). */
export const MIN_EDIT_INTERVAL_MS = 3000;

export interface TelegramChannelOptions {
  /** Bot API root (default https://api.telegram.org; tests point it at the fake). */
  apiUrl: string;
  log: Logger;
  /** Plugin kv (`ctx.kv`): the long-polling offset and thread records, keyed by bot id. */
  kv?: ExtensionContext["kv"];
  /** One Bot API request's timeout (default 15 s). */
  requestTimeoutMs?: number;
  /** The `getUpdates` long-poll timeout (default 25 s). */
  pollTimeoutSec?: number;
  /** Base of the network-error backoff (tests lower it). */
  backoffBaseMs?: number;
}

interface Me {
  id?: number;
  username?: string;
  can_read_all_group_messages?: boolean;
  has_topics_enabled?: boolean;
}

/** `<chat id>:<message id>`; the chat id may be negative, so the last `:` splits. */
function parseMessageId(id: string): { chatId: string; messageId: number } {
  const at = id.lastIndexOf(":");
  const messageId = Number(id.slice(at + 1));
  if (at <= 0 || !Number.isSafeInteger(messageId)) {
    throw new ChannelSendError("malformed Telegram message id", {
      retryable: false,
      reason: "rejected",
    });
  }
  return { chatId: id.slice(0, at), messageId };
}

const tooLarge = () =>
  new ChannelSendError("message too long for a single Telegram message", {
    retryable: false,
    reason: "too_large",
  });

/** Telegram refused an inline keyboard button's URL (e.g. `http://localhost/...`). */
const urlButtonRejected = (e: unknown) =>
  e instanceof TelegramApiError &&
  (e.errorCode ?? e.status) === 400 &&
  /button URL|Wrong HTTP URL|BUTTON_URL_INVALID/i.test(e.description ?? "");

/** Telegram refused a rich message for its content (or does not know the method): use plain HTML. */
const richRefused = (e: unknown) => {
  if (!(e instanceof TelegramApiError)) return false;
  const mapped = toChannelSendError(e);
  return !mapped.retryable && (mapped.reason === "rejected" || mapped.reason === "too_large");
};

const notModified = (e: unknown) =>
  e instanceof TelegramApiError && /message is not modified/i.test(e.description ?? "");

/** The rich HTML of a text-only reply with a table; undefined when it goes out as plain HTML. */
const richOf = (message: ChannelSendArgs["message"]) =>
  (message.cards ?? []).length === 0 && message.text.trim() !== ""
    ? markdownToRichHtml(message.text)
    : undefined;

export function createTelegramChannel(o: TelegramChannelOptions): Channel {
  const apiFor = (config: unknown, signal?: AbortSignal) => {
    const c = TelegramConnection.parse(config);
    const botId = botIdOf(c.botToken);
    const api = telegramApi({
      apiUrl: o.apiUrl,
      token: c.botToken,
      ...(o.requestTimeoutMs !== undefined && { timeoutMs: o.requestTimeoutMs }),
    });
    return {
      api,
      botId,
      call: <T>(m: string, p?: Record<string, unknown>) => api.call<T>(m, p, signal),
    };
  };

  /**
   * The posts of a message. Text alone: its parts (split at the limit). With cards: one post per
   * card, never split (cut with an ellipsis instead), the text leading the first card's post unless
   * it repeats a card's headline (the card carries it). The kernel sends a card with a fixed line
   * of text and later updates it the same way, so a card and its text must stay one message.
   */
  async function render(
    message: ChannelSendArgs["message"],
    locale: ChannelSendArgs["locale"],
    botId: string,
  ): Promise<TelegramPost[]> {
    const text = message.text.trim();
    const cards = message.cards ?? [];
    if (cards.length === 0) {
      return text === ""
        ? []
        : splitHtml(markdownToTelegramHtml(message.text)).map((html) => ({ html }));
    }
    const dup = cards.some((c) => cardHeadline(c, locale)?.trim() === text);
    const lead = text === "" || dup ? "" : markdownToTelegramHtml(message.text);
    const fit = (p: TelegramPost, leading: string): TelegramPost => ({
      ...p,
      html: fitHtml(leading, p.html),
      ...(p.withoutUrlButtons && { withoutUrlButtons: fit(p.withoutUrlButtons, leading) }),
    });
    const posts = await renderCards(cards, locale, cardTokenStore(o.kv, botId), o.log);
    return posts.map((p, i) => fit(p, i === 0 ? lead : ""));
  }

  /**
   * Calls `attempt` with `post`; when Telegram rejects one of its URL buttons, once more with the
   * post without URL buttons (the link moves into the text).
   */
  async function withUrlButtonFallback<T>(
    post: TelegramPost,
    attempt: (p: TelegramPost) => Promise<T>,
  ): Promise<T> {
    try {
      return await attempt(post);
    } catch (e) {
      if (!post.withoutUrlButtons || !urlButtonRejected(e)) throw e;
      o.log.warn("telegram: Telegram rejected a card's URL button; the link is sent as text");
      return attempt(post.withoutUrlButtons);
    }
  }

  const warnRichFallback = (e: unknown, method: string) =>
    o.log.warn("telegram: Telegram refused a rich message; the reply is sent as plain HTML", {
      method,
      ...(e instanceof TelegramApiError && { error: e.description ?? e.message }),
    });

  /** Sends one rich message; undefined when Telegram refused it for its content (fall back). */
  async function sendRich(
    api: { call<T>(m: string, p?: Record<string, unknown>): Promise<T> },
    target: ChannelTarget,
    html: string,
    extra: Record<string, unknown>,
  ): Promise<number | undefined> {
    let r: { message_id?: number } | undefined;
    try {
      r = await api.call<{ message_id?: number } | undefined>("sendRichMessage", {
        chat_id: target.chatId,
        rich_message: { html },
        ...extra,
      });
    } catch (e) {
      if (richRefused(e)) {
        warnRichFallback(e, "sendRichMessage");
        return undefined;
      }
      throw toChannelSendError(e);
    }
    if (typeof r?.message_id !== "number") {
      throw new ChannelSendError("Telegram returned no message id", {
        retryable: false,
        reason: "rejected",
      });
    }
    return r.message_id;
  }

  async function sendOne(
    api: { call<T>(m: string, p?: Record<string, unknown>): Promise<T> },
    target: ChannelTarget,
    post: TelegramPost,
    extra: Record<string, unknown>,
  ): Promise<number> {
    let r: { message_id?: number } | undefined;
    try {
      r = await withUrlButtonFallback(post, (p) =>
        api.call<{ message_id?: number } | undefined>("sendMessage", {
          chat_id: target.chatId,
          text: p.html,
          parse_mode: "HTML",
          link_preview_options: { is_disabled: true },
          ...(p.replyMarkup && { reply_markup: p.replyMarkup }),
          ...extra,
        }),
      );
    } catch (e) {
      throw toChannelSendError(e);
    }
    if (typeof r?.message_id !== "number") {
      throw new ChannelSendError("Telegram returned no message id", {
        retryable: false,
        reason: "rejected",
      });
    }
    return r.message_id;
  }

  return {
    connectionSchema: TelegramConnection,
    features: { cards: true, edit: true, threads: true, minEditIntervalMs: MIN_EDIT_INTERVAL_MS },

    async verify({ config, signal }) {
      const { call } = apiFor(config, signal);
      const me = await call<Me | undefined>("getMe");
      if (typeof me?.id !== "number" || !me.username) {
        throw new Error("Telegram getMe returned no bot user");
      }
      if (me.can_read_all_group_messages) {
        o.log.warn(
          "telegram: the bot can read all group messages (privacy mode is off); only mentions and replies to the bot are forwarded",
          { botId: me.id },
        );
      }
      if (me.has_topics_enabled) {
        o.log.warn(
          "telegram: topic mode in private chats is not supported; turn it off in BotFather",
          { botId: me.id },
        );
      }
      return {
        botUserId: String(me.id),
        botName: `@${me.username}`,
        tenantId: connectionTenant(me.id),
      };
    },

    async connect({ connectionId, config, onEvent, signal }) {
      const c = TelegramConnection.parse(config);
      const botId = botIdOf(c.botToken);
      const pollTimeoutSec = o.pollTimeoutSec ?? 25;
      const api = telegramApi({
        apiUrl: o.apiUrl,
        token: c.botToken,
        ...(o.requestTimeoutMs !== undefined && { timeoutMs: o.requestTimeoutMs }),
      });
      // getUpdates holds the request for up to pollTimeoutSec: its client must wait longer.
      const pollApi = telegramApi({
        apiUrl: o.apiUrl,
        token: c.botToken,
        timeoutMs: pollTimeoutSec * 1000 + 10_000,
      });
      await runLongPolling({
        api,
        pollApi,
        connectionId,
        onEvent,
        signal,
        log: o.log,
        kv: o.kv,
        threads: threadStore(o.kv, botId),
        tokens: cardTokenStore(o.kv, botId),
        pollTimeoutSec,
        backoffBaseMs: o.backoffBaseMs ?? 1000,
      });
    },

    webhook: {
      // The kernel validated `config`; parsing again only narrows its type. Nothing reaches
      // Telegram (getMe, answerCallbackQuery) before the secret check passed.
      async handle({ connectionId, config, request, signal }) {
        const c = TelegramConnection.parse(config);
        const botId = botIdOf(c.botToken);
        const api = telegramApi({
          apiUrl: o.apiUrl,
          token: c.botToken,
          ...(o.requestTimeoutMs !== undefined && { timeoutMs: o.requestTimeoutMs }),
        });
        return handleTelegramWebhook({
          config: c,
          request,
          toEvent: async (update) => {
            const migration = chatMigration(update);
            if (migration) {
              o.log.info("telegram: a group became a supergroup; its old conversations stop", {
                connectionId,
                ...migration,
              });
              return null;
            }
            const bot = await webhookBotIdentity(api, o.kv, botId, signal);
            const event = await updateToInbound(
              update,
              bot,
              threadStore(o.kv, botId),
              cardTokenStore(o.kv, botId),
            );
            await answerWebhookCallback(api, update, o.log, connectionId, signal);
            return event;
          },
        });
      },
    },

    async send({ config, target, message, locale, signal }) {
      const { call, botId } = apiFor(config, signal);
      const rich = richOf(message);
      const posts = rich === undefined ? await render(message, locale, botId) : [];
      if (rich === undefined && posts.length === 0) {
        throw new ChannelSendError("nothing to send", { retryable: false });
      }
      const store = threadStore(o.kv, botId);
      const inThread = target.chatType === "group" && target.threadId !== undefined;
      const extra: Record<string, unknown> = {};
      if (inThread && target.threadId !== undefined) {
        extra.reply_parameters = {
          message_id: parseMessageId(target.threadId).messageId,
          allow_sending_without_reply: true,
        };
        const topic = await store.topicOf(target.threadId);
        if (topic !== undefined) extra.message_thread_id = topic;
      }
      const record = async (sent: number) => {
        if (!inThread || target.threadId === undefined) return;
        // The message is delivered: a failing record must not fail the send (the kernel would
        // resend it). Only a later reply to this message loses its thread.
        try {
          await store.recordSent(target.chatId, sent, target.threadId);
        } catch {
          o.log.warn("telegram: could not record a sent message's thread", {
            chatId: target.chatId,
            messageId: sent,
          });
        }
      };
      if (rich !== undefined) {
        const sent = await sendRich({ call }, target, rich, extra);
        if (sent !== undefined) {
          await record(sent);
          return { messageId: `${target.chatId}:${sent}` };
        }
        posts.push(...(await render(message, locale, botId)));
      }
      let last = 0;
      for (const post of posts) {
        last = await sendOne({ call }, target, post, extra);
        await record(last);
      }
      return { messageId: `${target.chatId}:${last}` };
    },

    async update({ config, messageId, message, locale, signal }) {
      const { call, botId } = apiFor(config, signal);
      const { chatId, messageId: id } = parseMessageId(messageId);
      // A reply with a table is edited into a rich message (Telegram turns a text message into a
      // rich one and back on edit); refused content falls back to the plain HTML edit below.
      const rich = richOf(message);
      if (rich !== undefined) {
        try {
          await call("editMessageText", {
            chat_id: chatId,
            message_id: id,
            rich_message: { html: rich },
          });
          return;
        } catch (e) {
          if (notModified(e)) return;
          if (!richRefused(e)) throw toChannelSendError(e);
          warnRichFallback(e, "editMessageText");
        }
      }
      // Like Slack: an update that renders to several messages (long text, several cards) is too
      // large; the kernel then sends the full message fresh. Without reply_markup an edit removes
      // an inline keyboard.
      const posts = await render(message, locale, botId);
      if (posts.length > 1) throw tooLarge();
      const post = posts[0];
      if (!post) throw new ChannelSendError("nothing to send", { retryable: false });
      try {
        await withUrlButtonFallback(post, (p) =>
          call("editMessageText", {
            chat_id: chatId,
            message_id: id,
            text: p.html,
            parse_mode: "HTML",
            link_preview_options: { is_disabled: true },
            ...(p.replyMarkup && { reply_markup: p.replyMarkup }),
          }),
        );
      } catch (e) {
        if (notModified(e)) return;
        throw toChannelSendError(e);
      }
    },
  };
}
