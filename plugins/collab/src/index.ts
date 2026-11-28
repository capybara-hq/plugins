import { defineExtension, TRIGGER_SOURCE_EXTENSION_POINT } from "@capybara-hq/plugin-sdk";
import {
  AGENT_ITEMS,
  EVENT_TYPES,
  ITEM_PANEL,
  ITEM_PROPERTIES,
  PROJECTS,
  TOOL_KEYS,
} from "./constants.js";
import { registerDecisionQueue } from "./decisions-queue.js";
// Registers the inbox.answer UI action (before registerUiActions runs).
import "./decisions/actions.js";
import { registerDrainQueue } from "./events/emitter.js";
import { registerLifecycle } from "./lifecycle.js";
// Registers the inbox.stop-agent UI action (before registerUiActions runs).
import "./notify.js";
// Registers the page actions (before registerUiActions runs).
import "./page/actions.js";
import { createTriggerSource } from "./events/source.js";
import { registerQueries } from "./page/queries.js";
import { collabDb } from "./store/db.js";
import { registerTools } from "./tools/index.js";
import { registerUiActions } from "./ui/actions.js";

/**
 * A project tracker for people and agents: projects, items (requirement, task, bug) with
 * workflows and gates, assignment to a person and an agent, decisions and artifacts. It emits
 * events automations react to (`trigger-source@1`), posts inbox items and serves its own pages.
 */
export default defineExtension({
  name: "collab",
  version: "0.1.0-rc.3",
  sdk: "^0.1.0-rc.89",
  provides: [TRIGGER_SOURCE_EXTENSION_POINT],
  ui: [
    {
      id: PROJECTS,
      title: { zh: "项目", en: "Projects" },
      slot: "org.page",
      kind: "component",
      frame: "page",
      nav: "primary",
      icon: "layout-grid",
    },
    {
      id: ITEM_PANEL,
      title: { zh: "事项", en: "Item" },
      slot: "conversation.panel",
      kind: "component",
    },
    {
      id: ITEM_PROPERTIES,
      title: { zh: "事项属性", en: "Item properties" },
      slot: "conversation.properties.section",
      kind: "component",
    },
    {
      id: AGENT_ITEMS,
      title: { zh: "事项", en: "Items" },
      slot: "agent.detail.section",
      kind: "component",
    },
  ],
  permissions: {
    tools: [...TOOL_KEYS],
    triggers: { emit: [...EVENT_TYPES] },
    inbox: true,
    agents: { read: true },
    conversations: { subjects: true },
    people: { read: true },
    hooks: ["run.lifecycle"],
    client: true,
    ui: { components: [PROJECTS, ITEM_PANEL, ITEM_PROPERTIES, AGENT_ITEMS] },
  },
  migrations: "../migrations",
  setup(ctx) {
    registerTools(ctx);
    registerDrainQueue(ctx);
    registerDecisionQueue(ctx);
    registerUiActions(ctx);
    registerQueries(ctx);
    registerLifecycle(ctx);
    ctx.provide(TRIGGER_SOURCE_EXTENSION_POINT, createTriggerSource(collabDb(ctx.db)));
  },
});
