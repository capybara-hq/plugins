import { CONNECTOR_EXTENSION_POINT, defineExtension } from "@capybara-hq/plugin-sdk";
import { createMcpConnector } from "./session.js";

/**
 * MCP connector: connects a remote MCP server (Streamable HTTP) as a connector. The kernel
 * snapshots the tool list into `connector_tools`; every call opens a session and closes it after
 * use; the kernel injects auth before every request (static credentials or OAuth). Every request
 * goes through `ctx.net.fetch` with the session's org, so the kernel's network rules decide which
 * endpoints are reachable. No deployment config, no in-process state.
 */
export default defineExtension({
  name: "connector-mcp",
  version: "0.1.0-rc.11",
  sdk: "^0.1.0-rc.29",
  provides: [CONNECTOR_EXTENSION_POINT],
  setup(ctx) {
    ctx.provide(
      CONNECTOR_EXTENSION_POINT,
      createMcpConnector({
        log: ctx.log,
        fetch: (url, init, opts) => ctx.net.fetch(url, init, opts),
      }),
    );
  },
});
