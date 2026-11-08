import { randomBytes } from "node:crypto";
import type { CardAction, InboundEvent } from "@capybara-hq/plugin-sdk";
import { SENDER_TENANT } from "./config.js";
import { type Kv, RECORD_TTL_SECONDS, type ThreadStore } from "./threads.js";

/** Every inline button carries `cb:` + a token; the payload lives in kv (64-byte limit). */
export const CALLBACK_PREFIX = "cb:";

const TOKEN_RE = /^[A-Za-z0-9_-]{16}$/;
/** A card action JSON is a few hundred bytes at most; refuse anything bigger before parsing. */
const ACTION_JSON_MAX = 8000;

export interface CardTokenStore {
  put(a: CardAction): Promise<string>;
  /** A plain get: clicks may repeat and the kernel dedupes by event id. */
  take(token: string): Promise<CardAction | null>;
}

const nonEmpty = (x: unknown): x is string => typeof x === "string" && x !== "";
const SCOPES: ReadonlySet<string> = new Set(["once", "session", "always"]); // capybara:allow-module-state read-only constant list of approval scopes

/** Strict decoding: shape, kind, action, scope and every answer value are checked. */
export function decodeCardAction(json: string): CardAction | null {
  if (typeof json !== "string" || json.length === 0 || json.length > ACTION_JSON_MAX) return null;
  let v: unknown;
  try {
    v = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (!nonEmpty(o.cardId)) return null;
  const cardId = o.cardId;
  if (o.cardKind === "approval") {
    if (o.answer !== undefined) return null;
    if (o.action === "approve" && typeof o.scope === "string" && SCOPES.has(o.scope)) {
      return {
        cardKind: "approval",
        cardId,
        action: "approve",
        scope: o.scope as "once" | "session" | "always",
      };
    }
    if (o.action === "deny" && o.scope === undefined) {
      return { cardKind: "approval", cardId, action: "deny" };
    }
    return null;
  }
  if (o.cardKind === "question") {
    if (o.action !== "answer" || o.scope !== undefined) return null;
    const a = o.answer;
    if (typeof a !== "object" || a === null || Array.isArray(a)) return null;
    const entries = Object.entries(a);
    if (entries.length === 0) return null;
    for (const [k, val] of entries) {
      if (k === "") return null;
      const ok =
        typeof val === "string" ||
        typeof val === "boolean" ||
        (typeof val === "number" && Number.isFinite(val)) ||
        (Array.isArray(val) && val.every((x) => typeof x === "string"));
      if (!ok) return null;
    }
    return {
      cardKind: "question",
      cardId,
      action: "answer",
      answer: a as NonNullable<CardAction["answer"]>,
    };
  }
  return null;
}

/** Without a kv nothing can be stored: `put` throws and callers fall back to URL buttons. */
export function cardTokenStore(kv: Kv | undefined, botId: string): CardTokenStore {
  const key = (token: string) => `card/${botId}/${token}`;
  return {
    async put(a) {
      if (!kv) throw new Error("no kv available for card tokens");
      const token = randomBytes(12).toString("base64url");
      await kv.set(key(token), JSON.stringify(a), { ttlSeconds: RECORD_TTL_SECONDS });
      return token;
    },
    async take(token) {
      if (!kv || !TOKEN_RE.test(token)) return null;
      const raw = await kv.get(key(token));
      return raw === null || raw === undefined ? null : decodeCardAction(raw);
    },
  };
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | undefined =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Obj) : undefined;
const int = (v: unknown) => (typeof v === "number" && Number.isSafeInteger(v) ? v : undefined);
const str = (v: unknown) => (typeof v === "string" && v !== "" ? v : undefined);

/**
 * A `callback_query` update to a `card_action` event, or `null` for anything that is not a valid
 * click on one of this plugin's buttons (the caller still answers the query). `messageId` is the
 * card message (`<chat>:<message id>`), `eventId` the callback query id, `threadId` comes from
 * the thread store when the card message was recorded.
 */
export async function parseCallback(
  update: unknown,
  tokens: CardTokenStore,
  threads: ThreadStore,
): Promise<{ event: InboundEvent; callbackQueryId: string } | null> {
  const q = obj(obj(update)?.callback_query);
  const id = str(q?.id);
  const data = str(q?.data);
  const from = obj(q?.from);
  const message = obj(q?.message);
  const chat = obj(message?.chat);
  const userId = int(from?.id);
  const chatId = int(chat?.id);
  const messageId = int(message?.message_id);
  if (!q || !id || !data || !from || !chat || !messageId || userId === undefined) return null;
  if (chatId === undefined || from.is_bot === true) return null;
  if (!data.startsWith(CALLBACK_PREFIX) || data.length > 64) return null;
  const chatType = chat.type;
  const dm = chatType === "private";
  if (!dm && chatType !== "group" && chatType !== "supergroup") return null;

  const action = await tokens.take(data.slice(CALLBACK_PREFIX.length));
  if (!action) return null;

  const chatKey = String(chatId);
  const displayName = [str(from.first_name), str(from.last_name)].filter(Boolean).join(" ").trim();
  const threadId = dm ? undefined : await threads.threadOfMessage(chatKey, messageId);
  const event: InboundEvent = {
    type: "card_action",
    messageId: `${chatKey}:${messageId}`,
    eventId: id,
    target: dm
      ? { chatId: chatKey, chatType: "dm" }
      : { chatId: chatKey, chatType: "group", ...(threadId !== undefined && { threadId }) },
    sender: {
      externalId: String(userId),
      tenantId: SENDER_TENANT,
      ...(displayName !== "" && { displayName }),
    },
    action,
  };
  return { event, callbackQueryId: id };
}
