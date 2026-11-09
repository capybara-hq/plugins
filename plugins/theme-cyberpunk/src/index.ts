import { defineExtension, type UiRenderArgs } from "@capybara-hq/plugin-sdk";
import type { HudData } from "./shared.js";

/**
 * The data of the run HUD: what the kernel knows when it renders the view (the viewer's role in
 * the org and the render time). The live run state, tool and approval counts come from the page
 * itself (`useRunState`, client events), so the server stays this small.
 */
export function hudData(args: UiRenderArgs, now: Date = new Date()): HudData {
  return {
    operator: "role" in args ? args.role : "superAdmin",
    uplink: now.toISOString(),
  };
}

/**
 * The cyberpunk theme's client side (UI customization L1-L3): a run-state HUD in the
 * conversation properties panel, scanlines and a boot screen over the workspace, a glitch
 * wordmark for the sidebar brand and a hero for the new conversation. The browser code is
 * `src/client.tsx`, the decoration `client/styles/cyberpunk.css`; both scope themselves to the
 * theme `theme-cyberpunk/cyberpunk`.
 */
export default defineExtension({
  name: "theme-cyberpunk",
  version: "0.1.0-rc.1",
  sdk: "^0.1.0-rc.11",
  provides: [],
  ui: [
    {
      id: "run-hud",
      title: { zh: "运行 HUD", en: "Run HUD" },
      slot: "conversation.properties.section",
      after: "context",
      kind: "component",
      icon: "chart",
    },
    {
      id: "scanlines",
      title: { zh: "扫描线", en: "Scanlines" },
      slot: "shell.overlay",
      kind: "component",
    },
    {
      id: "boot",
      title: { zh: "启动画面", en: "Boot screen" },
      slot: "shell.overlay",
      kind: "component",
    },
    {
      id: "brand",
      title: { zh: "故障风字标", en: "Glitch wordmark" },
      slot: "shell.brand",
      kind: "component",
    },
    {
      id: "hero",
      title: { zh: "赛博朋克欢迎区", en: "Cyberpunk hero" },
      slot: "conversation.empty",
      kind: "component",
    },
  ],
  permissions: {
    client: true,
    ui: { components: ["run-hud", "scanlines", "boot", "brand", "hero"] },
  },
  setup(ctx) {
    ctx.ui.view("run-hud", async (args) => ({ blocks: [], data: { ...hudData(args) } }));
  },
});
