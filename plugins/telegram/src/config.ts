import { secret, ui } from "@capybara-hq/plugin-sdk";
import { z } from "zod";

/** Deployment config. `apiUrl` is only rewritten for tests and reverse proxies. No org-level config. */
export const TelegramDeployment = z.object({
  apiUrl: ui(z.string().url().default("https://api.telegram.org"), {
    label: { zh: "API 地址", en: "API URL" },
  }),
});
export type TelegramDeploymentConfig = z.infer<typeof TelegramDeployment>;

/**
 * Channel connection config. `botToken` is BotFather's `<bot id>:<secret>`; `webhookSecret` is the
 * `secret_token` given to `setWebhook` (Telegram allows 1-256 characters of `A-Z a-z 0-9 _ -`),
 * required in webhook mode and unused by long polling. Both go to secret storage.
 */
export const TelegramConnection = z.object({
  botToken: ui(
    secret(
      z
        .string()
        .regex(/^\d+:[A-Za-z0-9_-]+$/, "must be a BotFather bot token such as 123456:ABC-DEF…"),
    ),
    {
      label: { zh: "机器人令牌", en: "Bot token" },
      help: {
        zh: "在 @BotFather 中创建机器人后获得，形如 123456:ABC-DEF…。",
        en: "From @BotFather when you create the bot, such as 123456:ABC-DEF….",
      },
      placeholder: "123456:ABC-DEF…",
    },
  ),
  webhookSecret: ui(
    secret(
      z
        .string()
        .regex(/^[A-Za-z0-9_-]{1,256}$/, "must be 1-256 characters of A-Z, a-z, 0-9, _ and -")
        .optional(),
    ),
    {
      label: { zh: "Webhook 密钥", en: "Webhook secret" },
      help: {
        zh: "仅 webhook 模式需要：调用 setWebhook 时作为 secret_token 传入的同一个值；长轮询留空。",
        en: "Only needed in webhook mode: the same value you pass as secret_token to setWebhook. Leave empty for long polling.",
      },
    },
  ),
});
export type TelegramConnectionConfig = z.infer<typeof TelegramConnection>;

/**
 * The bot id: the digits before `:` in the token. kv keys are scoped by it (send and update get no
 * connection id), so a token swap never reuses the old bot's records.
 */
export const botIdOf = (token: string): string => token.slice(0, token.indexOf(":"));

/**
 * Every inbound sender's tenant: Telegram user ids are global, so one person is one identity
 * (`telegram:global` + user id) across every bot of a deployment.
 */
export const SENDER_TENANT = "global";

/**
 * The tenant `verify` returns for a connection. It never equals {@link SENDER_TENANT}, so the kernel
 * treats every sender as external and no one can be an anonymous guest on Telegram.
 */
export const connectionTenant = (botId: string | number): string => `bot${botId}`;
