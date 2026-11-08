import type { ChannelTarget, InboundEvent } from "@capybara-hq/plugin-sdk";
import { type CardTokenStore, parseCallback } from "./actions.js";
import { SENDER_TENANT } from "./config.js";
import type { ThreadStore } from "./threads.js";

export interface BotIdentity {
  id: number;
  username: string;
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | undefined =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Obj) : undefined;
const int = (v: unknown) => (typeof v === "number" && Number.isSafeInteger(v) ? v : undefined);
const str = (v: unknown) => (typeof v === "string" ? v : undefined);

interface Edit {
  start: number;
  end: number;
  /** `undefined`: remove the range and tidy the blanks around it. */
  replacement: string | undefined;
}

/**
 * Applies edits (entity offsets are UTF-16 code units, like JS string indexes). A removed range
 * takes the spaces and tabs around it with it and leaves one space (none at a line start or end);
 * newlines and indentation stay.
 */
function applyEdits(text: string, edits: Edit[]): string {
  let out = text;
  for (const e of [...edits].sort((a, b) => b.start - a.start)) {
    if (e.replacement !== undefined) {
      out = out.slice(0, e.start) + e.replacement + out.slice(e.end);
      continue;
    }
    let s = e.start;
    let t = e.end;
    while (s > 0 && (out[s - 1] === " " || out[s - 1] === "\t")) s--;
    while (t < out.length && (out[t] === " " || out[t] === "\t")) t++;
    const lineStart = s === 0 || out[s - 1] === "\n";
    const lineEnd = t === out.length || out[t] === "\n";
    out = out.slice(0, s) + (lineStart || lineEnd ? "" : " ") + out.slice(t);
  }
  return out.trim();
}

/** The text with the bot's @mention removed, and whether the bot was addressed through an entity. */
function readText(
  text: string,
  entities: unknown,
  bot: BotIdentity,
): { text: string; addressed: boolean } {
  const handle = `@${bot.username}`.toLowerCase();
  const edits: Edit[] = [];
  let addressed = false;
  for (const raw of Array.isArray(entities) ? entities : []) {
    const e = obj(raw);
    const start = int(e?.offset);
    const length = int(e?.length);
    if (!e || start === undefined || length === undefined || length <= 0) continue;
    const end = start + length;
    if (end > text.length) continue;
    const slice = text.slice(start, end);
    if (e.type === "mention") {
      if (slice.toLowerCase() === handle) {
        addressed = true;
        edits.push({ start, end, replacement: undefined });
      }
    } else if (e.type === "text_mention") {
      if (obj(e.user)?.id === bot.id) {
        addressed = true;
        edits.push({ start, end, replacement: undefined });
      } else {
        edits.push({ start, end, replacement: `@${slice}` });
      }
    } else if (e.type === "bot_command") {
      const at = slice.lastIndexOf("@");
      if (at > 0 && slice.slice(at).toLowerCase() === handle) {
        addressed = true;
        edits.push({ start: start + at, end, replacement: "" });
      }
    }
  }
  return { text: applyEdits(text, edits), addressed };
}

/**
 * A Bot API update to an inbound event, or `null` when nothing should be sent (spec "Inbound
 * rules"): `message` updates, and `callback_query` updates (card button clicks, parsed by
 * `parseCallback`, only when `tokens` is given; the caller answers the query); bot senders,
 * ephemeral messages (`message_id` 0), service messages, media without a caption and group
 * messages that neither mention the bot nor reply to it are dropped.
 *
 * In a group, a reply continues the thread of its parent when the plugin recorded that parent;
 * otherwise it starts a new one. Every forwarded group message is recorded (a new root maps to its
 * own id), so replies to it find the thread. A message inside a forum
 * topic records the topic of its thread (the root's id when it has no thread yet).
 */
export async function updateToInbound(
  update: unknown,
  bot: BotIdentity,
  threads: ThreadStore,
  tokens?: CardTokenStore,
): Promise<InboundEvent | null> {
  if (tokens && obj(obj(update)?.callback_query)) {
    return (await parseCallback(update, tokens, threads))?.event ?? null;
  }
  const message = obj(obj(update)?.message);
  if (!message) return null;
  const chat = obj(message.chat);
  const from = obj(message.from);
  const messageId = int(message.message_id);
  const chatId = int(chat?.id);
  const userId = int(from?.id);
  if (!chat || !from || !messageId || chatId === undefined || userId === undefined) return null;
  if (from.is_bot === true) return null;

  const isText = typeof message.text === "string";
  const rawText = str(message.text) ?? str(message.caption);
  if (rawText === undefined) return null;
  const { text, addressed } = readText(
    rawText,
    isText ? message.entities : message.caption_entities,
    bot,
  );
  if (text === "") return null;

  const chatType = chat.type;
  const dm = chatType === "private";
  if (!dm && chatType !== "group" && chatType !== "supergroup") return null;

  const chatKey = String(chatId);
  const displayName = [str(from.first_name), str(from.last_name)].filter(Boolean).join(" ").trim();
  const sender = {
    externalId: String(userId),
    tenantId: SENDER_TENANT,
    ...(displayName !== "" && { displayName }),
  };
  const base = { type: "message" as const, messageId: `${chatKey}:${messageId}`, sender, text };

  if (dm) {
    return {
      ...base,
      target: { chatId: chatKey, chatType: "dm" },
      mentionsBot: true,
    };
  }

  // A reply to the topic's creation service message is not a reply to a person.
  const parent = obj(message.reply_to_message);
  const parentId = parent && !parent.forum_topic_created ? int(parent.message_id) : undefined;
  const replyToBot = parentId !== undefined && obj(parent?.from)?.id === bot.id;
  if (!addressed && !replyToBot) return null;

  const threadId =
    parentId !== undefined ? await threads.threadOfMessage(chatKey, parentId) : undefined;
  // Record every forwarded group message, so a later reply to it finds its thread.
  await threads.recordSent(chatKey, messageId, threadId ?? base.messageId);
  const messageThreadId = int(message.message_thread_id);
  if (message.is_topic_message === true && messageThreadId !== undefined) {
    await threads.recordTopic(threadId ?? base.messageId, messageThreadId);
  }
  const target: ChannelTarget = {
    chatId: chatKey,
    chatType: "group",
    ...(threadId !== undefined && { threadId }),
  };
  return { ...base, target, mentionsBot: true };
}
