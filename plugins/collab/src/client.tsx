import { defineClientExtension, defineComponent } from "@capybara-hq/plugin-client";
import { AgentItems } from "./client/agent-items.js";
import { ItemPanel, ItemProperties } from "./client/panel.js";
import { ProjectsPage } from "./client/router.js";

/**
 * The browser side of the collab plugin: the project pages (`org.page` "projects": projects,
 * board and list, item page, settings), the item panel and properties section of a collab
 * conversation, and the agent page's item list. The server half is `src/page/`.
 */
export default defineClientExtension({
  name: "collab",
  components: {
    projects: defineComponent("org.page", ProjectsPage),
    "item-panel": defineComponent("conversation.panel", ItemPanel),
    "item-properties": defineComponent("conversation.properties.section", ItemProperties),
    "agent-items": defineComponent("agent.detail.section", AgentItems),
  },
});
