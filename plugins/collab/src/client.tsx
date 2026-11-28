import { defineClientExtension, defineComponent } from "@capybara-hq/plugin-client";

/** Placeholder for a component the UI task builds; renders nothing yet. */
function Placeholder(): null {
  return null;
}

/**
 * The browser side of the collab plugin: the project pages (`org.page` "projects"), the item panel
 * and properties of a conversation, and an agent's item list. Placeholders until the UI task.
 */
export default defineClientExtension({
  name: "collab",
  components: {
    projects: defineComponent("org.page", Placeholder),
    "item-panel": defineComponent("conversation.panel", Placeholder),
    "item-properties": defineComponent("conversation.properties.section", Placeholder),
    "agent-items": defineComponent("agent.detail.section", Placeholder),
  },
});
