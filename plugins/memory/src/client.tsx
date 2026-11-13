import { defineClientExtension, defineComponent } from "@capybara-hq/plugin-client";
import { MemoryPage } from "./client/page.js";

/**
 * The browser side of the memory plugin: the memory page (`org.page` component "overview"),
 * the directory neural tree of one agent's memories about one member. The server half (view and
 * actions) is `page.ts`.
 */
export default defineClientExtension({
  name: "memory",
  components: { "overview": defineComponent("org.page", MemoryPage) },
});
