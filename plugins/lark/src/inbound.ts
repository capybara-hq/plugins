import type { ChannelTarget, InboundEvent } from "@capybara-hq/plugin-sdk";

/**
 * Lark 事件（schema 2.0，经长连接到达）→ 入站事件。依据（均 2026-10-20 查阅）：
 * - 接收消息 `im.message.receive_v1`：https://open.larksuite.com/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message/events/receive
 *   （`message_id` / `root_id` / `parent_id` / `thread_id` / `chat_type`（`p2p` | `group`）/ `mentions`；
 *   `sender.sender_type` 目前只有 `user`；「特殊情况下可能会收到重复的推送，请用 message_id 去重，不要依赖 event_id」）；
 * - 消息内容格式：https://open.larksuite.com/document/uAjLw4CM/ukTMukTMukTM/im-v1/message/events/message_content
 *   （文本里的 @ 被替换成 `@_user_N`，详细信息在 `mentions` 里按 key 查；富文本 post 为按行的元素数组）；
 * - 通讯录 `contact.user.created_v3` / `updated_v3` / `deleted_v3`：
 *   https://open.larksuite.com/document/uAjLw4CM/ukTMukTMukTM/reference/contact-v3/user/events/created （及 updated / deleted）。
 * 用户撤回（`im.message.recalled_v1`）、表情回复等其他事件不处理（返回 null）。Lark 没有「编辑消息」的
 * `receive_v1` 重投，故不会把编辑当新消息。
 */

export type InboundCandidate =
  | {
      kind: "message";
      /** 发言人 open_id（调用方据此查显示名 / 头像）。 */
      openId: string;
      event: Extract<InboundEvent, { type: "message" }>;
    }
  | { kind: "directory"; event: Extract<InboundEvent, { type: "directory_changed" }> };

export interface LarkMention {
  key?: unknown;
  id?: { open_id?: unknown } | unknown;
  name?: unknown;
}

const obj = (v: unknown): Record<string, unknown> | undefined =>
  typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
const str = (v: unknown) => (typeof v === "string" && v !== "" ? v : undefined);

const DIRECTORY_EVENTS: Record<string, true> = {
  "contact.user.created_v3": true,
  "contact.user.updated_v3": true,
  "contact.user.deleted_v3": true,
};

/**
 * 处理 `@_user_N` 占位：@ 机器人的连同两侧同一行内的空格换成一个空格（在行首 / 行尾时直接去掉），其他人换成
 * `@名字`（查不到的占位原样保留）；最后去掉首尾空白。换行、缩进（如代码块）保留。
 */
export function stripMentions(
  text: string,
  mentions: readonly LarkMention[] | undefined,
  botOpenId: string,
): { text: string; mentionsBot: boolean } {
  const byKey = new Map<string, { openId: string | undefined; name: string | undefined }>();
  for (const m of mentions ?? []) {
    const key = str(m.key);
    if (!key) continue;
    byKey.set(key, { openId: str(obj(m.id)?.open_id), name: str(m.name) });
  }
  let mentionsBot = false;
  for (const v of byKey.values()) if (v.openId === botOpenId) mentionsBot = true;
  const out = text
    .replace(/[ \t]*@_user_\d+[ \t]*/g, (m, at: number, s: string) => {
      const key = /@_user_\d+/.exec(m)?.[0] ?? "";
      const who = byKey.get(key);
      if (who?.openId !== botOpenId || who === undefined) {
        const lead = m.slice(0, m.indexOf("@"));
        const trail = m.slice(m.indexOf(key) + key.length);
        const shown = who?.name !== undefined ? `@${who.name}` : key;
        return `${lead}${shown}${trail}`;
      }
      const lineStart = at === 0 || s[at - 1] === "\n";
      const after = s[at + m.length];
      const lineEnd = after === undefined || after === "\n";
      return lineStart || lineEnd ? "" : " ";
    })
    .trim();
  return { text: out, mentionsBot };
}

const isHttp = (u: string) => /^https?:\/\//i.test(u);

/**
 * 富文本（post）→ 纯文本：标题一行，之后每行元素拼接；`text` 原文、`a` → `[文字](地址)`（只对 http(s)）、
 * `at` → 占位（再按 {@link stripMentions} 处理）、`code_block` → 带语言标注的 ``` 代码块、`emotion` → `:类型:`、
 * `hr` → `---`；图片 / 视频忽略（只剩它们的行去掉）。兼容发送格式里按语言包一层的写法（`{ zh_cn: {…} }`）。
 */
export function postToText(
  content: unknown,
  mentions: readonly LarkMention[] | undefined,
  botOpenId: string,
): { text: string; mentionsBot: boolean } {
  let post = obj(content);
  if (post && !Array.isArray(post.content)) {
    post = Object.values(post)
      .map(obj)
      .find((v) => Array.isArray(v?.content));
  }
  const lines: string[] = [];
  const title = str(post?.title);
  if (title) lines.push(title);
  for (const row of (post?.content as unknown[] | undefined) ?? []) {
    if (!Array.isArray(row)) continue;
    let line = "";
    const block: string[] = [];
    for (const el of row) {
      const e = obj(el);
      switch (e?.tag) {
        case "text":
          line += typeof e.text === "string" ? e.text : "";
          break;
        case "a": {
          const text = typeof e.text === "string" ? e.text : "";
          const href = str(e.href);
          line += href && isHttp(href) ? `[${text || href}](${href})` : text;
          break;
        }
        case "at": {
          const id = str(e.user_id);
          if (id === "all") line += "@all";
          else if (id) line += id;
          break;
        }
        case "emotion":
          if (str(e.emoji_type)) line += `:${e.emoji_type}:`;
          break;
        case "hr":
          block.push("---");
          break;
        case "code_block": {
          const lang = (str(e.language) ?? "").toLowerCase();
          block.push(`\`\`\`${lang}`, typeof e.text === "string" ? e.text : "", "```");
          break;
        }
        default:
          break;
      }
    }
    if (line.trim() !== "") lines.push(line);
    lines.push(...block);
  }
  return stripMentions(lines.join("\n"), mentions, botOpenId);
}

function messageText(
  type: unknown,
  content: unknown,
  mentions: readonly LarkMention[] | undefined,
  botOpenId: string,
): { text: string; mentionsBot: boolean } | null {
  if (type !== "text" && type !== "post") return null;
  if (typeof content !== "string") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }
  if (type === "text") {
    const t = obj(parsed)?.text;
    return typeof t === "string" ? stripMentions(t, mentions, botOpenId) : null;
  }
  return postToText(parsed, mentions, botOpenId);
}

/**
 * Lark 事件负载 → 入站事件候选。规则：
 * - `im.message.receive_v1`：只收 `sender_type = user` 的；发言人是机器人自己、没有 open_id 的忽略；只处理
 *   `text` 与 `post`（按文本），其他类型（图片、文件、卡片…）忽略；去掉 @ 机器人后没有文本的忽略。
 *   私聊（`p2p`）全收；群聊（`group`）收 @ 了机器人的，以及话题 / 回复链里（有 `root_id`）未 @ 的
 *   （`mentionsBot = false`，内核目前只处理 @ 了的），顶层未 @ 的忽略。
 * - `messageId` = `message_id`（`om_…`，连接内唯一）；群聊 `threadId` = `root_id`（话题根消息的 `om_…`，
 *   **不是** `thread_id` 的 `omt_…`），顶层消息不带（内核以这条消息为新话题的根）。
 * - 发言人租户 = `sender.tenant_key`（外部联系人为其所属企业），缺省时取 `header.tenant_key`。
 * - 通讯录人员增 / 改 / 删 → `directory_changed`（租户为 `header.tenant_key`）。
 */
export function eventToInbound(payload: unknown, botOpenId: string): InboundCandidate | null {
  const p = obj(payload);
  const header = obj(p?.header);
  const event = obj(p?.event);
  if (!header || !event) return null;
  const type = header.event_type;
  const headerTenant = str(header.tenant_key);
  if (typeof type === "string" && DIRECTORY_EVENTS[type]) {
    if (!headerTenant) return null;
    return { kind: "directory", event: { type: "directory_changed", tenantId: headerTenant } };
  }
  if (type !== "im.message.receive_v1") return null;
  const sender = obj(event.sender);
  const message = obj(event.message);
  if (!sender || !message || sender.sender_type !== "user") return null;
  const openId = str(obj(sender.sender_id)?.open_id);
  const tenantId = str(sender.tenant_key) ?? headerTenant;
  const messageId = str(message.message_id);
  const chatId = str(message.chat_id);
  if (!openId || openId === botOpenId || !tenantId || !messageId || !chatId) return null;
  const chatType = message.chat_type;
  if (chatType !== "p2p" && chatType !== "group") return null;
  const mentions = Array.isArray(message.mentions) ? (message.mentions as LarkMention[]) : [];
  const t = messageText(message.message_type, message.content, mentions, botOpenId);
  if (!t || t.text === "") return null;
  const dm = chatType === "p2p";
  const rootId = str(message.root_id);
  const inThread = rootId !== undefined && rootId !== messageId;
  if (!dm && !t.mentionsBot && !inThread) return null;
  const target: ChannelTarget = dm
    ? { chatId, chatType: "dm" }
    : { chatId, chatType: "group", ...(inThread && { threadId: rootId }) };
  return {
    kind: "message",
    openId,
    event: {
      type: "message",
      messageId,
      target,
      sender: { externalId: openId, tenantId },
      text: t.text,
      mentionsBot: !dm && t.mentionsBot,
    },
  };
}
