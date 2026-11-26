import {
  type CardAction,
  type ChannelCard,
  type Locale,
  type Logger,
  questionRenderableInline,
  renderCardAsText,
} from "@capybara-hq/plugin-sdk";
import { CALLBACK_PREFIX, type CardTokenStore } from "./actions.js";
import { escapeHtml, htmlLink, markdownToTelegramHtml } from "./html.js";

export interface TelegramPost {
  html: string;
  replyMarkup?: { inline_keyboard: unknown[][] };
  /**
   * The same card without URL buttons, its link kept in the text (callback buttons stay). Telegram
   * rejects some button URLs (`http://localhost/...`: "Wrong HTTP URL") that it accepts as text.
   */
  withoutUrlButtons?: TelegramPost;
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

const STEP_MAX = 300;

/**
 * The run's progress card as HTML: the title (+ meta) in bold, the status line and the pinned text
 * as Markdown (model and extension text, like an answer), the latest steps in a `<pre>` block
 * (model-written arguments: never links or mentions), and the links (pending actions, then the web
 * link) as the HTML for when Telegram rejects the URL buttons. A finished card carries fewer
 * fields; only the ones present are drawn.
 */
function progressText(c: Extract<ChannelCard, { kind: "progress" }>): {
  body: string;
  linkLine: string;
} {
  const parts = [
    c.meta
      ? `<b>${escapeHtml(c.title)}</b> · ${escapeHtml(c.meta)}`
      : `<b>${escapeHtml(c.title)}</b>`,
  ];
  if (c.status) parts.push(markdownToTelegramHtml(c.status));
  if (c.pinned) parts.push(markdownToTelegramHtml(c.pinned));
  // a step that is only whitespace draws nothing: no empty lines, no empty <pre>
  const kept = c.steps.map((x) => x.replace(/\s+/g, " ").trim()).filter((x) => x !== "");
  if (kept.length > 0) {
    const steps = kept.map((x) => {
      const chars = [...x];
      return chars.length > STEP_MAX ? `${chars.slice(0, STEP_MAX - 1).join("")}…` : chars.join("");
    });
    parts.push(`<pre>${escapeHtml(steps.join("\n"))}</pre>`);
  }
  const links = [
    ...c.pending.map((p) => ({ text: p.text, url: p.url })),
    { text: c.urlText, url: c.url },
  ];
  return {
    body: parts.join("\n"),
    linkLine: links.map((l) => `${escapeHtml(l.text)}: ${htmlLink(l.url)}`).join("\n"),
  };
}

/** The SDK's text form of a card, never a throw (a card kind this plugin does not know). */
function safeCardAsText(card: ChannelCard, locale: Locale): string {
  try {
    const text: unknown = renderCardAsText(card, locale);
    return typeof text === "string" && text !== "" ? text : "…";
  } catch {
    return "…";
  }
}

/**
 * Card text without the line that carries the card's link (it becomes a URL button), and that line
 * as HTML with the link, for when Telegram rejects the button. The link line is the last one, or
 * the one before a pending question's text-reply hint. A card kind this plugin does not know (a
 * newer kernel) is the SDK's text form, without buttons.
 */
function cardText(card: ChannelCard, locale: Locale): { body: string; linkLine?: string } {
  let url: string;
  switch (card.kind) {
    case "progress":
      return progressText(card);
    case "connect":
    case "bind":
      url = card.url;
      break;
    case "approval":
    case "question":
      url = card.webUrl;
      break;
    default:
      return { body: markdownToTelegramHtml(safeCardAsText(card, locale)) };
  }
  const lines = renderCardAsText(card, locale).split("\n");
  let at = lines.length - 1;
  if (card.kind === "question" && card.state === "pending" && card.textReply !== undefined) at--;
  const line = lines[at];
  if (at > 0 && line?.endsWith(url)) {
    lines.splice(at, 1);
    const label = markdownToTelegramHtml(line.slice(0, line.length - url.length));
    return { body: markdownToTelegramHtml(lines.join("\n")), linkLine: `${label}${htmlLink(url)}` };
  }
  return { body: markdownToTelegramHtml(lines.join("\n")) };
}

/** Where a card button's action is stored, and where a failed store is reported. */
interface ButtonContext {
  tokens: CardTokenStore;
  log: Logger;
}

async function callbackButton(
  b: ButtonContext,
  text: string,
  action: CardAction,
): Promise<Button[]> {
  try {
    return [{ text: clip(text), callback_data: `${CALLBACK_PREFIX}${await b.tokens.put(action)}` }];
  } catch {
    b.log.warn("telegram: could not store a card button's action; the button is left out", {
      cardKind: action.cardKind,
      cardId: action.cardId,
    });
    return [];
  }
}

/** A card kind this plugin does not know (a newer kernel) gets no buttons; `never` keeps the
 * switch above exhaustive for the kinds this SDK has. */
const noButtons = (_card: never): Button[][] => [];

async function keyboard(
  card: ChannelCard,
  locale: Locale,
  tokens: ButtonContext,
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
        // With textReply the Other path is a plain reply: a field with allowOther still gets its
        // option buttons, never an Other button.
        questionRenderableInline(card.form, { textReply: card.textReply !== undefined }) &&
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
    case "progress":
      // one link per row: pending actions first, then the run on the web
      return [
        ...card.pending.map((p) => urlButton(clip(p.text), p.url)),
        urlButton(clip(card.urlText), card.url),
      ];
    default:
      return noButtons(card);
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
    case "progress":
      // the kernel sends the progress card with its title as the text
      return card.title;
    default:
      return undefined;
  }
}

const markup = (rows: Button[][]) => {
  const kept = rows.filter((r) => r.length > 0);
  return kept.length > 0 ? { replyMarkup: { inline_keyboard: kept } } : {};
};

/**
 * One post per card: HTML text and an inline keyboard (no keyboard when no button applies), plus
 * the post without URL buttons when it has any (see {@link TelegramPost.withoutUrlButtons}).
 */
export async function renderCards(
  cards: ChannelCard[],
  locale: Locale,
  tokens: CardTokenStore,
  log: Logger,
): Promise<TelegramPost[]> {
  const posts: TelegramPost[] = [];
  for (const card of cards) {
    const rows = await keyboard(card, locale, { tokens, log });
    const { body, linkLine } = cardText(card, locale);
    const hasUrlButton = rows.some((r) => r.some((b) => "url" in b));
    posts.push({
      html: body,
      ...markup(rows),
      ...(hasUrlButton &&
        linkLine !== undefined && {
          withoutUrlButtons: {
            html: body === "" ? linkLine : `${body}\n${linkLine}`,
            ...markup(rows.map((r) => r.filter((b) => !("url" in b)))),
          },
        }),
    });
  }
  return posts;
}
