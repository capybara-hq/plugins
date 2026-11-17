import { CONNECTOR_EXTENSION_POINT, defineExtension } from "@capybara-hq/plugin-sdk";
import { createOpenApiConnector } from "./connector.js";

/**
 * OpenAPI connector: connects an HTTP API described by OpenAPI 3.0 / 3.1 as a connector, one tool
 * per operation. The document is read per use (specText, or specUrl fetched without credentials)
 * and never cached in process; the kernel injects auth before every request. Every request goes
 * through `ctx.net.fetch` with the org it serves, so the kernel's network rules decide which hosts
 * are reachable. No deployment config.
 */
export default defineExtension({
  name: "connector-openapi",
  version: "0.1.0-rc.11",
  sdk: "^0.1.0-rc.29",
  provides: [CONNECTOR_EXTENSION_POINT],
  setup(ctx) {
    ctx.provide(
      CONNECTOR_EXTENSION_POINT,
      createOpenApiConnector({
        log: ctx.log,
        fetch: (url, init, opts) => ctx.net.fetch(url, init, opts),
      }),
    );
  },
});
