import type { ChannelTarget, InboundEvent } from "@capybara-hq/plugin-sdk";

/** 发言人资料（显示名 / 头像），拿得到就带进 `InboundSender`。 */
export interface SlackProfile {
  displayName?: string;
  avatarUrl?: string;
}

export type InboundCandidate =
  | {
      kind: "message";
      /** 发言人的 Slack user id（事件里没带资料时调用方按它查 users.info）。 */
      userId: string;
      /** 事件自带的 `user_profile`（有就不用再查）。 */
      profile: SlackProfile | undefined;
      event: Extract<InboundEvent, { type: "message" }>;
    }
  | { kind: "directory"; event: Extract<InboundEvent, { type: "directory_changed" }> };

const obj = (v: unknown): Record<string, unknown> | undefined =>
  typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
const str = (v: unknown) => (typeof v === "string" && v !== "" ? v : undefined);

const unescapeSlack = (s: string) =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

/**
 * 去掉文本里 @ 机器人的部分（`<@UBOT>` 或 `<@UBOT|名字>`）：只把 @ 连同两侧空白换成一个空格，再去掉首尾空白；
 * 用户的缩进与换行（如代码块）保留。
 */
export function stripBotMention(text: string, botUserId: string): string {
  const id = botUserId.replace(/[^A-Za-z0-9]/g, "");
  return text.replace(new RegExp(`\\s*<@${id}(\\|[^>]*)?>\\s*`, "g"), " ").trim();
}

/** 按文本处理的 subtype：带说明文字的文件分享（只取文字）、同时发到频道的话题回复。其余 subtype 忽略。 */
const TEXT_SUBTYPES: Record<string, true> = { file_share: true, thread_broadcast: true };

const mentions = (text: string, botUserId: string) =>
  new RegExp(`<@${botUserId.replace(/[^A-Za-z0-9]/g, "")}(\\|[^>]*)?>`).test(text);

/** 资料里的显示名（display_name → real_name）与头像（image_72 → image_48 → image_192）。 */
export function profileOf(p: unknown): SlackProfile | undefined {
  const o = obj(p);
  if (!o) return undefined;
  const displayName = str(o.display_name) ?? str(o.real_name) ?? str(o.name);
  const avatarUrl = str(o.image_72) ?? str(o.image_48) ?? str(o.image_192);
  if (displayName === undefined && avatarUrl === undefined) return undefined;
  return {
    ...(displayName !== undefined && { displayName }),
    ...(avatarUrl !== undefined && { avatarUrl }),
  };
}

/**
 * Events API 负载（`events_api` 信封的 payload）→ 入站事件候选。规则：
 * - `message`（`message.im` 私聊；`message.channels` / `message.groups` 群聊）：带 `subtype` 的（编辑
 *   `message_changed`、删除 `message_deleted`、入群等）忽略，只有 `file_share`（取说明文字，附件忽略）与
 *   `thread_broadcast` 按普通文本处理；带 `bot_id`、发言人是机器人自己、没有 user、
 *   去掉 @ 后无文本的一律忽略。群聊里只转发话题回复（`thread_ts` ≠ `ts`）且未 @ 机器人的；@ 机器人的由
 *   `app_mention` 负责（两者消息 id 相同，内核也会去重），频道里未 @ 的顶层消息直接忽略。
 * - `app_mention`：群聊消息，`mentionsBot` 为真；带 `edited`（编辑后补发）的忽略。
 * - `team_join` / `user_change` → `directory_changed`（租户为负载的 `team_id`）。
 * 消息 id = `<频道>:<ts>`；群聊话题回复的 `threadId` = `<频道>:<thread_ts>`（话题根消息的 id），顶层消息不带。
 * 发言人租户依次取 `user_team`（共享频道里的外部成员）、`team`、负载的 `team_id`。文本去掉 @ 机器人并反转义
 * `&amp;` / `&lt;` / `&gt;`。
 */
export function eventToInbound(body: unknown, botUserId: string): InboundCandidate | null {
  const b = obj(body);
  const e = obj(b?.event);
  if (!b || !e) return null;
  const teamId = str(b.team_id);
  const type = e.type;

  if (type === "team_join" || type === "user_change") {
    if (!teamId) return null;
    return { kind: "directory", event: { type: "directory_changed", tenantId: teamId } };
  }
  if (type !== "message" && type !== "app_mention") return null;
  if (e.subtype !== undefined && !(typeof e.subtype === "string" && TEXT_SUBTYPES[e.subtype])) {
    return null;
  }
  if (e.bot_id !== undefined || e.bot_profile !== undefined) return null;
  if (type === "app_mention" && e.edited !== undefined) return null;
  const user = str(e.user);
  const channel = str(e.channel);
  const ts = str(e.ts);
  const raw = typeof e.text === "string" ? e.text : "";
  if (!user || !channel || !ts || user === botUserId) return null;
  const tenantId = str(e.user_team) ?? str(e.team) ?? teamId;
  if (!tenantId) return null;

  const mentioned = type === "app_mention" || mentions(raw, botUserId);
  const threadTs = str(e.thread_ts);
  const inThread = threadTs !== undefined && threadTs !== ts;
  const dm = type === "message" ? e.channel_type === "im" : channel.startsWith("D");
  if (!dm && type === "message" && (mentioned || !inThread)) return null;

  const text = unescapeSlack(stripBotMention(raw, botUserId));
  if (text === "") return null;
  const target: ChannelTarget = dm
    ? { chatId: channel, chatType: "dm" }
    : {
        chatId: channel,
        chatType: "group",
        ...(inThread && { threadId: `${channel}:${threadTs}` }),
      };
  return {
    kind: "message",
    userId: user,
    profile: profileOf(e.user_profile),
    event: {
      type: "message",
      messageId: `${channel}:${ts}`,
      target,
      sender: { externalId: user, tenantId },
      text,
      mentionsBot: !dm && mentioned,
    },
  };
}
