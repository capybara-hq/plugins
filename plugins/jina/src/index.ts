import {
  defineExtension,
  WEB_FETCH_EXTENSION_POINT,
  WEB_SEARCH_EXTENSION_POINT,
} from "@capybara-hq/plugin-sdk";
import { JinaDeployment, JinaOrgConfig } from "./config.js";
import { createJinaReader } from "./reader.js";
import { createJinaSearch } from "./search.js";

export { JinaDeployment, JinaOrgConfig } from "./config.js";

/** Jina web provider: `web-search@1` through `s.jina.ai` and `web-fetch@1` through `r.jina.ai`. */
export default defineExtension({
  name: "jina",
  version: "0.1.0-rc.6",
  sdk: "^0.1.0-rc.2",
  provides: [WEB_SEARCH_EXTENSION_POINT, WEB_FETCH_EXTENSION_POINT],
  permissions: { network: ["s.jina.ai", "r.jina.ai"] },
  config: { deployment: JinaDeployment, org: JinaOrgConfig },
  setup(ctx) {
    const { searchUrl, readerUrl } = JinaDeployment.parse(ctx.config ?? {});
    ctx.provide(WEB_SEARCH_EXTENSION_POINT, createJinaSearch({ searchUrl }));
    ctx.provide(WEB_FETCH_EXTENSION_POINT, createJinaReader({ readerUrl }));
  },
});
