import { CHANNEL_EXTENSION_POINT, defineExtension } from "@capybara-hq/plugin-sdk";
import { createTelegramChannel } from "./channel.js";
import { TelegramDeployment } from "./config.js";

export { createTelegramChannel, type TelegramChannelOptions } from "./channel.js";
export { TelegramConnection, TelegramDeployment } from "./config.js";

/**
 * Telegram plugin: a `channel@1` bot over the Bot API (long polling or webhook). The bot token comes
 * per channel connection from the kernel, so no `secrets` permission is needed;
 * `permissions.network` is informational.
 */
export default defineExtension({
  name: "telegram",
  version: "0.1.0-rc.4",
  sdk: "^0.1.0-rc.4",
  provides: [CHANNEL_EXTENSION_POINT],
  permissions: { network: ["api.telegram.org"] },
  config: { deployment: TelegramDeployment },
  setup(ctx) {
    const { apiUrl } = TelegramDeployment.parse(ctx.config ?? {});
    ctx.provide(
      CHANNEL_EXTENSION_POINT,
      createTelegramChannel({ apiUrl, log: ctx.log, kv: ctx.kv }),
    );
  },
});
