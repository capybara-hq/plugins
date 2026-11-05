import {
  defineExtension,
  WEB_FETCH_EXTENSION_POINT,
  WEB_SEARCH_EXTENSION_POINT,
} from "@capybara-hq/plugin-sdk";
import { JinaDeployment, JinaOrgConfig } from "./config.js";

export { JinaDeployment, JinaOrgConfig } from "./config.js";

/** Jina web provider: `web-search@1` through `s.jina.ai` and `web-fetch@1` through `r.jina.ai`. */
export default defineExtension({
  name: "jina",
  version: "0.1.0-rc.0",
  sdk: "^0.1.0-rc.2",
  provides: [WEB_SEARCH_EXTENSION_POINT, WEB_FETCH_EXTENSION_POINT],
  permissions: { network: ["s.jina.ai", "r.jina.ai"] },
  config: { deployment: JinaDeployment, org: JinaOrgConfig },
  setup(ctx) {
    JinaDeployment.parse(ctx.config ?? {});
  },
});
