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
import { renderCards, type TelegramPost } from "./cards.js";
import { botIdOf, connectionTenant, TelegramConnection } from "./config.js";
import { toChannelSendError } from "./errors.js";
import { markdownToTelegramHtml, splitHtml } from "./html.js";
import { threadStore } from "./threads.js";

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

  /** The posts of a message: its text parts, then one post per card. */
  async function render(
    message: ChannelSendArgs["message"],
    locale: ChannelSendArgs["locale"],
    botId: string,
  ): Promise<TelegramPost[]> {
    const posts: TelegramPost[] = [];
    if (message.text.trim() !== "") {
      for (const html of splitHtml(markdownToTelegramHtml(message.text))) posts.push({ html });
    }
    if (message.cards?.length) {
      for (const card of await renderCards(message.cards, locale, cardTokenStore(o.kv, botId))) {
        const parts = splitHtml(card.html);
        parts.forEach((html, i) => {
          const last = i === parts.length - 1;
          posts.push({ html, ...(last && card.replyMarkup && { replyMarkup: card.replyMarkup }) });
        });
      }
    }
    return posts;
  }

  async function sendOne(
    api: { call<T>(m: string, p?: Record<string, unknown>): Promise<T> },
    target: ChannelTarget,
    post: TelegramPost,
    extra: Record<string, unknown>,
  ): Promise<number> {
    let r: { message_id?: number } | undefined;
    try {
      r = await api.call<{ message_id?: number } | undefined>("sendMessage", {
        chat_id: target.chatId,
        text: post.html,
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
        ...(post.replyMarkup && { reply_markup: post.replyMarkup }),
        ...extra,
      });
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

    async connect() {
      throw new Error("not implemented");
    },

    async send({ config, target, message, locale, signal }) {
      const { call, botId } = apiFor(config, signal);
      const posts = await render(message, locale, botId);
      if (posts.length === 0) throw new ChannelSendError("nothing to send", { retryable: false });
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
      let last = 0;
      for (const post of posts) {
        last = await sendOne({ call }, target, post, extra);
        if (inThread && target.threadId !== undefined) {
          // The message is delivered: a failing record must not fail the send (the kernel would
          // resend it). Only a later reply to this message loses its thread.
          try {
            await store.recordSent(target.chatId, last, target.threadId);
          } catch {
            o.log.warn("telegram: could not record a sent message's thread", {
              chatId: target.chatId,
              messageId: last,
            });
          }
        }
      }
      return { messageId: `${target.chatId}:${last}` };
    },

    async update({ config, messageId, message, locale, signal }) {
      const { call, botId } = apiFor(config, signal);
      const { chatId, messageId: id } = parseMessageId(messageId);
      // Like Slack: an update that renders to several messages is too large; the kernel then
      // sends the full message fresh. Without reply_markup an edit removes an inline keyboard.
      const posts = await render(message, locale, botId);
      if (posts.length > 1) throw tooLarge();
      const post = posts[0];
      if (!post) throw new ChannelSendError("nothing to send", { retryable: false });
      const html = post.html;
      const markup = post.replyMarkup;
      try {
        await call("editMessageText", {
          chat_id: chatId,
          message_id: id,
          text: html,
          parse_mode: "HTML",
          link_preview_options: { is_disabled: true },
          ...(markup && { reply_markup: markup }),
        });
      } catch (e) {
        if (e instanceof TelegramApiError && /message is not modified/i.test(e.description ?? "")) {
          return;
        }
        throw toChannelSendError(e);
      }
    },
  };
}
