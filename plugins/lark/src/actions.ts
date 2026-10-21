import type { CardAction, ChannelTarget } from "@capybara-hq/plugin-sdk";

/**
 * 卡片按钮的回传值。按钮 `behaviors: [{ type: "callback", value: { cap: "<编码>" } }]`：Lark 回调把 `value`
 * 原样放在 `event.action.value` 里（https://open.larksuite.com/document/uAjLw4CM/ukzMukzMukzM/feishu-cards/card-json-v2-components/interactive-components/button ，
 * 2026-10-20 查阅；开放平台 SDK 只支持 object 型的回传值，所以外面包一层 `{ cap }`）。编码为紧凑的 JSON 数组：
 * - `["a", 会话类型, 卡片 id, "approve", 范围]` / `["a", 会话类型, 卡片 id, "deny"]`：审批；
 * - `["q", 会话类型, 卡片 id, 字段 key, 选项值]`：单选提问（一项一个按钮）；
 * - `["m", 会话类型, 卡片 id, 字段 key, [选项值…]]`：多选提问的「提交」按钮；多选下拉的选项值是下标（"0"…），
 *   提交时从 `form_value[cap_m_select]` 读出勾选的下标再映射回选项值。
 *
 * 会话类型 `d`（私聊）/ `g`（群聊）：卡片回调只带 `open_chat_id` 与 `open_message_id`，不带会话类型（私聊与群聊的
 * chat id 都是 `oc_…`）。把发送时的会话类型放进值里，作为给内核的**参考值**：用户无法凭空构造回传值，但卡片
 * 可以被转发到别的会话，值会随之被重放（卡片已设 `enable_forward_interaction: false`，转发后的卡片默认不可交互，
 * 仍不当作保证）。所以内核以发出该卡片时记下的目标（会话类型、chat、话题）为准，并在 chat 不符时拒绝处理，
 * 不依赖这里的值；它只免去在 3 秒的回调窗口内再查一次会话。
 * 选项值也放进按钮本身，插件无状态（任一副本都能解析）。Lark 没有写明 value 的上限，这里取 2000 字符，
 * 超出时 {@link encodeActionValue} 抛错，渲染方改为只给网页链接。
 */
export type ChatKind = "d" | "g";
export type ActionValue =
  | { k: "a"; chat: ChatKind; id: string; action: "approve"; scope: "once" | "session" | "always" }
  | { k: "a"; chat: ChatKind; id: string; action: "deny" }
  | { k: "q"; chat: ChatKind; id: string; key: string; value: string }
  | { k: "m"; chat: ChatKind; id: string; key: string; options: string[] };

export const ACTION_VALUE_MAX = 2000;
/** 回传值对象里放编码的键。 */
export const VALUE_KEY = "cap";
/** 多选提问的表单、下拉与提交按钮的 name（同一张卡片内唯一）。 */
export const FORM_NAME = "cap_form";
export const MULTI_FIELD = "cap_m_select";
export const SUBMIT_NAME = "cap_m_submit";

const SCOPES: Record<string, true> = { once: true, session: true, always: true };
const CHATS: Record<string, true> = { d: true, g: true };

export function encodeActionValue(v: ActionValue): string {
  let arr: unknown[];
  switch (v.k) {
    case "a":
      arr =
        v.action === "approve"
          ? ["a", v.chat, v.id, "approve", v.scope]
          : ["a", v.chat, v.id, "deny"];
      break;
    case "q":
      arr = ["q", v.chat, v.id, v.key, v.value];
      break;
    case "m":
      arr = ["m", v.chat, v.id, v.key, v.options];
      break;
  }
  const s = JSON.stringify(arr);
  if (s.length > ACTION_VALUE_MAX) {
    throw new Error(`button value exceeds the ${ACTION_VALUE_MAX}-character limit`);
  }
  return s;
}

const nonEmpty = (x: unknown): x is string => typeof x === "string" && x !== "";

/** 解析编码；格式不对返回 null。 */
export function decodeActionValue(s: string): ActionValue | null {
  if (typeof s !== "string" || s.length === 0 || s.length > ACTION_VALUE_MAX) return null;
  let a: unknown;
  try {
    a = JSON.parse(s);
  } catch {
    return null;
  }
  if (!Array.isArray(a) || typeof a[1] !== "string" || !CHATS[a[1]] || !nonEmpty(a[2])) return null;
  const [k, chat, id] = a as [unknown, ChatKind, string];
  if (k === "a") {
    if (a[3] === "approve" && a.length === 5 && typeof a[4] === "string" && SCOPES[a[4]]) {
      return { k, chat, id, action: "approve", scope: a[4] as "once" | "session" | "always" };
    }
    if (a[3] === "deny" && a.length === 4) return { k, chat, id, action: "deny" };
    return null;
  }
  if (k === "q" && a.length === 5 && nonEmpty(a[3]) && typeof a[4] === "string") {
    return { k, chat, id, key: a[3], value: a[4] };
  }
  if (
    k === "m" &&
    a.length === 5 &&
    nonEmpty(a[3]) &&
    Array.isArray(a[4]) &&
    a[4].every((x) => typeof x === "string")
  ) {
    return { k, chat, id, key: a[3], options: a[4] as string[] };
  }
  return null;
}

/** 解析出的卡片点击（点击者资料由调用方补）。 */
export interface ParsedCardAction {
  messageId: string;
  eventId?: string;
  target: ChannelTarget;
  sender: { externalId: string; tenantId: string };
  action: CardAction;
}

const obj = (v: unknown): Record<string, unknown> | undefined =>
  typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
const str = (v: unknown) => (typeof v === "string" && v !== "" ? v : undefined);

/** 勾选的下标 → 选项值（去重、保持勾选顺序）；下标非法返回 null。 */
function picked(formValue: unknown, options: string[]): string[] | null {
  const sel = obj(formValue)?.[MULTI_FIELD];
  if (sel === undefined || sel === null) return [];
  if (!Array.isArray(sel)) return null;
  const out: string[] = [];
  for (const v of sel) {
    if (typeof v !== "string" || !/^\d+$/.test(v)) return null;
    const opt = options[Number(v)];
    if (opt === undefined) return null;
    if (!out.includes(opt)) out.push(opt);
  }
  return out;
}

/**
 * 卡片回传交互回调 `card.action.trigger`（schema 2.0，经长连接到达）→ 卡片操作。回调结构见
 * https://open.larksuite.com/document/uAjLw4CM/ukzMukzMukzM/feishu-cards/card-callback-communication （2026-10-20 查阅）。
 * 只认本插件的按钮（`value.cap` 为合法编码）；别的组件、格式不对的回调返回 null（调用方照样应答，不交给内核）。
 * - `messageId` = `context.open_message_id`（卡片所在消息，与发送时返回的 id 相同）；
 * - `eventId` = `header.event_id`（文档：「回调的唯一标识」；平台重投同一次点击时不变，不同点击不同）。没有选
 *   `event.token`：它是更新卡片用的凭证（30 分钟内最多用 2 次），语义上不是事件 id；
 * - `target.chatId` = `context.open_chat_id`，会话类型取自按钮值（参考值，内核以记下的卡片目标为准）；不带 `threadId`（回调里没有，内核回落到发卡片时
 *   记下的话题）；
 * - 点击者 = `operator.open_id`，租户 = `operator.tenant_key`（缺省时取 `header.tenant_key`）。
 */
export function parseCardAction(payload: unknown): ParsedCardAction | null {
  const p = obj(payload);
  const header = obj(p?.header);
  const event = obj(p?.event);
  if (!p || !header || !event || header.event_type !== "card.action.trigger") return null;
  const act = obj(event.action);
  const raw = obj(act?.value)?.[VALUE_KEY];
  if (typeof raw !== "string") return null;
  const v = decodeActionValue(raw);
  if (!v) return null;
  const context = obj(event.context);
  const operator = obj(event.operator);
  const messageId = str(context?.open_message_id);
  const chatId = str(context?.open_chat_id);
  const openId = str(operator?.open_id);
  const tenantId = str(operator?.tenant_key) ?? str(header.tenant_key);
  if (!messageId || !chatId || !openId || !tenantId) return null;

  let action: CardAction;
  if (v.k === "a") {
    action =
      v.action === "approve"
        ? { cardKind: "approval", cardId: v.id, action: "approve", scope: v.scope }
        : { cardKind: "approval", cardId: v.id, action: "deny" };
  } else if (v.k === "q") {
    action = { cardKind: "question", cardId: v.id, action: "answer", answer: { [v.key]: v.value } };
  } else {
    const sel = picked(act?.form_value, v.options);
    if (sel === null) return null;
    action = { cardKind: "question", cardId: v.id, action: "answer", answer: { [v.key]: sel } };
  }
  const eventId = str(header.event_id);
  return {
    messageId,
    ...(eventId !== undefined && { eventId }),
    target: { chatId, chatType: v.chat === "d" ? "dm" : "group" },
    sender: { externalId: openId, tenantId },
    action,
  };
}
