import {
  type ChannelCard,
  ChannelSendError,
  type OutboundMessage,
  questionRenderableInline,
} from "@capybara-hq/plugin-sdk";
import {
  type ActionValue,
  type ChatKind,
  encodeActionValue,
  FORM_NAME,
  MULTI_FIELD,
  SUBMIT_NAME,
  VALUE_KEY,
} from "./actions.js";
import { codeSafe, escapePlain, neutralizeAt, splitMarkdown, toCardMarkdown } from "./markdown.js";

/**
 * 出站消息 → Lark 交互卡片（JSON 2.0）。**所有消息都发成卡片**（`msg_type: interactive`）：
 * - 更新统一走「更新应用发送的消息卡片」PATCH（https://open.larksuite.com/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message/patch ）：
 *   单条消息 5 QPS、14 天内可改，没有总次数上限；而文本 / 富文本的「编辑消息」PUT 一条最多改 20 次（230072，
 *   https://open.larksuite.com/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message/update ），流式草稿很快就会用完。
 * - 卡片富文本支持完整 Markdown（见 markdown.ts），模型回复不必降级。
 * 卡片结构（https://open.larksuite.com/document/uAjLw4CM/ukzMukzMukzM/feishu-cards/card-json-v2-structure ）：
 * `config.update_multi` 只能为 true（共享卡片，PATCH 的前提）；`config.summary` 是会话列表 / 通知里的预览文本
 * （纯文本，不解析标签）；一张卡片最多 200 个组件。按钮（…/card-json-v2-components/interactive-components/button）
 * 文本最多 100 字符，`behaviors` 为 `callback`（回传值）或 `open_url`（只用 http(s)）。多选提问用表单容器
 * （…/containers/form-container）里的多选下拉（…/interactive-components/multi-select-dropdown-menu）+ 提交按钮。
 * 以上均 2026-10-20 查阅。
 *
 * 大小：卡片消息请求体最多 30 KB（230025）。卡片 JSON 作为字符串再嵌进请求 JSON，最坏情况下（`"`、`\`、
 * 实体转义的 `<` / `&`）一个 UTF-16 码元约占 5 字节，所以每张卡片的正文最多 {@link TEXT_LIMIT} 个码元，
 * 另以 {@link contentBytes} 兜底核对。
 */

export type LarkCard = Record<string, unknown>;
type El = Record<string, unknown>;
type Locale = "zh" | "en";

/** 每张卡片 Markdown 正文的上限（UTF-16 码元）。 */
export const TEXT_LIMIT = 5000;
/** 卡片消息请求体的上限（字节）。 */
export const CONTENT_BYTES_LIMIT = 30_000;
const PREVIEW_LIMIT = 1500;
const BUTTON_TEXT_LIMIT = 100;
const SUMMARY_LIMIT = 120;
const URL_LIMIT = 2000;

const T = {
  en: {
    sep: ": ",
    approval: "Approval",
    question: "Question",
    tool: "Tool",
    agent: "Agent",
    input: "Input",
    status: "Status",
    reason: "Reason",
    expires: "Expires",
    answer: "Answer",
    approve: {
      once: "Approve once",
      session: "Approve for this session",
      always: "Always approve",
    },
    deny: "Deny",
    openWeb: "Open on web",
    answerOnWeb: "Answer on the web",
    submit: "Submit",
    choose: "Choose…",
    details: "Details",
    connect: "Connect",
    connectText: (app: string) => `**${app}** needs to be connected.`,
    bind: "Link account",
    approvalStates: {
      pending: "Pending",
      approved: "Approved",
      denied: "Denied",
      expired: "Expired",
      cancelled: "Cancelled",
    },
    questionStates: {
      pending: "Pending",
      answered: "Answered",
      expired: "Expired",
      cancelled: "Cancelled",
    },
  },
  zh: {
    sep: "：",
    approval: "审批",
    question: "提问",
    tool: "工具",
    agent: "Agent",
    input: "输入",
    status: "状态",
    reason: "原因",
    expires: "过期时间",
    answer: "回答",
    approve: { once: "批准一次", session: "本会话内批准", always: "始终批准" },
    deny: "拒绝",
    openWeb: "在网页上打开",
    answerOnWeb: "到网页上回答",
    submit: "提交",
    choose: "请选择…",
    details: "详情",
    connect: "连接",
    connectText: (app: string) => `需要连接 **${app}**。`,
    bind: "绑定账号",
    approvalStates: {
      pending: "待审批",
      approved: "已批准",
      denied: "已拒绝",
      expired: "已过期",
      cancelled: "已取消",
    },
    questionStates: {
      pending: "待回答",
      answered: "已回答",
      expired: "已过期",
      cancelled: "已取消",
    },
  },
} as const;

const SCOPE_ORDER = { once: 0, session: 1, always: 2 } as const;
const APPROVAL_COLOR = {
  pending: "orange",
  approved: "green",
  denied: "red",
  expired: "grey",
  cancelled: "grey",
} as const;
const QUESTION_COLOR = {
  pending: "blue",
  answered: "green",
  expired: "grey",
  cancelled: "grey",
} as const;

/** 截到 `n` 个码元以内（末尾加省略号），不拆代理对。 */
function trunc(s: string, n: number): string {
  if (s.length <= n) return s;
  let at = n - 1;
  const c = s.charCodeAt(at - 1);
  if (c >= 0xd800 && c <= 0xdbff) at--;
  return `${s.slice(0, at)}…`;
}

const textOf = (t: string | { zh: string; en: string }, locale: Locale) =>
  typeof t === "string" ? t : t[locale];

/** 纯文本元素（不解析标签；`<at` 仍兜底拆开）。 */
const plain = (content: string) => ({ tag: "plain_text", content: neutralizeAt(content) });
const md = (content: string): El => ({ tag: "markdown", content });

function isHttpUrl(v: string): boolean {
  if (v.length > URL_LIMIT) return false;
  try {
    const u = new URL(v);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
}

/** 按钮行：`column_set` 流式排列，放不下自动换行。 */
const row = (buttons: El[]): El => ({
  tag: "column_set",
  flex_mode: "flow",
  horizontal_spacing: "8px",
  columns: buttons.map((b) => ({ tag: "column", width: "auto", elements: [b] })),
});

const callbackButton = (
  label: string,
  value: ActionValue,
  type: "primary" | "danger" | "default" = "default",
): El => ({
  tag: "button",
  text: plain(trunc(label, BUTTON_TEXT_LIMIT)),
  type,
  behaviors: [{ type: "callback", value: { [VALUE_KEY]: encodeActionValue(value) } }],
});

/**
 * 链接：http(s) 做成打开链接的按钮；其他地址（`javascript:`、`lark:` 等）不做按钮，以纯文本显示。
 * 返回 `{ button }` 或 `{ text }`，由 {@link links} 归到按钮行与文本里。
 */
function link(label: string, url: string): { button: El } | { text: string } {
  if (isHttpUrl(url)) {
    return {
      button: {
        tag: "button",
        text: plain(trunc(label, BUTTON_TEXT_LIMIT)),
        type: "default",
        behaviors: [{ type: "open_url", default_url: url }],
      },
    };
  }
  return { text: `${escapePlain(label)}${escapePlain(": ")}${escapePlain(trunc(url, 300))}` };
}

/** 回调按钮 + 链接 → 组件（按钮行，加上非 http(s) 链接的纯文本）。 */
function actions(buttons: El[], ...ls: ReturnType<typeof link>[]): El[] {
  const all = [...buttons];
  const texts: string[] = [];
  for (const l of ls) {
    if ("button" in l) all.push(l.button);
    else texts.push(l.text);
  }
  const out: El[] = [];
  if (all.length > 0) out.push(row(all));
  if (texts.length > 0) out.push(md(texts.join("\n")));
  return out;
}

interface Rendered {
  header?: El;
  elements: El[];
  headline?: string;
}

function approval(
  c: Extract<ChannelCard, { kind: "approval" }>,
  locale: Locale,
  chat: ChatKind,
): Rendered {
  const t = T[locale];
  const tool = c.appName ? `${c.appName} / ${c.toolName}` : c.toolName;
  const headline = `${t.approval}${t.sep}${c.title}`;
  const elements: El[] = [
    md(
      `**${t.tool}**${escapePlain(t.sep)}${escapePlain(tool)}\n` +
        `**${t.agent}**${escapePlain(t.sep)}${escapePlain(c.agentName)}`,
    ),
  ];
  if (c.inputPreview !== "") {
    elements.push(
      md(`**${t.input}**\n\`\`\`\n${codeSafe(trunc(c.inputPreview, PREVIEW_LIMIT))}\n\`\`\``),
    );
  }
  if (c.state !== "pending") {
    const state = t.approvalStates[c.state];
    const by = c.decidedBy ? ` (${escapePlain(c.decidedBy)})` : "";
    elements.push(md(`${t.status}${escapePlain(t.sep)}${state}${by}`));
    if (c.state === "denied" && c.denyReason)
      elements.push(md(`${t.reason}${escapePlain(t.sep)}${escapePlain(c.denyReason)}`));
    elements.push(...actions([], link(t.details, c.webUrl)));
  } else {
    elements.push(md(`${t.expires}${escapePlain(t.sep)}${escapePlain(c.expiresAt)}`));
    const web = link(t.openWeb, c.webUrl);
    let buttons: El[];
    try {
      const scopes = [...c.scopes].sort((a, b) => SCOPE_ORDER[a] - SCOPE_ORDER[b]);
      buttons = scopes.map((scope, i) =>
        callbackButton(
          t.approve[scope],
          { k: "a", chat, id: c.id, action: "approve", scope },
          i === 0 ? "primary" : "default",
        ),
      );
      buttons.push(callbackButton(t.deny, { k: "a", chat, id: c.id, action: "deny" }, "danger"));
    } catch {
      // 回传值超长（卡片 id 异常）：只给网页链接
      buttons = [];
    }
    elements.push(...actions(buttons, web));
  }
  return {
    header: { title: plain(trunc(headline, 200)), template: APPROVAL_COLOR[c.state] },
    elements,
    headline: c.title,
  };
}

function questionInputs(
  c: Extract<ChannelCard, { kind: "question" }>,
  locale: Locale,
  chat: ChatKind,
): El[] {
  const t = T[locale];
  const web = link(t.answerOnWeb, c.webUrl);
  const f = c.form.fields[0];
  if (!questionRenderableInline(c.form) || !f || !("enum" in f.schema)) return actions([], web);
  const options = f.schema.enum;
  try {
    if (!f.multiSelect) {
      const buttons = options.map((o) =>
        callbackButton(o, { k: "q", chat, id: c.id, key: f.key, value: o }),
      );
      return actions(buttons, web);
    }
    const submit: El = {
      ...callbackButton(t.submit, { k: "m", chat, id: c.id, key: f.key, options }, "primary"),
      name: SUBMIT_NAME,
      form_action_type: "submit",
    };
    return [
      {
        tag: "form",
        name: FORM_NAME,
        elements: [
          {
            tag: "multi_select_static",
            name: MULTI_FIELD,
            required: false,
            placeholder: plain(t.choose),
            options: options.map((o, i) => ({
              text: plain(trunc(o, BUTTON_TEXT_LIMIT)),
              value: String(i),
            })),
          },
          submit,
        ],
      },
      ...actions([], web),
    ];
  } catch {
    // 选项太长、装不进回传值：只给网页链接
    return actions([], web);
  }
}

function question(
  c: Extract<ChannelCard, { kind: "question" }>,
  locale: Locale,
  chat: ChatKind,
): Rendered {
  const t = T[locale];
  const title = textOf(c.form.title, locale);
  const f = c.form.fields[0];
  const lines: string[] = [];
  if (f && c.form.fields.length === 1) {
    const label = textOf(f.label, locale);
    if (label !== title) lines.push(escapePlain(label));
    if (f.description !== undefined) lines.push(`*${escapePlain(textOf(f.description, locale))}*`);
  }
  const elements: El[] = lines.length > 0 ? [md(lines.join("\n"))] : [];
  if (c.state === "pending") {
    elements.push(...questionInputs(c, locale, chat));
  } else {
    const status = `${t.status}${escapePlain(t.sep)}${t.questionStates[c.state]}`;
    const answer = c.answerSummary
      ? `\n${t.answer}${escapePlain(t.sep)}${escapePlain(c.answerSummary)}`
      : "";
    elements.push(md(`${status}${answer}`));
    elements.push(...actions([], link(t.details, c.webUrl)));
  }
  return {
    header: {
      title: plain(trunc(`${t.question}${t.sep}${title}`, 200)),
      template: QUESTION_COLOR[c.state],
    },
    elements,
    headline: title,
  };
}

function renderOne(card: ChannelCard, locale: Locale, chat: ChatKind): Rendered {
  const t = T[locale];
  switch (card.kind) {
    case "approval":
      return approval(card, locale, chat);
    case "question":
      return question(card, locale, chat);
    case "connect":
      return {
        elements: [
          md(t.connectText(escapePlain(card.appName))),
          ...actions([], link(t.connect, card.url)),
        ],
      };
    case "bind":
      return {
        elements: [md(escapePlain(card.text)), ...actions([], link(t.bind, card.url))],
        headline: card.text,
      };
  }
}

/** 会话列表 / 通知里的预览（纯文本）。 */
const summaryOf = (s: string) =>
  neutralizeAt(trunc(s.replace(/\s+/g, " ").trim(), SUMMARY_LIMIT)) || "…";

const shell = (elements: El[], summary: string, header?: El): LarkCard => ({
  schema: "2.0",
  config: {
    update_multi: true,
    // 转发出去的卡片不可交互（Lark 默认即为 false，显式写明）：按钮回传值可随转发被重放，只能作参考
    enable_forward_interaction: false,
    summary: { content: summaryOf(summary) },
  },
  ...(header !== undefined && { header }),
  body: { elements },
});

/** 一条卡片消息的请求体字节数（`content` 是卡片 JSON 字符串，再整体编码为请求 JSON）。 */
export function contentBytes(card: LarkCard): number {
  return Buffer.byteLength(
    JSON.stringify({ msg_type: "interactive", content: JSON.stringify(card) }),
  );
}

/**
 * 一条出站消息 → 按序发送的若干张卡片（每张一条 Lark 消息）。文本先转卡片 Markdown，按 {@link TEXT_LIMIT} 拆分；
 * 卡片挂在最后一张上（发送方返回的就是这条的 id，之后更新卡片编辑的也是它）。只有一张审批 / 提问卡片时用卡片头
 * 显示其标题；随附文本与卡片标题相同时不重复显示。`chat` 写进按钮回传值（见 actions.ts）。
 */
export function renderSend(
  message: OutboundMessage,
  requested: Locale,
  chat: ChatKind,
): LarkCard[] {
  // 未知的 locale 一律按英文（卡片、按钮、固定词与多语言表单文字同一口径）
  const locale: Locale = requested === "zh" ? "zh" : "en";
  const text = toCardMarkdown(message.text);
  const cards = message.cards ?? [];
  const chunks = text.trim() === "" ? [] : splitMarkdown(text, TEXT_LIMIT);
  if (cards.length === 0) {
    if (chunks.length === 0) return [shell([md("…")], "…")];
    return chunks.map((c) => shell([md(c)], message.text));
  }
  const last = chunks.pop();
  const out = chunks.map((c) => shell([md(c)], message.text));
  const rendered = cards.map((c) => renderOne(c, locale, chat));
  const dup = rendered.some((r) => r.headline?.trim() === message.text.trim());
  const elements: El[] = last !== undefined && !dup ? [md(last)] : [];
  rendered.forEach((r, i) => {
    if (i > 0) elements.push({ tag: "hr" });
    elements.push(...r.elements);
  });
  const only = rendered.length === 1 ? rendered[0] : undefined;
  const header = only?.header;
  const headTitle = (header?.title as { content?: string } | undefined)?.content;
  const summary = message.text.trim() !== "" && !dup ? message.text : (headTitle ?? message.text);
  out.push(shell(elements, summary, header));
  return out;
}

const tooLarge = () =>
  new ChannelSendError("message too long for a single Lark card", {
    retryable: false,
    reason: "too_large",
  });

/** 编辑用：必须装进一张卡片，否则抛不可重试的 `too_large`（内核改为把完整文本作为新消息发送，由 send 拆分）。 */
export function renderUpdate(message: OutboundMessage, locale: Locale, chat: ChatKind): LarkCard {
  const cards = renderSend(message, locale, chat);
  const only = cards[0];
  if (cards.length !== 1 || !only || contentBytes(only) > CONTENT_BYTES_LIMIT) throw tooLarge();
  return only;
}

/** 发送用：拆分后每张卡片仍须在请求体上限内。 */
export function checkSize(card: LarkCard): void {
  if (contentBytes(card) > CONTENT_BYTES_LIMIT) throw tooLarge();
}
