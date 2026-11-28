import type { TriggerEventDeclaration, TriggerFactDeclaration } from "@capybara-hq/plugin-sdk";
import { EVENT_TYPES } from "../constants.js";

type EventType = (typeof EVENT_TYPES)[number];

/** The facts every collab event carries (outbox.ts writes them); automations filter on all. */
// capybara:allow-module-state read-only constant
const FACTS: Record<string, TriggerFactDeclaration> = {
  projectKey: { type: "string", name: { zh: "项目标识", en: "Project key" }, filterable: true },
  itemType: { type: "string", name: { zh: "事项类型", en: "Item type" }, filterable: true },
  status: { type: "string", name: { zh: "状态", en: "Status" }, filterable: true },
  statusCategory: {
    type: "string",
    name: { zh: "状态类别", en: "Status category" },
    filterable: true,
  },
  priority: { type: "number", name: { zh: "优先级", en: "Priority" }, filterable: true },
  labels: { type: "string[]", name: { zh: "标签", en: "Labels" }, filterable: true },
  responsibleAccountId: {
    type: "string",
    name: { zh: "负责人", en: "Responsible person" },
    filterable: true,
  },
  executingAgentId: {
    type: "string",
    name: { zh: "执行智能体", en: "Executing agent" },
    filterable: true,
  },
  changedFields: {
    type: "string[]",
    name: { zh: "变更字段", en: "Changed fields" },
    filterable: true,
  },
};

/** Names and whether an event wakes one agent (directed: assignment, answers to its question). */
// capybara:allow-module-state read-only constant
const TYPES: Record<EventType, { zh: string; en: string; directed: boolean }> = {
  "item.created": { zh: "事项已创建", en: "Item created", directed: false },
  "item.updated": { zh: "事项已更新", en: "Item updated", directed: false },
  "item.status_changed": { zh: "事项状态已变更", en: "Item status changed", directed: false },
  "item.assigned": { zh: "事项已指派", en: "Item assigned", directed: true },
  "item.unassigned": { zh: "事项已取消指派", en: "Item unassigned", directed: true },
  "item.commented": { zh: "事项有新评论", en: "Item commented", directed: false },
  "item.closed": { zh: "事项已关闭", en: "Item closed", directed: false },
  "decision.answered": { zh: "决策已答复", en: "Decision answered", directed: true },
  "gate.requested": { zh: "已请求确认", en: "Confirmation requested", directed: false },
};

/** The event types of the `trigger-source@1` provider, in `EVENT_TYPES` order. */
// capybara:allow-module-state read-only constant
export const EVENT_DECLARATIONS: TriggerEventDeclaration[] = EVENT_TYPES.map((type) => {
  const t = TYPES[type];
  return { type, name: { zh: t.zh, en: t.en }, directed: t.directed, facts: FACTS };
});
