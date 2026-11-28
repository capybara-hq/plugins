/** The `org.page` component of the project pages. */
export const PROJECTS = "projects";
/** The `conversation.panel` component showing the item a conversation serves. */
export const ITEM_PANEL = "item-panel";
/** The `conversation.properties.section` component with the item's properties. */
export const ITEM_PROPERTIES = "item-properties";
/** The `agent.detail.section` component listing an agent's items. */
export const AGENT_ITEMS = "agent-items";

/** The tool keys (`plugin__collab__<key>`). */
// capybara:allow-module-state read-only constant
export const TOOL_KEYS = [
  "project_list",
  "project_create",
  "item_search",
  "item_get",
  "item_create",
  "item_update",
  "item_transition",
  "item_assign",
  "item_comment",
  "watch_item",
  "item_link",
  "artifact_attach",
  "decision_ask",
  "decision_list",
] as const;

/** The event types the plugin emits through `ctx.triggers`. */
// capybara:allow-module-state read-only constant
export const EVENT_TYPES = [
  "item.created",
  "item.updated",
  "item.status_changed",
  "item.assigned",
  "item.unassigned",
  "item.commented",
  "item.closed",
  "decision.answered",
  "gate.requested",
] as const;
