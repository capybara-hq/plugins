import {
  type CardAction,
  type ChannelCard,
  type Locale,
  questionRenderableInline,
  renderCardAsText,
} from "@capybara-hq/plugin-sdk";
import { CALLBACK_PREFIX, type CardTokenStore } from "./actions.js";
import { markdownToTelegramHtml } from "./html.js";

export interface TelegramPost {
  html: string;
  replyMarkup?: { inline_keyboard: unknown[][] };
}

type Button = { text: string; callback_data: string } | { text: string; url: string };

const T = {
  zh: {
    once: "批准一次",
    session: "本会话批准",
    always: "总是批准",
    deny: "拒绝",
    web: "在网页上查看",
    connect: "连接",
    bind: "绑定账号",
  },
  en: {
    once: "Approve once",
    session: "Approve for session",
    always: "Always approve",
    deny: "Deny",
    web: "Open on web",
    connect: "Connect",
    bind: "Link account",
  },
} as const;

const LABEL_MAX = 60;
const clip = (s: string) => {
  const chars = [...s];
  return chars.length > LABEL_MAX ? `${chars.slice(0, LABEL_MAX - 1).join("")}…` : s;
};

function isHttp(v: string): boolean {
  try {
    const p = new URL(v).protocol;
    return p === "https:" || p === "http:";
  } catch {
    return false;
  }
}

const urlButton = (text: string, url: string): Button[] => (isHttp(url) ? [{ text, url }] : []);

/** Card text without the line that carries the card's link (it becomes a URL button). */
function cardText(card: ChannelCard, locale: Locale): string {
  const url = card.kind === "connect" || card.kind === "bind" ? card.url : card.webUrl;
  const lines = renderCardAsText(card, locale).split("\n");
  if (lines.length > 1 && lines[lines.length - 1]?.endsWith(url)) lines.pop();
  return markdownToTelegramHtml(lines.join("\n"));
}

async function callbackButton(
  tokens: CardTokenStore,
  text: string,
  action: CardAction,
): Promise<Button[]> {
  try {
    return [{ text: clip(text), callback_data: `${CALLBACK_PREFIX}${await tokens.put(action)}` }];
  } catch {
    return [];
  }
}

async function keyboard(
  card: ChannelCard,
  locale: Locale,
  tokens: CardTokenStore,
): Promise<Button[][]> {
  const t = T[locale];
  switch (card.kind) {
    case "approval": {
      if (card.state !== "pending") return [urlButton(t.web, card.webUrl)];
      const rows: Button[][] = [];
      const decide: Button[] = [];
      for (const scope of card.scopes) {
        decide.push(
          ...(await callbackButton(tokens, t[scope], {
            cardKind: "approval",
            cardId: card.id,
            action: "approve",
            scope,
          })),
        );
      }
      decide.push(
        ...(await callbackButton(tokens, t.deny, {
          cardKind: "approval",
          cardId: card.id,
          action: "deny",
        })),
      );
      // One button per row: the labels are long.
      for (const b of decide) rows.push([b]);
      rows.push(urlButton(t.web, card.webUrl));
      return rows;
    }
    case "question": {
      const f = card.form.fields[0];
      const rows: Button[][] = [];
      if (
        card.state === "pending" &&
        f &&
        !f.multiSelect &&
        questionRenderableInline(card.form) &&
        "enum" in f.schema
      ) {
        for (const option of f.schema.enum) {
          rows.push(
            await callbackButton(tokens, option, {
              cardKind: "question",
              cardId: card.id,
              action: "answer",
              answer: { [f.key]: option },
            }),
          );
        }
      }
      rows.push(urlButton(t.web, card.webUrl));
      return rows;
    }
    case "connect":
      return [urlButton(t.connect, card.url)];
    case "bind":
      return [urlButton(t.bind, card.url)];
  }
}

const textOf = (t: string | { zh: string; en: string }, locale: Locale) =>
  typeof t === "string" ? t : t[locale];

/**
 * The line a card leads with, when the kernel may also send it as the message text (the bind
 * prompt is both): `render` then drops the text so it is not posted twice (as Slack and Lark do).
 */
export function cardHeadline(card: ChannelCard, locale: Locale): string | undefined {
  switch (card.kind) {
    case "approval":
      return card.title;
    case "question":
      return textOf(card.form.title, locale);
    case "bind":
      return card.text;
    case "connect":
      return undefined;
  }
}

/** One post per card: HTML text and an inline keyboard (no keyboard when no button applies). */
export async function renderCards(
  cards: ChannelCard[],
  locale: Locale,
  tokens: CardTokenStore,
): Promise<TelegramPost[]> {
  const posts: TelegramPost[] = [];
  for (const card of cards) {
    const rows = (await keyboard(card, locale, tokens)).filter((r) => r.length > 0);
    posts.push({
      html: cardText(card, locale),
      ...(rows.length > 0 && { replyMarkup: { inline_keyboard: rows } }),
    });
  }
  return posts;
}
