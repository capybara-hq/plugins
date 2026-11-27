import { defineExtension } from "@capybara-hq/plugin-sdk";
import { registerDialogTool } from "./dialog.js";
import { registerHandoffTool } from "./handoff.js";
import { registerRoutes } from "./routes.js";
import { panelScriptLoader, serviceSpecLoader } from "./service.js";
import { registerBrowserTools } from "./tools.js";

/**
 * A real browser in the conversation's device (browser use spec): a daemon service that drives a
 * headless Chromium, agent tools that send it one request each, and a live panel the person can
 * take over. Everything reaches the device through `ctx.deviceAccess`; the extension keeps no
 * state and no timers (the daemon inside the device keeps its own).
 */
export default defineExtension({
  name: "browser",
  version: "0.1.0-rc.12",
  sdk: "^0.1.0-rc.83",
  provides: [],
  ui: [
    {
      id: "browser",
      title: { zh: "浏览器", en: "Browser" },
      slot: "conversation.panel",
      kind: "embed",
      path: "/ui/browser",
      icon: "globe",
    },
  ],
  permissions: {
    tools: [
      "browser_navigate",
      "browser_tabs",
      "browser_snapshot",
      "browser_screenshot",
      "browser_click",
      "browser_type",
      "browser_select",
      "browser_press",
      "browser_scroll",
      "browser_hover",
      "browser_upload",
      "browser_click_at",
      "browser_type_at",
      "browser_wait",
      "browser_handoff",
      "browser_dialog",
    ],
    http: [
      { method: "GET", path: "/ui/browser", access: "public" },
      { method: "GET", path: "/ui/panel.js", access: "public" },
      { method: "POST", path: "/ui/stream-ticket", access: "embed" },
      { method: "POST", path: "/ui/network-hosts", access: "embed" },
      { method: "POST", path: "/ui/handoff-answer", access: "embed" },
    ],
    ui: { embeds: ["browser"] },
    deviceAccess: { services: ["browser"] },
  },
  setup(ctx) {
    // arrow wrappers: never depend on how the kernel binds ctx.deviceAccess's methods
    const deviceAccess = {
      ensureService: (...a: Parameters<typeof ctx.deviceAccess.ensureService>) =>
        ctx.deviceAccess.ensureService(...a),
      request: (...a: Parameters<typeof ctx.deviceAccess.request>) =>
        ctx.deviceAccess.request(...a),
      reportBlockedHosts: (...a: Parameters<typeof ctx.deviceAccess.reportBlockedHosts>) =>
        ctx.deviceAccess.reportBlockedHosts(...a),
      streamTicket: (...a: Parameters<typeof ctx.deviceAccess.streamTicket>) =>
        ctx.deviceAccess.streamTicket(...a),
      addNetworkHosts: (...a: Parameters<typeof ctx.deviceAccess.addNetworkHosts>) =>
        ctx.deviceAccess.addNetworkHosts(...a),
      answerHandoff: (...a: Parameters<typeof ctx.deviceAccess.answerHandoff>) =>
        ctx.deviceAccess.answerHandoff(...a),
    };
    const deps = { deviceAccess, serviceSpec: serviceSpecLoader(), log: ctx.log };
    registerBrowserTools(ctx, deps);
    registerHandoffTool(ctx, deps);
    registerDialogTool(ctx, deps);
    registerRoutes(ctx, { deviceAccess, panelScript: panelScriptLoader() });
  },
});
