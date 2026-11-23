import {
  defineExtension,
  WEB_FETCH_EXTENSION_POINT,
  WEB_SEARCH_EXTENSION_POINT,
} from "@capybara-hq/plugin-sdk";
import { JinaDeployment } from "./config.js";
import { createJinaReader } from "./reader.js";
import { createJinaSearch } from "./search.js";

export { JinaDeployment } from "./config.js";

/** Jina web provider: `web-search@1` through `s.jina.ai` and `web-fetch@1` through `r.jina.ai`. */
export default defineExtension({
  name: "jina",
  version: "0.1.0-rc.9",
  sdk: "^0.1.0-rc.2",
  provides: [WEB_SEARCH_EXTENSION_POINT, WEB_FETCH_EXTENSION_POINT],
  permissions: { network: ["s.jina.ai", "r.jina.ai"] },
  config: { deployment: JinaDeployment },
  setup(ctx) {
    // `ctx.config` is the platform's value; the per-call `config` is the org's effective one.
    const env = { net: ctx.net, platform: () => ctx.config };
    ctx.provide(WEB_SEARCH_EXTENSION_POINT, createJinaSearch(env));
    ctx.provide(WEB_FETCH_EXTENSION_POINT, createJinaReader(env));
  },
});
