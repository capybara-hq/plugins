import type { CardAction, ChannelTarget } from "@capybara-hq/plugin-sdk";

/**
 * 卡片按钮的 `value` 编码：紧凑的 JSON 数组，首元素为种类——
 * - `["a", 卡片 id, "approve", 范围]` / `["a", 卡片 id, "deny"]`：审批；
 * - `["q", 卡片 id, 字段 key, 选项值]`：单选提问（一项一个按钮）；
 * - `["m", 卡片 id, 字段 key, [选项值…]]`：多选提问的「提交」按钮；勾选框的选项值是下标（"0"…），
 *   提交时从 `state.values[cap_m_<卡片 id>].cap_m_select` 读出勾选的下标再映射回选项值。
 * 选项值放进按钮本身，插件不必记住发出的表单（无状态，任一副本都能解析）。Slack 限制 `value` ≤ 2000 字符
 * （https://docs.slack.dev/reference/block-kit/block-elements/button-element ，2026-10-20 查阅），
 * 超出时 {@link encodeActionValue} 抛错，渲染方改为只给网页链接。
 */
export type ActionValue =
  | { k: "a"; id: string; action: "approve"; scope: "once" | "session" | "always" }
  | { k: "a"; id: string; action: "deny" }
  | { k: "q"; id: string; key: string; value: string }
  | { k: "m"; id: string; key: string; options: string[] };

/** Slack 按钮 `value` 的长度上限。 */
export const ACTION_VALUE_MAX = 2000;

/** 本插件的 action_id 前缀；其余 action_id（别的应用、手工改过的消息）一律忽略。 */
export const ACTION_PREFIX = "cap_";
export const MULTI_SELECT_ACTION = "cap_m_select";
export const MULTI_SUBMIT_ACTION = "cap_m_submit";
export const multiBlockId = (cardId: string) => `cap_m_${cardId}`;

const SCOPES: Record<string, true> = { once: true, session: true, always: true };

export function encodeActionValue(v: ActionValue): string {
  let arr: unknown[];
  switch (v.k) {
    case "a":
      arr = v.action === "approve" ? ["a", v.id, "approve", v.scope] : ["a", v.id, "deny"];
      break;
    case "q":
      arr = ["q", v.id, v.key, v.value];
      break;
    case "m":
      arr = ["m", v.id, v.key, v.options];
      break;
  }
  const s = JSON.stringify(arr);
  if (s.length > ACTION_VALUE_MAX) {
    throw new Error(`button value exceeds Slack's ${ACTION_VALUE_MAX}-character limit`);
  }
  return s;
}

const nonEmpty = (x: unknown): x is string => typeof x === "string" && x !== "";

/** 解析按钮 `value`；格式不对返回 null。 */
export function decodeActionValue(s: string): ActionValue | null {
  if (typeof s !== "string" || s.length === 0 || s.length > ACTION_VALUE_MAX) return null;
  let a: unknown;
  try {
    a = JSON.parse(s);
  } catch {
    return null;
  }
  if (!Array.isArray(a) || !nonEmpty(a[1])) return null;
  const [k, id] = a as [unknown, string];
  if (k === "a") {
    if (a[2] === "approve" && a.length === 4 && typeof a[3] === "string" && SCOPES[a[3]]) {
      return { k, id, action: "approve", scope: a[3] as "once" | "session" | "always" };
    }
    if (a[2] === "deny" && a.length === 3) return { k, id, action: "deny" };
    return null;
  }
  if (k === "q" && a.length === 4 && nonEmpty(a[2]) && typeof a[3] === "string") {
    return { k, id, key: a[2], value: a[3] };
  }
  if (
    k === "m" &&
    a.length === 4 &&
    nonEmpty(a[2]) &&
    Array.isArray(a[3]) &&
    a[3].every((x) => typeof x === "string")
  ) {
    return { k, id, key: a[2], options: a[3] as string[] };
  }
  return null;
}

/** 解析出的按钮点击（发言人资料由调用方补）。 */
export interface ParsedBlockAction {
  messageId: string;
  eventId: string;
  target: ChannelTarget;
  sender: { externalId: string; tenantId: string };
  /** Slack 用户名（拿不到资料时的显示名退路）。 */
  username?: string;
  action: CardAction;
}

const obj = (v: unknown): Record<string, unknown> | undefined =>
  typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
const str = (v: unknown) => (typeof v === "string" && v !== "" ? v : undefined);

/** 勾选的下标 → 选项值；下标非法返回 null。 */
function checked(
  payload: Record<string, unknown>,
  cardId: string,
  options: string[],
): string[] | null {
  const block = obj(obj(obj(payload.state)?.values)?.[multiBlockId(cardId)]);
  const sel = obj(block?.[MULTI_SELECT_ACTION])?.selected_options;
  if (sel === undefined || sel === null) return [];
  if (!Array.isArray(sel)) return null;
  const out: string[] = [];
  for (const o of sel) {
    const v = str(obj(o)?.value);
    if (v === undefined || !/^\d+$/.test(v)) return null;
    const opt = options[Number(v)];
    if (opt === undefined) return null;
    if (!out.includes(opt)) out.push(opt);
  }
  return out;
}

/**
 * `block_actions` 交互负载 → 卡片操作。只认本插件的按钮（`cap_` 前缀且带合法 value）；链接按钮、勾选框的
 * 单独点选、别的应用的按钮、格式不对的负载返回 null（调用方照样确认，不交给内核）。
 * - `messageId` = `<频道>:<卡片消息 ts>`，与发送时返回的消息 id 相同；
 * - `eventId` = `<频道>:<卡片消息 ts>:<点击者>:<action_ts>`：Slack 未确认时重投的是同一负载，故稳定；不同人 /
 *   同一人的不同点击 action_ts 不同（微秒精度）；
 * - 群聊卡片在话题里时 `threadId` = `<频道>:<thread_ts>`（话题根消息 id），拿不到就不带（内核回落）。
 */
export function parseBlockActions(payload: unknown): ParsedBlockAction | null {
  const p = obj(payload);
  if (p?.type !== "block_actions") return null;
  const act = obj(Array.isArray(p.actions) ? p.actions[0] : undefined);
  const actionId = str(act?.action_id);
  if (!act || !actionId?.startsWith(ACTION_PREFIX) || act.type !== "button") return null;
  const value = str(act.value);
  if (value === undefined) return null;
  const v = decodeActionValue(value);
  if (!v) return null;

  const container = obj(p.container);
  const message = obj(p.message);
  const channel = str(container?.channel_id) ?? str(obj(p.channel)?.id);
  const messageTs = str(container?.message_ts) ?? str(message?.ts);
  const user = obj(p.user);
  const userId = str(user?.id);
  const tenantId = str(user?.team_id) ?? str(obj(p.team)?.id);
  const actionTs = str(act.action_ts);
  if (!channel || !messageTs || !userId || !tenantId || !actionTs) return null;

  let action: CardAction;
  if (v.k === "a") {
    action =
      v.action === "approve"
        ? { cardKind: "approval", cardId: v.id, action: "approve", scope: v.scope }
        : { cardKind: "approval", cardId: v.id, action: "deny" };
  } else if (v.k === "q") {
    action = { cardKind: "question", cardId: v.id, action: "answer", answer: { [v.key]: v.value } };
  } else {
    if (actionId !== MULTI_SUBMIT_ACTION) return null;
    const picked = checked(p, v.id, v.options);
    if (picked === null) return null;
    action = { cardKind: "question", cardId: v.id, action: "answer", answer: { [v.key]: picked } };
  }

  const dm = channel.startsWith("D");
  const threadTs = str(container?.thread_ts) ?? str(message?.thread_ts);
  const target: ChannelTarget = dm
    ? { chatId: channel, chatType: "dm" }
    : {
        chatId: channel,
        chatType: "group",
        ...(threadTs !== undefined &&
          threadTs !== messageTs && { threadId: `${channel}:${threadTs}` }),
      };
  const username = str(user?.username) ?? str(user?.name);
  return {
    messageId: `${channel}:${messageTs}`,
    eventId: `${channel}:${messageTs}:${userId}:${actionTs}`,
    target,
    sender: { externalId: userId, tenantId },
    ...(username !== undefined && { username }),
    action,
  };
}
