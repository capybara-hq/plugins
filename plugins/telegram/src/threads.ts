import type { ExtensionContext } from "@capybara-hq/plugin-sdk";

export type Kv = ExtensionContext["kv"];

/** Every record lives 30 days. */
export const RECORD_TTL_SECONDS = 30 * 24 * 60 * 60;

/**
 * kv records that keep group replies in one conversation (spec "Threads"). Keys are scoped by bot
 * id: `send` gets no connection id.
 */
export interface ThreadStore {
  /** The thread a message the bot sent belongs to. */
  threadOfMessage(chatId: string, messageId: number): Promise<string | undefined>;
  recordSent(chatId: string, messageId: number, threadId: string): Promise<void>;
  /** The forum topic (`message_thread_id`) a thread lives in. */
  topicOf(threadId: string): Promise<number | undefined>;
  recordTopic(threadId: string, messageThreadId: number): Promise<void>;
}

/** Without a kv, lookups miss and writes do nothing. */
export function threadStore(kv: Kv | undefined, botId: string): ThreadStore {
  const threadKey = (chatId: string, messageId: number) => `thread/${botId}/${chatId}:${messageId}`;
  const topicKey = (threadId: string) => `topic/${botId}/${threadId}`;
  return {
    async threadOfMessage(chatId, messageId) {
      return (await kv?.get(threadKey(chatId, messageId))) ?? undefined;
    },
    async recordSent(chatId, messageId, threadId) {
      await kv?.set(threadKey(chatId, messageId), threadId, { ttlSeconds: RECORD_TTL_SECONDS });
    },
    async topicOf(threadId) {
      const raw = await kv?.get(topicKey(threadId));
      if (raw === null || raw === undefined) return undefined;
      const n = Number(raw);
      return Number.isSafeInteger(n) ? n : undefined;
    },
    async recordTopic(threadId, messageThreadId) {
      await kv?.set(topicKey(threadId), String(messageThreadId), {
        ttlSeconds: RECORD_TTL_SECONDS,
      });
    },
  };
}
