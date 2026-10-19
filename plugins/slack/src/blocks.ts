import {
  type ChannelCard,
  ChannelSendError,
  type OutboundMessage,
  questionRenderableInline,
  renderCardAsText,
} from "@capybara-hq/plugin-sdk";
import {
  encodeActionValue,
  MULTI_SELECT_ACTION,
  MULTI_SUBMIT_ACTION,
  multiBlockId,
} from "./actions.js";
import { markdownToMrkdwn, splitMrkdwn } from "./mrkdwn.js";

/**
 * 消息与卡片 → Slack 消息（`text` + Block Kit `blocks`）。Slack 的限制（2026-10-20 查阅）：
 * - `text`：chat.update 不得超过 4000 字符（`msg_too_long`）；chat.postMessage 建议 ≤ 4000、超过 40000 截断
 *   （https://docs.slack.dev/reference/methods/chat.update 、https://docs.slack.dev/reference/methods/chat.postMessage ）。
 *   所以每条消息的文本取 4000 为上限，超长按 {@link splitMrkdwn} 拆成多条。
 * - section 块的 `text` ≤ 3000、`fields` 每项 ≤ 2000、`block_id` ≤ 255
 *   （https://docs.slack.dev/reference/block-kit/blocks/section-block ）。
 * - 按钮文字 ≤ 75、`action_id` ≤ 255、`value` ≤ 2000、`url` ≤ 3000；链接按钮被点也会收到交互负载、要确认
 *   （https://docs.slack.dev/reference/block-kit/block-elements/button-element ）。
 * - 勾选框最多 10 项（https://docs.slack.dev/reference/block-kit/block-elements/checkboxes-element ）。
 */

export type Block = Record<string, unknown>;
export interface SlackPost {
  text: string;
  blocks?: Block[];
}

/** 一条消息 `text` 的上限。 */
export const TEXT_LIMIT = 4000;
/** section 块文本的上限。 */
export const SECTION_TEXT_LIMIT = 3000;
const FIELD_LIMIT = 2000;
const PLAIN_LIMIT = 75;

type Locale = "zh" | "en";

const T = {
  en: {
    sep: ": ",
    approval: "Approval",
    question: "Question",
    tool: "Tool",
    agent: "Agent",
    input: "Input",
    status: "Status",
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
    details: "Details",
    connect: "Connect",
    connectText: (app: string) => `*${app}* needs to be connected.`,
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
    expires: "过期时间",
    answer: "回答",
    approve: { once: "批准一次", session: "本会话内批准", always: "始终批准" },
    deny: "拒绝",
    openWeb: "在网页上打开",
    answerOnWeb: "到网页上回答",
    submit: "提交",
    details: "详情",
    connect: "连接",
    connectText: (app: string) => `需要连接 *${app}*。`,
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

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** 截到 `n` 个码元以内（末尾加省略号，不拆代理对）。 */
function trunc(s: string, n: number): string {
  if (s.length <= n) return s;
  let at = n - 1;
  const c = s.charCodeAt(at - 1);
  if (c >= 0xd800 && c <= 0xdbff) at--;
  return `${s.slice(0, at)}…`;
}

const plain = (text: string) => ({
  type: "plain_text",
  text: trunc(text, PLAIN_LIMIT),
  emoji: true,
});
const md = (text: string, limit = SECTION_TEXT_LIMIT) => ({
  type: "mrkdwn",
  text: trunc(text, limit),
});
const section = (text: string): Block => ({ type: "section", text: md(text) });
const context = (text: string): Block => ({ type: "context", elements: [md(text)] });
const actions = (elements: Block[], blockId?: string): Block => ({
  type: "actions",
  ...(blockId !== undefined && { block_id: blockId }),
  elements,
});
const link = (actionId: string, label: string, url: string): Block => ({
  type: "button",
  action_id: actionId,
  text: plain(label),
  url,
});
const button = (
  actionId: string,
  label: string,
  value: string,
  style?: "primary" | "danger",
): Block => ({
  type: "button",
  action_id: actionId,
  text: plain(label),
  value,
  ...(style !== undefined && { style }),
});

const textOf = (t: string | { zh: string; en: string }, locale: Locale) =>
  typeof t === "string" ? t : t[locale];

/** Slack 日期格式化（客户端按查看者时区显示，退回文本为原 ISO 时间）。 */
function slackDate(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return esc(iso);
  return `<!date^${Math.floor(ms / 1000)}^{date_short_pretty} {time}|${esc(iso)}>`;
}

function approvalBlocks(c: Extract<ChannelCard, { kind: "approval" }>, locale: Locale): Block[] {
  const t = T[locale];
  const tool = c.appName ? `${c.appName} / ${c.toolName}` : c.toolName;
  const blocks: Block[] = [
    section(`*${t.approval}${t.sep}${esc(c.title)}*`),
    {
      type: "section",
      fields: [
        md(`*${t.tool}*\n${esc(tool)}`, FIELD_LIMIT),
        md(`*${t.agent}*\n${esc(c.agentName)}`, FIELD_LIMIT),
      ],
    },
  ];
  if (c.inputPreview !== "") {
    const head = `*${t.input}*\n\`\`\`\n`;
    const tail = "\n```";
    const body = trunc(esc(c.inputPreview), SECTION_TEXT_LIMIT - head.length - tail.length);
    blocks.push(section(`${head}${body}${tail}`));
  }
  if (c.state !== "pending") {
    const state = t.approvalStates[c.state];
    const by = c.decidedBy ? ` (${esc(c.decidedBy)})` : "";
    blocks.push(context(`${t.status}${t.sep}${state}${by}`));
    blocks.push(actions([link("cap_link_web", t.details, c.webUrl)]));
    return blocks;
  }
  blocks.push(context(`${t.expires}${t.sep}${slackDate(c.expiresAt)}`));
  const web = link("cap_link_web", t.openWeb, c.webUrl);
  try {
    const scopes = [...c.scopes].sort((a, b) => SCOPE_ORDER[a] - SCOPE_ORDER[b]);
    const els = scopes.map((scope, i) =>
      button(
        `cap_a_${scope}`,
        t.approve[scope],
        encodeActionValue({ k: "a", id: c.id, action: "approve", scope }),
        i === 0 ? "primary" : undefined,
      ),
    );
    els.push(
      button(
        "cap_a_deny",
        t.deny,
        encodeActionValue({ k: "a", id: c.id, action: "deny" }),
        "danger",
      ),
    );
    blocks.push(actions([...els, web]));
  } catch {
    // 按钮值超长（卡片 id 异常）：只给网页链接
    blocks.push(actions([web]));
  }
  return blocks;
}

function questionInputs(c: Extract<ChannelCard, { kind: "question" }>, locale: Locale): Block[] {
  const t = T[locale];
  const web = link("cap_link_web", t.answerOnWeb, c.webUrl);
  const f = c.form.fields[0];
  if (!questionRenderableInline(c.form) || !f || !("enum" in f.schema)) return [actions([web])];
  const options = f.schema.enum;
  try {
    if (!f.multiSelect) {
      const els = options.map((o, i) =>
        button(`cap_q_${i}`, o, encodeActionValue({ k: "q", id: c.id, key: f.key, value: o })),
      );
      return [actions([...els, web])];
    }
    const blockId = multiBlockId(c.id);
    if (blockId.length > 255) return [actions([web])];
    const submit = button(
      MULTI_SUBMIT_ACTION,
      t.submit,
      encodeActionValue({ k: "m", id: c.id, key: f.key, options }),
      "primary",
    );
    return [
      actions(
        [
          {
            type: "checkboxes",
            action_id: MULTI_SELECT_ACTION,
            options: options.map((o, i) => ({ text: plain(o), value: String(i) })),
          },
        ],
        blockId,
      ),
      actions([submit, web]),
    ];
  } catch {
    // 选项太长、装不进按钮值：只给网页链接
    return [actions([web])];
  }
}

function questionBlocks(c: Extract<ChannelCard, { kind: "question" }>, locale: Locale): Block[] {
  const t = T[locale];
  const title = textOf(c.form.title, locale);
  const f = c.form.fields[0];
  const lines = [`*${t.question}${t.sep}${esc(title)}*`];
  if (f && c.form.fields.length === 1) {
    const label = textOf(f.label, locale);
    if (label !== title) lines.push(esc(label));
    if (f.description !== undefined) lines.push(`_${esc(textOf(f.description, locale))}_`);
  }
  const blocks: Block[] = [section(lines.join("\n"))];
  if (c.state === "pending") return [...blocks, ...questionInputs(c, locale)];
  const status = `${t.status}${t.sep}${t.questionStates[c.state]}`;
  const answer = c.answerSummary ? `\n${t.answer}${t.sep}${esc(c.answerSummary)}` : "";
  blocks.push(context(`${status}${answer}`));
  blocks.push(actions([link("cap_link_web", t.details, c.webUrl)]));
  return blocks;
}

/** 一张卡片 → Block Kit blocks（按钮文字与固定词按 locale）。 */
export function renderCard(card: ChannelCard, locale: Locale): Block[] {
  const t = T[locale] ?? T.en;
  switch (card.kind) {
    case "approval":
      return approvalBlocks(card, locale);
    case "question":
      return questionBlocks(card, locale);
    case "connect":
      return [
        section(t.connectText(esc(card.appName))),
        actions([link("cap_link_connect", t.connect, card.url)]),
      ];
    case "bind":
      return [section(esc(card.text)), actions([link("cap_link_bind", t.bind, card.url)])];
  }
}

/** 卡片自身已显示的标题（随附文本与它相同时不再单独显示一遍）。 */
function cardHeadline(card: ChannelCard, locale: Locale): string | undefined {
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

/**
 * 一条出站消息 → 按序发送的若干条 Slack 消息。文本先转 mrkdwn：没有卡片时按 4000 拆；有卡片时按 3000 拆
 * （最后一段要放进 section 块），卡片挂在最后一条上（发送方返回的就是这条的 id，之后更新卡片编辑的也是它）。
 * 带 blocks 的消息 `text` 作通知 / 无障碍的退回文本。
 */
export function renderSend(message: OutboundMessage, locale: Locale): SlackPost[] {
  const mrkdwn = markdownToMrkdwn(message.text);
  const cards = message.cards ?? [];
  if (cards.length === 0) {
    if (mrkdwn.trim() === "") return [{ text: "…" }];
    return splitMrkdwn(mrkdwn, TEXT_LIMIT).map((text) => ({ text }));
  }
  const chunks = mrkdwn.trim() === "" ? [] : splitMrkdwn(mrkdwn, SECTION_TEXT_LIMIT);
  const last = chunks.pop();
  const posts: SlackPost[] = chunks.map((text) => ({ text }));
  const dup = cards.some((c) => cardHeadline(c, locale)?.trim() === message.text.trim());
  const blocks: Block[] = last !== undefined && !dup ? [section(last)] : [];
  cards.forEach((c, i) => {
    if (i > 0) blocks.push({ type: "divider" });
    blocks.push(...renderCard(c, locale));
  });
  const fallback = last ?? cards.map((c) => renderCardAsText(c, locale)).join("\n\n");
  posts.push({ text: trunc(fallback, TEXT_LIMIT), blocks });
  return posts;
}

/**
 * 编辑用：必须装进一条消息，否则抛不可重试的 `too_large`（内核改为把完整文本作为新消息发送，由 send 拆分）。
 */
export function renderUpdate(message: OutboundMessage, locale: Locale): SlackPost {
  const posts = renderSend(message, locale);
  const only = posts[0];
  if (posts.length !== 1 || !only) {
    throw new ChannelSendError("message too long for a single Slack message", {
      retryable: false,
      reason: "too_large",
    });
  }
  return only;
}
